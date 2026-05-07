import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AgentContext } from '@credo-ts/core';
import {
  DidDocumentRole,
  DidRecord,
  DidRepository,
  TypedArrayEncoder,
} from '@credo-ts/core';
import type {
  DidCreateOptions,
  DidCreateResult,
  DidDeactivateOptions,
  DidDeactivateResult,
  DidRegistrar,
  DidUpdateResult,
} from '@credo-ts/core';

import { DidService } from '../../did/did.service';
import { VaultService } from '../../vault/vault.service';
import { AlgoVaultTokenProvider } from './algo-vault-token.provider';
import { buildCredoDidDocumentFromKey } from './algo-did.resolver';
import { vaultSigningRegistry } from './vault-signing-registry';

/**
 * Extra options accepted by {@link AlgoDidRegistrar}. Two pieces of state
 * are required that Credo's generic `DidCreateOptions` does not model:
 *
 *   - `userId`: the application-level user the DID belongs to. The on-chain
 *     box is keyed by the user's vault key, so the registrar needs to know
 *     which user to look up. For the platform issuer DID, this is a
 *     synthetic id (e.g. `oid4vc-issuer:<issuer-id>`).
 *   - `publicKey`: the raw 32-byte ed25519 public key that becomes the DID
 *     subject. Supplied by the caller (Askar wallet) so we don't have to
 *     guess which key Credo wants to publish.
 *
 * `force` mirrors the flag on {@link DidService.publishUserDid} and lets a
 * caller overwrite a previously published document (reclaiming MBR before
 * republishing).
 */
export interface AlgoDidCreateOptions extends DidCreateOptions {
  method: 'algo';
  did?: never;
  options: {
    userId: string;
    /**
     * `force` mirrors {@link DidService.publishUserDid}: when the user
     * already has an on-chain document, `force=true` deletes it before
     * republishing instead of failing with `DidAlreadyPublishedError`.
     */
    force?: boolean;
    /**
     * Override the Vault transit path the registrar uses to look up /
     * create the user's ed25519 key. Defaults to `VAULT_TRANSIT_USERS_PATH`.
     * Used by tests; production callers should leave this unset.
     */
    transitPath?: string;
  };
}

export interface AlgoDidDeactivateOptions extends DidDeactivateOptions {
  did: string;
  options?: {
    userId?: string;
  };
}

/**
 * Credo `DidRegistrar` for `did:algo`.
 *
 * The registrar is intentionally a thin adapter: it converts Credo's
 * generic registrar contract into a call to {@link DidService.publishUserDid}
 * (or {@link DidService.deleteUserDid}) so that there is exactly one code
 * path producing on-chain DID documents. That keeps the manager-controlled
 * publication invariant — the manager Vault key always signs the chain
 * transaction — without duplicating the algokit / contract logic.
 *
 * Updates are deliberately unsupported in this iteration: the platform's
 * current contract semantics treat the document as immutable per
 * publication, and the only mutation we actually surface (linking a wallet
 * via {@link buildDidDocument}) is captured at publish time.
 */
export class AlgoDidRegistrar implements DidRegistrar {
  private readonly logger = new Logger(AlgoDidRegistrar.name);
  readonly supportedMethods = ['algo'];

  constructor(
    private readonly didService: DidService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
    private readonly vaultService: VaultService,
    private readonly configService: ConfigService,
  ) {}

