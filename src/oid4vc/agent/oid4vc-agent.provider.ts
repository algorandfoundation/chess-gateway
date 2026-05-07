import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Router } from 'express';

import { Agent, ConnectionsModule, DidsModule } from '@credo-ts/core';
import { agentDependencies } from '@credo-ts/node';
import { ariesAskar } from '@hyperledger/aries-askar-nodejs';
import {
  OpenId4VcIssuerModule,
  OpenId4VcVerifierModule,
  OpenId4VciCredentialRequestToCredentialMapper,
} from '@credo-ts/openid4vc';

import { Oid4vcConfig } from '../oid4vc.config';
import { DidService } from '../../did/did.service';
import { VaultService } from '../../vault/vault.service';
import { ConfigService } from '@nestjs/config';
import { AlgoDidRegistrar, AlgoDidCreateOptions } from '../algo/algo-did.registrar';
import { AlgoDidResolver } from '../algo/algo-did.resolver';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcAskarModule } from '../algo/oid4vc-askar.module';
import { vaultSigningRegistry, parseVaultSignature } from '../algo/vault-signing-registry';
import { CredoNestLogger, resolveCredoLogLevel } from './credo-nest-logger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Oid4vcVaultKeyBinding } from '../entities/oid4vc-vault-key-binding.entity';

/**
 * Type of the Credo agent we expose to the rest of the Nest app. Strongly typed
 * so that consumers can read `agent.modules.openId4VcIssuer` etc. without casts.
 */
export type Oid4vcAgent = Agent<{
  askar: Oid4vcAskarModule;
  dids: DidsModule;
  connections: ConnectionsModule;
  openId4VcIssuer: OpenId4VcIssuerModule;
  openId4VcVerifier: OpenId4VcVerifierModule;
}>;

/** Result of {@link Oid4vcAgentProvider.ensureIssuerDid}. */
export interface IssuerDid {
  did: string;
  verificationMethodId: string;
}

/**
 * Owns the lifecycle of the Credo agent that powers OID4VCI/OID4VP.
 *
 * Why a dedicated provider:
 * - Credo agents are heavyweight (Askar wallet, key store, DID resolvers); we
 *   want a single instance for the lifetime of the Nest app.
 * - The `OpenId4VcIssuerModule` and `OpenId4VcVerifierModule` need Express
 *   routers passed at construction time. Those routers are exposed here so
 *   `main.ts` can mount them on the global Nest Express adapter under their
 *   public base URLs.
 * - The credential mapper has to be installed at construction time, but the
 *   actual data lookup needs to call into our Nest services. We use a small
 *   indirection (`setCredentialMapper`) so the issuer service can register its
 *   mapper once it has been instantiated by Nest's DI.
 *
 * The agent registers a single DID method:
 *   - `did:algo` — the platform's on-chain method, served by
 *     {@link AlgoDidRegistrar} / {@link AlgoDidResolver}. Used for both the
 *     issuer DID and for resolving holder DIDs published by the manager when
 *     end users register. `did:algo` is the only supported method; the agent
 *     will refuse to start credential issuance if the OID4VC AppRole is not
 *     provisioned.
 */
