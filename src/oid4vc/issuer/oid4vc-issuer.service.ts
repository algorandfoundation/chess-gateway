import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClaimFormat, JwaSignatureAlgorithm, W3cCredential, W3cIssuer, w3cDate } from '@credo-ts/core';
import {
  OpenId4VciCredentialConfigurationsSupported,
  OpenId4VciCredentialFormatProfile,
  OpenId4VciCredentialRequestToCredentialMapper,
  OpenId4VciSignCredential,
} from '@credo-ts/openid4vc';

import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';

/**
 * Default credential configurations exposed by this issuer.
 *
 * Two profiles are advertised so wallets can pick whichever they support:
 * - `credential-sd-jwt` → IETF SD-JWT VC (recommended, used by HAIP)
 * - `credential-jwt-vc` → W3C JWT VC
 *
 * The shape of these configurations is intentionally minimal - production
 * deployments should extend them with proper `display`, `claims`, and
 * `cryptographic_binding_methods_supported` based on the wallet ecosystem.
 */
export const DEFAULT_CREDENTIAL_CONFIGURATIONS: OpenId4VciCredentialConfigurationsSupported = {
  'credential-sd-jwt': {
    format: OpenId4VciCredentialFormatProfile.SdJwtVc,
    vct: 'credential-sd-jwt',
    // `did:algo` is the only DID-based binding we accept — every actor on
    // the platform (issuer + holder) has an on-chain Algorand identifier,
    // and we will not bind a credential to an unrelated `did:key`.
    cryptographic_binding_methods_supported: ['did:algo'],
    credential_signing_alg_values_supported: [JwaSignatureAlgorithm.EdDSA],
    scope: 'credential_sd_jwt',
  },
  'credential-jwt-vc': {
    format: OpenId4VciCredentialFormatProfile.JwtVcJson,
    cryptographic_binding_methods_supported: ['did:algo'],
    credential_signing_alg_values_supported: [JwaSignatureAlgorithm.EdDSA],
    credential_definition: {
      type: ['VerifiableCredential', 'CredentialJwtVc'],
    },
    scope: 'credential_jwt_vc',
  },
};

/**
 * Encapsulates the OID4VCI side of the agent: registers the singleton issuer
 * record on bootstrap, exposes a `createOffer` API for the rest of the app,
 * and installs the credential mapper that decides what to actually sign when
 * the wallet redeems an offer.
 */
@Injectable()
export class Oid4vcIssuerService implements OnModuleInit {
  private readonly logger = new Logger(Oid4vcIssuerService.name);

  /**
   * Stable issuer id used both as the Credo `issuerId` and as the segment
   * appended to the issuer base URL in the credential offer. We use a single
   * issuer for all credentials in this service.
   */
  static readonly ISSUER_ID = 'pawn-rewards-issuer';

  constructor(
    private readonly agentProvider: Oid4vcAgentProvider,
    private readonly config: Oid4vcConfig,
    @InjectRepository(Oid4vcIssuanceSession)
    private readonly sessionRepo: Repository<Oid4vcIssuanceSession>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Always install the mapper - it's a stable closure that can be called
    // even before `ensureIssuer()` has run, because Credo only invokes it
    // once a wallet redeems an offer.
    this.agentProvider.setCredentialMapper(this.buildCredentialMapper());

    if (!this.config.autoInit) return;
    try {
      await this.ensureIssuer();
    } catch (e) {
      this.logger.error(`Failed to ensure issuer record: ${(e as Error).message}`);
    }
  }

  /**
   * Idempotently creates the issuer record inside Credo. Safe to call multiple
   * times - returns the existing record if one already matches our `issuerId`.
   */
  async ensureIssuer() {
    const agent = await this.agentProvider.getAgent();
    let record;
    try {
      record = await agent.modules.openId4VcIssuer.getIssuerByIssuerId(Oid4vcIssuerService.ISSUER_ID);
    } catch {
      this.logger.log(`Creating Credo issuer record ${Oid4vcIssuerService.ISSUER_ID}`);
      return agent.modules.openId4VcIssuer.createIssuer({
        issuerId: Oid4vcIssuerService.ISSUER_ID,
        display: [{ name: this.config.issuerDisplayName }],
        credentialConfigurationsSupported: DEFAULT_CREDENTIAL_CONFIGURATIONS,
      });
    }

    // The issuer record persists `credentialConfigurationsSupported` in Askar,
    // so a record created with stale configurations (e.g. before a rename or
    // a format change) keeps serving the old metadata until we explicitly
    // refresh it. Detect drift between the record and the in-code default and
    // push an update so `createCredentialOffer` accepts the current ids.
    const persisted = (record as { credentialConfigurationsSupported?: Record<string, unknown> })
      .credentialConfigurationsSupported;
    if (this.hasConfigurationDrift(persisted)) {
      this.logger.log(
        `Updating Credo issuer record ${Oid4vcIssuerService.ISSUER_ID}: credential configurations drifted`,
      );
      await agent.modules.openId4VcIssuer.updateIssuerMetadata({
        issuerId: Oid4vcIssuerService.ISSUER_ID,
        display: [{ name: this.config.issuerDisplayName }],
        credentialConfigurationsSupported: DEFAULT_CREDENTIAL_CONFIGURATIONS,
      });
      record = await agent.modules.openId4VcIssuer.getIssuerByIssuerId(Oid4vcIssuerService.ISSUER_ID);
    }
    return record;
  }