  async create(agentContext: AgentContext, options: AlgoDidCreateOptions): Promise<DidCreateResult> {
    try {
      const { userId, force, transitPath: transitPathOverride } =
        options.options ?? ({} as AlgoDidCreateOptions['options']);
      if (!userId) {
        return this.failed('AlgoDidRegistrar.create requires options.userId');
      }

      const transitPath =
        transitPathOverride ??
        this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');
      if (!transitPath) {
        return this.failed(
          'AlgoDidRegistrar.create requires VAULT_TRANSIT_USERS_PATH to be configured (or options.transitPath supplied).',
        );
      }

      const vaultToken = await this.tokenProvider.getToken();

      // Resolve the user's Ed25519 public key from Vault. We never generate
      // a key in the agent wallet anymore — the on-chain DID document and
      // every credential signature must trace back to the same Vault key,
      // otherwise the holder/verifier would resolve a public key on chain
      // that does not match the JWS signature.
      let publicKeyBuffer: Buffer;
      try {
        publicKeyBuffer = await this.vaultService.getKey(userId, transitPath, vaultToken);
      } catch (err) {
        // When the caller explicitly overrode the transit path (e.g. the
        // issuer-DID provisioning path that points at the managers path)
        // we never lazy-create — the key is expected to already exist
        // and the OID4VC AppRole policy is intentionally scoped down to
        // not allow `keys/*` writes there. Surface a clear error rather
        // than fail with a confusing "VaultException" from the create.
        if (transitPathOverride) {
          return this.failed(
            `AlgoDidRegistrar.create: Vault has no transit key for userId=${userId} at path=${transitPath}; ` +
              `the caller supplied an explicit transitPath, so lazy-create is disabled. ` +
              `Provision the key out-of-band (the manager bootstrap normally does this).`,
          );
        }
        // Key didn't exist yet — create it so first-time platform users
        // get a Vault-backed credential issuance key on demand. Any other
        // error (auth, network, …) is rethrown by the underlying call.
        this.logger.log(`No Vault transit key for userId=${userId}; creating one`);
        publicKeyBuffer = await this.vaultService.transitCreateKey(userId, transitPath, vaultToken);
      }

      const publicKey = new Uint8Array(publicKeyBuffer);
      if (publicKey.length !== 32) {
        return this.failed(
          `AlgoDidRegistrar.create: Vault returned ${publicKey.length}-byte key for userId=${userId}; expected 32 bytes (ed25519).`,
        );
      }

      // Bind the public key to its Vault transit name so VaultAskarWallet
      // routes future signing through Vault. Done before publication so a
      // crash mid-publish doesn't leave the wallet unable to sign for the
      // (already-on-chain) DID on next reuse.
      const publicKeyBase58 = TypedArrayEncoder.toBase58(publicKey);
      await vaultSigningRegistry.bind(publicKeyBase58, { vaultKeyName: userId, transitPath });

      const published = await this.didService.publishUserDid({
        userId,
        publicKey,
        vaultToken,
        force: Boolean(force),
      });

      // Persist a Credo DidRecord so subsequent calls (e.g. signing JWTs as
      // this issuer) can resolve the DID through the local-record path
      // without an on-chain round-trip.
      const didRepository = agentContext.dependencyManager.resolve(DidRepository);
      const didDocument = buildCredoDidDocumentFromKey(published.did, publicKey);
      const didRecord = new DidRecord({
        did: published.did,
        role: DidDocumentRole.Created,
        didDocument,
      });
      await didRepository.save(agentContext, didRecord);

      this.logger.log(`Published did:algo for userId=${userId} → ${published.did}`);

      return {
        didState: {
          state: 'finished',
          did: published.did,
          didDocument,
        },
        didRegistrationMetadata: {},
        didDocumentMetadata: {},
      };
    } catch (err) {
      return this.failed((err as Error).message);
    }
  }

  async update(): Promise<DidUpdateResult> {
    return {
      didState: {
        state: 'failed',
        reason:
          'did:algo update is not supported by AlgoDidRegistrar; deactivate the DID and create a new one with an updated document.',
      },
      didRegistrationMetadata: {},
      didDocumentMetadata: {},
    };
  }

  async deactivate(_agentContext: AgentContext, options: AlgoDidDeactivateOptions): Promise<DidDeactivateResult> {
    try {
      const { did } = options;
      if (!did) {
        return this.failedDeactivate('AlgoDidRegistrar.deactivate requires options.did');
      }

      // Resolve the userId from either the explicit option or the locally
      // cached record. The on-chain delete is keyed by the user's vault key
      // (looked up via `DidService.deleteUserDid`), so we need a userId.
      let userId = options.options?.userId;
      if (!userId) {
        const records = await this.didService.listRecords();
        userId = records.find((r) => r.did === did)?.user_id;
      }
      if (!userId) {
        return this.failedDeactivate(`No local DID record found for ${did}; cannot determine userId for deactivate.`);
      }

      const vaultToken = await this.tokenProvider.getToken();
      const result = await this.didService.deleteUserDid(userId, vaultToken);
      this.logger.log(
        `Deactivated did:algo userId=${userId} did=${did} txCount=${result.txIds?.length ?? 0} cacheRemoved=${result.cacheRemoved}`,
      );
      return {
        didState: { state: 'finished', did, didDocument: undefined as never },
        didRegistrationMetadata: {},
        didDocumentMetadata: {},
      };
    } catch (err) {
      return this.failedDeactivate((err as Error).message);
    }
  }

  private failed(reason: string): DidCreateResult {
    this.logger.error(`AlgoDidRegistrar.create failed: ${reason}`);
    return {
      didState: { state: 'failed', reason },
      didRegistrationMetadata: {},
      didDocumentMetadata: {},
    };
  }

  private failedDeactivate(reason: string): DidDeactivateResult {
    this.logger.error(`AlgoDidRegistrar.deactivate failed: ${reason}`);
    return {
      didState: { state: 'failed', reason },
      didRegistrationMetadata: {},
      didDocumentMetadata: {},
    };
  }
}