@Injectable()
export class Oid4vcAgentProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Oid4vcAgentProvider.name);

  /** Router mounted on `${baseUrl}${issuerPath}` and handling the OID4VCI endpoints. */
  readonly issuerRouter: Router = Router();
  /** Router mounted on `${baseUrl}${verifierPath}` and handling the OID4VP endpoints. */
  readonly verifierRouter: Router = Router();

  private agentInstance: Oid4vcAgent | undefined;
  private initialisation: Promise<Oid4vcAgent> | undefined;
  private cachedIssuerDid: IssuerDid | undefined;

  /**
   * The credential mapper that the issuer service registers at startup. Stored
   * in a mutable holder so we can pass a stable reference into the Credo
   * configuration before the issuer service exists.
   */
  private credentialMapper: OpenId4VciCredentialRequestToCredentialMapper = async () => {
    throw new Error(
      'Oid4vcAgentProvider: credentialRequestToCredentialMapper has not been registered yet. ' +
        'The Oid4vcIssuerService is responsible for installing it during onModuleInit.',
    );
  };

  constructor(
    private readonly config: Oid4vcConfig,
    private readonly didService: DidService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
    private readonly vaultService: VaultService,
    private readonly configService: ConfigService,
    @InjectRepository(Oid4vcVaultKeyBinding)
    private readonly vaultKeyBindingRepo: Repository<Oid4vcVaultKeyBinding>,
  ) {}

  /**
   * Allows the issuer service to plug in its own mapper at startup. The
   * provider holds a stable closure that delegates to whatever mapper was last
   * registered, so this can be called safely after the agent has already been
   * built.
   */
  setCredentialMapper(mapper: OpenId4VciCredentialRequestToCredentialMapper): void {
    this.credentialMapper = mapper;
  }

  /**
   * Returns the (initialised) Credo agent. Initialises lazily so unit tests can
   * mock this provider without spinning up Askar.
   */
  async getAgent(): Promise<Oid4vcAgent> {
    if (this.agentInstance) return this.agentInstance;
    if (!this.initialisation) this.initialisation = this.initialiseAgent();
    return this.initialisation;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.autoInit) {
      this.logger.log('OID4VC_AUTO_INIT=false, skipping agent initialisation on bootstrap');
      return;
    }
    await this.getAgent();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.agentInstance) {
      try {
        await this.agentInstance.shutdown();
      } catch (e) {
        this.logger.warn(`Error shutting down Credo agent: ${(e as Error).message}`);
      }
      this.agentInstance = undefined;
      this.initialisation = undefined;
    }
  }

  private async initialiseAgent(): Promise<Oid4vcAgent> {
    this.logger.log(`Initialising Credo OID4VC agent at ${this.config.baseUrl}`);

    // Wire the persistent binding store. The wallet (constructed by Credo's
    // tsyringe container) reaches into the registry singleton, so we have
    // to install the Nest-managed repository on the singleton here rather
    // than passing it through the wallet constructor.
    vaultSigningRegistry.setRepository(this.vaultKeyBindingRepo);

    // Wire the Vault signer that the VaultAskarWallet will call for any
    // Ed25519 key registered with `vaultSigningRegistry`. We resolve a
    // fresh AppRole token per call (the provider caches it internally) so
    // long-running agents don't keep a stale token.
    vaultSigningRegistry.setSigner(async (binding, data) => {
      const token = await this.tokenProvider.getToken();
      const raw = await this.vaultService.sign(
        binding.vaultKeyName,
        binding.transitPath,
        data,
        token,
      );
      // VaultService.sign is typed `Promise<Buffer>` but actually returns
      // the raw `vault:v<n>:<base64>` string the API yields; parse it into
      // the 64 raw bytes the wallet expects.
      return parseVaultSignature(raw as unknown as string);
    });

    // Bridge Credo's internal logger into Nest's `Logger` so OID4VCI/OID4VP
    // diagnostics show up in the same stream as the rest of the service.
    // Without this, errors raised inside Credo's Express routers (mounted in
    // `main.ts` outside Nest's interceptor/exception-filter pipeline) are
    // silently serialised to the wallet as JSON 500s.
    const credoLogLevel = resolveCredoLogLevel(process.env.CREDO_LOG_LEVEL);
    this.logger.log(`Credo logger level: ${process.env.CREDO_LOG_LEVEL ?? 'debug'} (${credoLogLevel})`);
    const credoLogger = new CredoNestLogger(credoLogLevel);
    const agent: Oid4vcAgent = new Agent({
      config: {
        label: this.config.label,
        walletConfig: {
          id: this.config.walletId,
          key: this.config.walletKey,
        },
        endpoints: [this.config.baseUrl],
        logger: credoLogger,
      },
      dependencies: agentDependencies,
      modules: {
        askar: new Oid4vcAskarModule({ ariesAskar }),
        dids: new DidsModule({
          // did:algo is the platform's only DID method. We deliberately do
          // NOT register a did:key registrar/resolver: every actor in our
          // system (issuer, manager, end-user) is expected to hold an
          // on-chain Algorand-anchored identifier so credentials can be
          // verified against the same root of trust the rest of the
          // platform uses.
          registrars: [
            new AlgoDidRegistrar(
              this.didService,
              this.tokenProvider,
              this.vaultService,
              this.configService,
            ),
          ],
          resolvers: [new AlgoDidResolver(this.didService)],
        }),
        connections: new ConnectionsModule({ autoAcceptConnections: true }),
        openId4VcIssuer: new OpenId4VcIssuerModule({
          baseUrl: this.config.issuerBaseUrl,
          router: this.issuerRouter,
          endpoints: {
            credential: {
              credentialRequestToCredentialMapper: (options) => this.credentialMapper(options),
            },
          },
        }),
        openId4VcVerifier: new OpenId4VcVerifierModule({
          baseUrl: this.config.verifierBaseUrl,
          router: this.verifierRouter,
        }),
      },
    });

    await agent.initialize();
    this.agentInstance = agent;
    this.logger.log('Credo OID4VC agent initialised');

    return agent;
  }

  /**
   * Returns (creating it if necessary) the on-chain `did:algo` this issuer
   * signs credentials with. **The issuer DID is the manager's `did:algo`**:
   * the manager is the platform's root of trust, so anchoring the issuer to
   * the manager identity gives verifiers a single, well-known DID to
   * pin/allowlist, and lets us reuse the manager's Vault transit key as the
   * credential signer (no separate "issuer key" sprawl).
   *
   * Selection rules (no fallbacks — we are did:algo only):
   *   1. If an algo DID was previously created in this wallet, reuse it.
   *   2. Else, ask {@link AlgoDidRegistrar} to publish the manager's
   *      `did:algo` on chain (it picks up the manager's existing Vault
   *      transit key). Requires the OID4VC AppRole to be provisioned
   *      (`OID4VC_VAULT_ROLE_ID` / `OID4VC_VAULT_SECRET_ID`).
   *
   * Throws when the AppRole isn't configured, or when the on-chain
   * publication doesn't reach the `finished` state. There is no `did:key`
   * fallback: production and local deployments alike must run against a
   * working Algorand network, because every credential we mint is bound to
   * an on-chain identifier that the verifier resolves against the same
   * chain.
   */
  async ensureIssuerDid(): Promise<IssuerDid> {
    if (this.cachedIssuerDid) return this.cachedIssuerDid;
    const agent = await this.getAgent();
    const managerUserId = this.config.managerUserId;

    const algoDids = await agent.dids.getCreatedDids({ method: 'algo' });
    if (algoDids.length > 0) {
      const did = algoDids[0].did;
      // The publicKey → Vault binding is persisted alongside the DidRecord
      // when the registrar runs, so reuse here doesn't have to rebind.
      const result: IssuerDid = {
        did,
        verificationMethodId: `${did}#keys-1`,
      };
      this.cachedIssuerDid = result;
      return result;
    }

    if (!this.tokenProvider.isConfigured()) {
      throw new Error(
        'Oid4vcAgentProvider: cannot provision the issuer did:algo because the OID4VC Vault ' +
          'AppRole is not configured. Set OID4VC_VAULT_ROLE_ID and OID4VC_VAULT_SECRET_ID so ' +
          'AlgoDidRegistrar can publish the issuer document on chain.',
      );
    }

    // The manager identity already has an Ed25519 transit key under the
    // managers path (`pawn/managers/keys/<managerUserId>`); we point the
    // registrar there explicitly so it reuses that key (and binds the
    // signing registry to `pawn/managers/sign/<managerUserId>`) rather
    // than minting a *new* key under the users path that would have no
    // relation to the manager identity the rest of the platform uses.
    const created = await agent.dids.create<AlgoDidCreateOptions>({
      method: 'algo',
      options: {
        userId: managerUserId,
        transitPath: this.config.managerTransitPath,
      },
    });
    if (created.didState.state !== 'finished' || !created.didState.did) {
      throw new Error(
        `Failed to provision did:algo issuer (state=${created.didState.state}): ` +
          JSON.stringify(created.didState),
      );
    }

    const did = created.didState.did;
    const result: IssuerDid = {
      did,
      verificationMethodId: `${did}#keys-1`,
    };
    this.cachedIssuerDid = result;
    this.logger.log(`Provisioned did:algo issuer ${did}`);
    return result;
  }

  /**
   * Resolve the `did:algo` identifier the platform has published for an
   * application user. Returns `null` only when the user has not been
   * provisioned yet — callers that need a guaranteed DID (e.g. the
   * credential mapper) should treat that as a hard failure, since every
   * platform user is expected to have an on-chain identifier.
   */
  async resolveUserAlgoDid(userId: string): Promise<string | null> {
    const record = await this.didService.resolveLocal(userId);
    return record?.did ?? null;
  }

  /**
   * Resolve the linked Algorand address ("`#keys-2`") published in the
   * user's on-chain DID document via `alsoKnownAs: ["algorand:<addr>"]`.
   *
   * The wallet uses this to pick the matching algorand-account key it
   * holds locally so the OID4VCI proof JWT is signed with the same
   * private half whose public half is the chain-published `#keys-2`
   * verification method. Returns `null` when the user has no document
   * or hasn't linked a self-custody wallet yet.
   */
  async resolveUserLinkedAlgorandAddress(userId: string): Promise<string | null> {
    const record = await this.didService.resolveLocal(userId);
    if (!record?.document) return null;
    try {
      const parsed = JSON.parse(record.document) as { alsoKnownAs?: unknown };
      const aka = Array.isArray(parsed.alsoKnownAs) ? parsed.alsoKnownAs : [];
      for (const entry of aka) {
        if (typeof entry === 'string' && entry.startsWith('algorand:')) {
          return entry.slice('algorand:'.length);
        }
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `Stored did:algo document for userId=${userId} is unparseable: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve the full DID document the platform has published for an
   * application user. Used by the credential mapper to verify that the
   * holder-binding `kid` (e.g. `<userDid>#keys-2`) actually corresponds to
   * a verification method on the user's on-chain document — without this
   * check, a wallet could ask us to bind a credential to any key id we
   * haven't blessed.
   *
   * Returns `null` when the user has no published document, or when the
   * stored payload is unparseable; callers must treat both as a hard
   * failure for credential issuance.
   */
  async resolveUserAlgoDidDocument(
    userId: string,
  ): Promise<{ did: string; verificationMethodIds: string[] } | null> {
    const record = await this.didService.resolveLocal(userId);
    if (!record?.did || !record.document) return null;
    try {
      const parsed = JSON.parse(record.document) as { verificationMethod?: Array<{ id?: string }> };
      const ids = (parsed.verificationMethod ?? [])
        .map((vm) => vm.id)
        .filter((id): id is string => typeof id === 'string');
      return { did: record.did, verificationMethodIds: ids };
    } catch (err) {
      this.logger.warn(
        `Stored did:algo document for userId=${userId} is unparseable: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