  private hasConfigurationDrift(persisted: Record<string, unknown> | undefined): boolean {
    if (!persisted) return true;
    const expectedKeys = Object.keys(DEFAULT_CREDENTIAL_CONFIGURATIONS).sort();
    const actualKeys = Object.keys(persisted).sort();
    if (expectedKeys.length !== actualKeys.length) return true;
    for (let i = 0; i < expectedKeys.length; i++) {
      if (expectedKeys[i] !== actualKeys[i]) return true;
    }
    try {
      return JSON.stringify(persisted) !== JSON.stringify(DEFAULT_CREDENTIAL_CONFIGURATIONS);
    } catch {
      return true;
    }
  }

  /**
   * Creates a pre-authorized OID4VCI offer for the provided credential
   * configuration ids and returns the offer URI plus a tracking record so the
   * caller can later look up the issuance state.
   */
  async createOffer(input: {
    credentialConfigurationIds: string[];
    userId: string;
    issuanceMetadata?: Record<string, unknown>;
  }): Promise<Oid4vcIssuanceSession> {
    if (!input.userId) {
      throw new Error(
        'createOffer requires a userId: every credential is bound to the recipient\'s did:algo, ' +
          'so anonymous offers are not supported.',
      );
    }
    const agent = await this.agentProvider.getAgent();
    await this.ensureIssuer();

    const { issuanceSession, credentialOffer } = await agent.modules.openId4VcIssuer.createCredentialOffer({
      issuerId: Oid4vcIssuerService.ISSUER_ID,
      offeredCredentials: input.credentialConfigurationIds,
      preAuthorizedCodeFlowConfig: { txCode: undefined },
      issuanceMetadata: {
        ...(input.issuanceMetadata ?? {}),
        // Include the offered configurations so the mapper can validate them
        // without re-parsing the request payload.
        _offeredCredentialConfigurationIds: input.credentialConfigurationIds,
        _userId: input.userId,
      },
    });

    const record = this.sessionRepo.create({
      credoIssuanceSessionId: issuanceSession.id,
      issuerId: Oid4vcIssuerService.ISSUER_ID,
      userId: input.userId,
      offeredCredentialConfigurationIds: input.credentialConfigurationIds,
      preAuthorizedCode: issuanceSession.preAuthorizedCode,
      credentialOffer,
      state: issuanceSession.state,
      issuanceMetadata: input.issuanceMetadata,
    });
    return this.sessionRepo.save(record);
  }

  /** Returns the local app-level session record. */
  async findSession(id: string): Promise<Oid4vcIssuanceSession> {
    const session = await this.sessionRepo.findOneBy({ id });
    if (!session) throw new NotFoundException(`Issuance session ${id} not found`);
    // Note: the canonical state lives on the Credo OpenId4VcIssuanceSessionRecord.
    // To keep this service simple we only return the local snapshot here and
    // rely on Credo events (see Oid4vcEventsListener follow-up) to update
    // `state` when the wallet redeems the offer.
    return session;
  }

