import { CredeblTrustRegistryService } from './credebl-trust-registry.service';
import type { CredeblTransport } from './credebl.client';
import { Oid4vcConfig } from '../../oid4vc.config';

function makeConfig(overrides: Partial<Record<string, string>> = {}): Oid4vcConfig {
  const env: Record<string, string> = {
    CREDEBL_ENABLED: 'true',
    CREDEBL_BASE_URL: 'https://credebl.test',
    CREDEBL_ORG_ID: 'org-1',
    CREDEBL_API_KEY: 'key-1',
    OID4VC_BASE_URL: 'http://localhost:3000',
    ...overrides,
  };
  const fakeConfigService = {
    get: <T>(key: string, fallback?: T) => (env[key] !== undefined ? (env[key] as unknown as T) : (fallback as T)),
  };
  return new Oid4vcConfig(fakeConfigService as never);
}

function makeTransport(responder: (req: { method: string; path: string }) => { status: number; body?: unknown }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport: CredeblTransport = {
    request: async (input) => {
      calls.push({ method: input.method, path: input.path, body: input.body });
      const r = responder({ method: input.method, path: input.path });
      return { status: r.status, body: r.body };
    },
  };
  return { transport, calls };
}

describe('CredeblTrustRegistryService', () => {
  it('is a no-op when disabled', async () => {
    const svc = new CredeblTrustRegistryService(makeConfig({ CREDEBL_ENABLED: 'false' }));
    expect(svc.isEnabled()).toBe(false);
    await expect(svc.registerIssuer('did:algo:foo')).resolves.toBeUndefined();
    await expect(svc.assertIssuerTrusted('did:algo:foo')).resolves.toBe(true);
  });

  it('is a no-op when enabled but misconfigured', async () => {
    const svc = new CredeblTrustRegistryService(
      makeConfig({ CREDEBL_BASE_URL: '', CREDEBL_ORG_ID: '', CREDEBL_API_KEY: '' }),
    );
    expect(svc.isEnabled()).toBe(false);
    await expect(svc.registerIssuer('did:algo:foo')).resolves.toBeUndefined();
  });

  it('publishes the issuer + credential configurations on boot', async () => {
    const { transport, calls } = makeTransport(({ method, path }) => {
      if (method === 'POST' && path.endsWith('/issuers')) return { status: 201 };
      if (method === 'POST' && path.includes('/credential-configurations')) return { status: 201 };
      return { status: 500 };
    });
    const svc = new CredeblTrustRegistryService(makeConfig());
    // Inject the transport by replacing the lazily-built client.
    (svc as unknown as { client?: unknown }).client =
      new // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./credebl.client') as typeof import('./credebl.client')).CredeblClient({
        baseUrl: 'https://credebl.test',
        orgId: 'org-1',
        apiKey: 'key-1',
        transport,
      });
    await svc.registerIssuer('did:algo:abc');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/orgs/org-1/issuers' });
    expect(calls.slice(1).every((c) => c.method === 'POST' && c.path.includes('/credential-configurations'))).toBe(
      true,
    );
    // Idempotent re-call.
    const beforeLen = calls.length;
    await svc.registerIssuer('did:algo:abc');
    expect(calls.length).toBe(beforeLen);
  });

  it('treats 409 on registration as success', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 409 }));
    const svc = new CredeblTrustRegistryService(makeConfig());
    (svc as unknown as { client?: unknown }).client =
      new // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./credebl.client') as typeof import('./credebl.client')).CredeblClient({
        baseUrl: 'https://credebl.test',
        orgId: 'org-1',
        apiKey: 'key-1',
        transport,
      });
    await expect(svc.registerIssuer('did:algo:abc')).resolves.toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('swallows registration errors and stays unregistered for retry', async () => {
    const { transport } = makeTransport(() => ({ status: 500, body: { error: 'boom' } }));
    const svc = new CredeblTrustRegistryService(makeConfig());
    (svc as unknown as { client?: unknown }).client =
      new // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./credebl.client') as typeof import('./credebl.client')).CredeblClient({
        baseUrl: 'https://credebl.test',
        orgId: 'org-1',
        apiKey: 'key-1',
        transport,
      });
    await expect(svc.registerIssuer('did:algo:abc')).resolves.toBeUndefined();
    expect((svc as unknown as { registered: boolean }).registered).toBe(false);
  });

  it('passes trusted issuers through assertIssuerTrusted', async () => {
    const { transport } = makeTransport(({ method, path }) => {
      if (method === 'GET' && path.endsWith('/issuers/did%3Aalgo%3Aabc')) {
        return { status: 200, body: { trusted: true } };
      }
      if (method === 'GET' && path.includes('/credential-configurations/')) {
        return { status: 200 };
      }
      return { status: 404 };
    });
    const svc = new CredeblTrustRegistryService(makeConfig());
    (svc as unknown as { client?: unknown }).client =
      new // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./credebl.client') as typeof import('./credebl.client')).CredeblClient({
        baseUrl: 'https://credebl.test',
        orgId: 'org-1',
        apiKey: 'key-1',
        transport,
      });
    await expect(svc.assertIssuerTrusted('did:algo:abc', 'IntermezzoReward')).resolves.toBe(true);
  });

  it('throws on untrusted issuer when fail-closed', async () => {
    const { transport } = makeTransport(() => ({ status: 404 }));
    const svc = new CredeblTrustRegistryService(makeConfig());
    (svc as unknown as { client?: unknown }).client =
      new // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./credebl.client') as typeof import('./credebl.client')).CredeblClient({
        baseUrl: 'https://credebl.test',
        orgId: 'org-1',
        apiKey: 'key-1',
        transport,
      });
    await expect(svc.assertIssuerTrusted('did:algo:abc')).rejects.toThrow(/rejected issuer/);
  });

  it('returns false (no throw) when fail-closed is disabled', async () => {
    const { transport } = makeTransport(() => ({ status: 404 }));
    const svc = new CredeblTrustRegistryService(makeConfig({ CREDEBL_VERIFY_FAIL_CLOSED: 'false' }));
    (svc as unknown as { client?: unknown }).client =
      new // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./credebl.client') as typeof import('./credebl.client')).CredeblClient({
        baseUrl: 'https://credebl.test',
        orgId: 'org-1',
        apiKey: 'key-1',
        transport,
      });
    await expect(svc.assertIssuerTrusted('did:algo:abc')).resolves.toBe(false);
  });
});
