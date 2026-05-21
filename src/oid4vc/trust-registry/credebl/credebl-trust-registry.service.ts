import { Injectable, Logger } from '@nestjs/common';
import { Oid4vcConfig } from '../../oid4vc.config';
import { DEFAULT_CREDENTIAL_CONFIGURATIONS } from '../../issuer/credential-configurations';
import { CredeblClient } from './credebl.client';

/**
 * Glue between the OID4VC stack and the CREDEBL trust registry.
 *
 * Two responsibilities:
 *
 * 1. **Publish.** On boot (`registerIssuer`), once the manager
 *    `did:algo` has been provisioned by `AlgoDidRegistrar`, push it
 *    plus the supported credential configurations to CREDEBL. This is
 *    the *governance* step described in `TRUST_MODEL.md` — minting on
 *    chain is step 1 (handled by the registrar), telling CREDEBL about
 *    it is step 2 (handled here).
 * 2. **Gate.** On verification (`assertIssuerTrusted`), look the
 *    presenting issuer up in CREDEBL. When `CREDEBL_VERIFY_FAIL_CLOSED`
 *    is on (default), an unknown / removed issuer rejects the session.
 *    When off, the result is logged but not enforced.
 *
 * The service is a no-op when `CREDEBL_ENABLED=false`. It never throws
 * during boot on CREDEBL failure — it logs and continues, so a partial
 * CREDEBL outage doesn't take down credential issuance. Verification
 * gating is opt-in via `CREDEBL_VERIFY_FAIL_CLOSED`.
 */
@Injectable()
export class CredeblTrustRegistryService {
  private readonly logger = new Logger(CredeblTrustRegistryService.name);
  private client?: CredeblClient;
  private registered = false;

  constructor(private readonly config: Oid4vcConfig) {}

  /** `true` when CREDEBL_ENABLED is set and the client could be built. */
  isEnabled(): boolean {
    return this.config.credeblEnabled && Boolean(this.getClient());
  }

  /**
   * Called by `Oid4vcAgentProvider.ensureIssuerDid` once the manager
   * `did:algo` is known. Idempotent: subsequent calls within the same
   * process exit early. Per-process state is sufficient because the
   * remote side is itself idempotent (409 = already there).
   */
  async registerIssuer(issuerDid: string): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.registered) return;
    const client = this.getClient();
    if (!client) return;
    try {
      await client.registerIssuer({
        did: issuerDid,
        metadata: {
          resolver: `${this.config.baseUrl}/v1/did/identities/${encodeURIComponent(issuerDid)}`,
          oid4vciIssuer: this.config.issuerBaseUrl,
        },
      });
      for (const [configurationId, cfg] of Object.entries(DEFAULT_CREDENTIAL_CONFIGURATIONS)) {
        await client.registerCredentialConfiguration({
          issuerDid,
          configurationId,
          format: String(cfg.format),
          // Best-effort extraction: SD-JWT uses `vct`, W3C JWT uses
          // `credential_definition.type`. Either shape is acceptable to
          // CREDEBL as long as we provide *something* in `type`.
          type: extractType(cfg) ?? configurationId,
          metadata: cfg as unknown as Record<string, unknown>,
        });
      }
      this.registered = true;
      this.logger.log(
        `CREDEBL: issuer ${issuerDid} registered with ${
          Object.keys(DEFAULT_CREDENTIAL_CONFIGURATIONS).length
        } credential configuration(s)`,
      );
    } catch (e) {
      this.logger.warn(`CREDEBL: registerIssuer failed (will retry on next boot): ${(e as Error).message}`);
    }
  }

  /**
   * Verifier-side trust check. Returns `true` when the issuer is
   * trusted (or when CREDEBL is disabled — pass-through). Throws when
   * `CREDEBL_VERIFY_FAIL_CLOSED=true` (default) and CREDEBL does not
   * confirm trust; returns `false` otherwise so the caller can decide.
   */
  async assertIssuerTrusted(issuerDid: string, credentialType?: string): Promise<boolean> {
    if (!this.isEnabled()) return true;
    const client = this.getClient();
    if (!client) return true;
    let trusted = false;
    try {
      trusted = await client.isIssuerTrusted(issuerDid, credentialType);
    } catch (e) {
      this.logger.warn(`CREDEBL: isIssuerTrusted threw, treating as untrusted: ${(e as Error).message}`);
      trusted = false;
    }
    if (trusted) return true;
    const msg =
      `CREDEBL trust registry rejected issuer ${issuerDid}` + (credentialType ? ` for type ${credentialType}` : '');
    if (this.config.credeblVerifyFailClosed) {
      throw new Error(msg);
    }
    this.logger.warn(`${msg} (fail-closed disabled, allowing through)`);
    return false;
  }

  private getClient(): CredeblClient | undefined {
    if (this.client) return this.client;
    if (!this.config.credeblEnabled) return undefined;
    if (!this.config.credeblBaseUrl || !this.config.credeblOrgId || !this.config.credeblApiKey) {
      this.logger.warn(
        'CREDEBL_ENABLED=true but CREDEBL_BASE_URL / CREDEBL_ORG_ID / CREDEBL_API_KEY are not all set; CREDEBL integration disabled.',
      );
      return undefined;
    }
    this.client = new CredeblClient({
      baseUrl: this.config.credeblBaseUrl,
      orgId: this.config.credeblOrgId,
      apiKey: this.config.credeblApiKey,
      ecosystem: this.config.credeblEcosystem,
    });
    return this.client;
  }
}

function extractType(cfg: unknown): string | undefined {
  const c = cfg as { vct?: string; credential_definition?: { type?: string[] } };
  if (c.vct) return c.vct;
  const types = c.credential_definition?.type;
  if (Array.isArray(types) && types.length > 0) return types[types.length - 1];
  return undefined;
}