  async listSessions(): Promise<Oid4vcIssuanceSession[]> {
    return this.sessionRepo.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Builds the credential mapper. The mapper is the heart of OID4VCI on the
   * issuer side: when a wallet calls the credential endpoint with a proof of
   * possession, Credo invokes this function to materialise a signed credential.
   *
   * The mapper picks the requested format and pulls the actual claim payload
   * from `issuanceMetadata` that was attached when the offer was created.
   */
  private buildCredentialMapper(): OpenId4VciCredentialRequestToCredentialMapper {
    return async ({ credentialConfigurationIds, issuanceSession, holderBinding }) => {
      const configurationId = credentialConfigurationIds[0];
      const configuration = DEFAULT_CREDENTIAL_CONFIGURATIONS[configurationId];
      if (!configuration) {
        throw new Error(`Unknown credential configuration ${configurationId}`);
      }

      const claims = (issuanceSession.issuanceMetadata ?? {}) as Record<string, unknown>;
      const offerUserId = (claims._userId as string | undefined) ?? undefined;
      const issuerDid = await this.agentProvider.ensureIssuerDid();

      // Strict `#keys-2` holder binding:
      //
      // The user's on-chain `did:algo` document carries two verification
      // methods — `#keys-1` (the platform-custodied Vault key, used by the
      // issuer) and `#keys-2` (the user's self-custody wallet key,
      // attested via the link/integrity flow). Credentials must be bound
      // to `#keys-2`: the user is the only one who can prove possession,
      // and that's what later lets the holder sign Key-Binding JWTs / VP
      // proofs against the credential.
      //
      // Anything else is rejected: missing offer userId, unprovisioned
      // user, holder method other than `did`, holder DID mismatch, or a
      // `kid` that isn't `<userDid>#keys-2` (e.g. `#keys-1` — that's the
      // platform's key, not the user's). All currently advertised
      // configurations are DID-bound, so these checks always run.
      if (!offerUserId) {
        throw new Error(
          `Cannot issue ${configurationId}: the credential offer was created without a userId. ` +
            'DID-bound credentials must be tied to an existing platform user (did:algo).',
        );
      }
      const doc = await this.agentProvider.resolveUserAlgoDidDocument(offerUserId);
      if (!doc) {
        throw new Error(
          `Cannot issue ${configurationId}: user ${offerUserId} does not have a published did:algo. ` +
            'Every platform user must have an on-chain DID before they can be issued credentials.',
        );
      }
      const userAlgoDid = doc.did;
      const userKeys2Id = `${doc.did}#keys-2`;
      if (!doc.verificationMethodIds.includes(userKeys2Id)) {
        throw new Error(
          `Cannot issue ${configurationId}: user ${offerUserId} has not registered a self-custody ` +
            `wallet key (#keys-2) on ${doc.did}. The user must complete device link/attestation ` +
            'before credentials can be bound to them.',
        );
      }
      if (holderBinding.method !== 'did') {
        throw new Error(
          `Cannot issue ${configurationId}: holder binding method '${holderBinding.method}' is not supported. ` +
            `The wallet must prove possession of ${userKeys2Id}.`,
        );
      }
      if (holderBinding.didUrl !== userKeys2Id) {
        throw new Error(
          `Holder binding mismatch for ${configurationId}: wallet proved possession of ` +
            `${holderBinding.didUrl} but credentials must be bound to ${userKeys2Id} ` +
            "(the user's self-custody wallet key).",
        );
      }

      switch (configuration.format) {
        case OpenId4VciCredentialFormatProfile.SdJwtVc: {
          const signed: OpenId4VciSignCredential = {
            credentialSupportedId: configurationId,
            format: ClaimFormat.SdJwtVc,
            payload: {
              vct: (configuration as { vct?: string }).vct ?? 'credential-sd-jwt',
              ...stripInternalKeys(claims),
            },
            issuer: { method: 'did', didUrl: issuerDid.verificationMethodId },
            // Bind to the user's self-custody wallet key (`#keys-2`), so a
            // later Key-Binding JWT signed by the device can be verified
            // against the on-chain DID document.
            holder: { method: 'did', didUrl: userKeys2Id as string },
            disclosureFrame: { _sd: Object.keys(stripInternalKeys(claims)) },
          };
          return signed;
        }

        case OpenId4VciCredentialFormatProfile.JwtVcJson:
        case OpenId4VciCredentialFormatProfile.JwtVcJsonLd:
        case OpenId4VciCredentialFormatProfile.LdpVc: {
          const credential = new W3cCredential({
            type: ['VerifiableCredential', 'CredentialJwtVc'],
            issuer: new W3cIssuer({ id: issuerDid.did }),
            issuanceDate: w3cDate(),
            credentialSubject: {
              id: userAlgoDid as string,
              ...stripInternalKeys(claims),
            },
          });
          const signed: OpenId4VciSignCredential = {
            credentialSupportedId: configurationId,
            format: ClaimFormat.JwtVc,
            verificationMethod: issuerDid.verificationMethodId,
            credential,
          };
          return signed;
        }

        default:
          throw new Error(`Unsupported credential format ${configuration.format}`);
      }
    };
  }
}

/** Strip the bookkeeping fields we inject into `issuanceMetadata`. */
function stripInternalKeys(claims: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(claims)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}
