import { Logger } from '@nestjs/common';
/**
 * Minimal HTTP client for the CREDEBL platform trust registry.
 *
 * CREDEBL exposes a multi-tenant REST surface for registering issuer
 * organisations, schemas, and credential configurations, and for asking
 * "is this issuer trusted to issue this credential type in this
 * ecosystem?". This client wraps just the four calls we need today:
 *
 * - `registerIssuer`  — assert that a `did:algo` belongs to our org.
 * - `registerCredentialConfiguration` — assert that the org is
 *   authorised to issue a given (format, type) tuple.
 * - `getIssuer`       — read back the issuer record (used to make the
 *   boot-time registration idempotent and to power `isIssuerTrusted`).
 * - `isIssuerTrusted` — verifier-side check; resolves to `false` when
 *   the issuer is unknown or has been removed.
 *
 * The exact CREDEBL paths/payloads vary across deployments (and across
 * the public CREDEBL releases). They are intentionally centralised
 * here so we have one place to adjust when we vendor a fork in M2
 * (`TRUST_MODEL.md`). The client never holds any signing material and
 * never writes to Algorand — that's the registrar's job (cf.
 * `libs/credo-did-algo`). CREDEBL only stores governance assertions.
 */
export interface CredeblIssuerRegistration {
  did: string;
  orgId: string;
  ecosystem?: string;
  metadata?: Record<string, unknown>;
}

export interface CredeblCredentialConfiguration {
  issuerDid: string;
  configurationId: string;
  format: string;
  type: string | string[];
  metadata?: Record<string, unknown>;
}

export interface CredeblTransport {
  request(input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
}

/** Production transport over the global `fetch`. Injected for tests. */
export class FetchCredeblTransport implements CredeblTransport {
  constructor(private readonly baseUrl: string) {}
  async request(input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${input.path}`;
    const res = await fetch(url, {
      method: input.method,
      headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    let body: unknown = undefined;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  }
}

export interface CredeblClientOptions {
  baseUrl: string;
  orgId: string;
  apiKey: string;
  ecosystem?: string;
  transport?: CredeblTransport;
}

export class CredeblClient {
  private readonly logger = new Logger(CredeblClient.name);
  private readonly transport: CredeblTransport;
  private readonly orgId: string;
  private readonly apiKey: string;
  private readonly ecosystem?: string;

  constructor(opts: CredeblClientOptions) {
    if (!opts.baseUrl) throw new Error('CredeblClient: baseUrl is required');
    if (!opts.orgId) throw new Error('CredeblClient: orgId is required');
    if (!opts.apiKey) throw new Error('CredeblClient: apiKey is required');
    this.transport = opts.transport ?? new FetchCredeblTransport(opts.baseUrl);
    this.orgId = opts.orgId;
    this.apiKey = opts.apiKey;
    this.ecosystem = opts.ecosystem;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  /** Idempotently register the issuer DID under our org. */
  async registerIssuer(input: { did: string; metadata?: Record<string, unknown> }): Promise<void> {
    const payload: CredeblIssuerRegistration = {
      did: input.did,
      orgId: this.orgId,
      ecosystem: this.ecosystem,
      metadata: input.metadata,
    };
    const res = await this.transport.request({
      method: 'POST',
      path: `/orgs/${encodeURIComponent(this.orgId)}/issuers`,
      headers: this.authHeaders(),
      body: payload,
    });
    if (res.status === 200 || res.status === 201 || res.status === 409) {
      this.logger.log(`CREDEBL registerIssuer ok (status=${res.status}) did=${input.did}`);
      return;
    }
    throw new Error(`CREDEBL registerIssuer failed (status=${res.status}): ${JSON.stringify(res.body)}`);
  }

  /** Register a (format, type) credential configuration under the issuer. */
  async registerCredentialConfiguration(cfg: CredeblCredentialConfiguration): Promise<void> {
    const res = await this.transport.request({
      method: 'POST',
      path: `/orgs/${encodeURIComponent(this.orgId)}/issuers/${encodeURIComponent(cfg.issuerDid)}/credential-configurations`,
      headers: this.authHeaders(),
      body: cfg,
    });
    if (res.status === 200 || res.status === 201 || res.status === 409) {
      this.logger.log(`CREDEBL registerCredentialConfiguration ok (status=${res.status}) id=${cfg.configurationId}`);
      return;
    }
    throw new Error(
      `CREDEBL registerCredentialConfiguration failed (status=${res.status}): ${JSON.stringify(res.body)}`,
    );
  }

  /** Look up an issuer record. Returns `null` on 404. */
  async getIssuer(did: string): Promise<{ did: string; trusted: boolean; metadata?: unknown } | null> {
    const res = await this.transport.request({
      method: 'GET',
      path: `/orgs/${encodeURIComponent(this.orgId)}/issuers/${encodeURIComponent(did)}`,
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new Error(`CREDEBL getIssuer failed (status=${res.status}): ${JSON.stringify(res.body)}`);
    }
    const body = (res.body ?? {}) as { trusted?: boolean; status?: string; metadata?: unknown };
    const trusted = typeof body.trusted === 'boolean' ? body.trusted : body.status === 'active';
    return { did, trusted, metadata: body.metadata };
  }

  /**
   * Verifier-side trust check. Returns `false` when the issuer is
   * unknown, when CREDEBL has marked it untrusted/revoked, or — when
   * `credentialType` is provided — when the issuer is not authorised
   * for that specific type.
   */
  async isIssuerTrusted(did: string, credentialType?: string): Promise<boolean> {
    const issuer = await this.getIssuer(did);
    if (!issuer || !issuer.trusted) return false;
    if (!credentialType) return true;
    const res = await this.transport.request({
      method: 'GET',
      path:
        `/orgs/${encodeURIComponent(this.orgId)}/issuers/${encodeURIComponent(did)}` +
        `/credential-configurations/${encodeURIComponent(credentialType)}`,
      headers: this.authHeaders(),
    });
    if (res.status === 404) return false;
    if (res.status !== 200) {
      throw new Error(`CREDEBL credential-configuration lookup failed (status=${res.status})`);
    }
    return true;
  }
}
