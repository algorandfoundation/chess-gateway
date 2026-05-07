import { ConfigService } from '@nestjs/config';
import { DidRepository, TypedArrayEncoder } from '@credo-ts/core';

import { AlgoDidRegistrar } from './algo-did.registrar';
import type { AlgoDidCreateOptions, AlgoDidDeactivateOptions } from './algo-did.registrar';
import { DidService } from '../../did/did.service';
import { VaultService } from '../../vault/vault.service';
import { AlgoVaultTokenProvider } from './algo-vault-token.provider';
import { vaultSigningRegistry } from './vault-signing-registry';

describe('AlgoDidRegistrar', () => {
  // 32-byte ed25519 public key (all 0xbb) — base58 of 32 0xbb bytes is stable.
  const PUBLIC_KEY_HEX = 'b'.repeat(64);
  const PUBLIC_KEY = Buffer.from(PUBLIC_KEY_HEX, 'hex');
  const PUBLISHED_DID = `did:algo:testnet:app:42:${PUBLIC_KEY_HEX}`;
  const TRANSIT_PATH = 'pawn/users';

  const didRepoSave = jest.fn();
  const didRepository = { save: didRepoSave } as unknown as DidRepository;

  const dependencyManager = {
    resolve: jest.fn((token: unknown) => {
      if (token === DidRepository) return didRepository;
      throw new Error(`unexpected resolve(${String(token)})`);
    }),
  };
  // The registrar no longer touches the agent wallet for key generation, but
  // we still pass an agentContext shape so DidRepository resolution works.
  const agentContext = { dependencyManager } as never;

  const didService = {
    publishUserDid: jest.fn(),
    deleteUserDid: jest.fn(),
    listRecords: jest.fn(),
  } as unknown as DidService;

  const vaultService = {
    getKey: jest.fn(),
    transitCreateKey: jest.fn(),
  } as unknown as VaultService;

  const tokenProvider = {
    getToken: jest.fn(async () => 'vault-token'),
    isConfigured: jest.fn(() => true),
  } as unknown as AlgoVaultTokenProvider;

  const configService = {
    get: jest.fn((key: string) => (key === 'VAULT_TRANSIT_USERS_PATH' ? TRANSIT_PATH : undefined)),
  } as unknown as ConfigService;

  let registrar: AlgoDidRegistrar;

  beforeEach(() => {
    jest.clearAllMocks();
    vaultSigningRegistry.reset();
    registrar = new AlgoDidRegistrar(didService, tokenProvider, vaultService, configService);
  });

  describe('create', () => {
    it('fails when userId is missing', async () => {
      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: {} as never,
      } as AlgoDidCreateOptions);
      expect(r.didState.state).toBe('failed');
      expect(vaultService.getKey).not.toHaveBeenCalled();
    });

    it('fails when no transit path is configured', async () => {
      (configService.get as jest.Mock).mockReturnValueOnce(undefined);
      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: { userId: 'u-1' },
      });
      expect(r.didState.state).toBe('failed');
      expect((r.didState as { reason?: string }).reason).toContain('VAULT_TRANSIT_USERS_PATH');
    });

    it('uses the existing Vault key when one already exists, binds it, and publishes', async () => {
      (vaultService.getKey as jest.Mock).mockResolvedValue(PUBLIC_KEY);
      (didService.publishUserDid as jest.Mock).mockResolvedValue({
        did: PUBLISHED_DID,
        document: {},
        txIds: ['tx-1'],
      });

      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: { userId: 'u-1' },
      });

      expect(vaultService.getKey).toHaveBeenCalledWith('u-1', TRANSIT_PATH, 'vault-token');
      expect(vaultService.transitCreateKey).not.toHaveBeenCalled();
      expect(didService.publishUserDid).toHaveBeenCalledWith({
        userId: 'u-1',
        publicKey: new Uint8Array(PUBLIC_KEY),
        vaultToken: 'vault-token',
        force: false,
      });
      expect(didRepoSave).toHaveBeenCalledTimes(1);
      expect(r.didState.state).toBe('finished');
      expect((r.didState as { did?: string }).did).toBe(PUBLISHED_DID);

      const expectedBase58 = TypedArrayEncoder.toBase58(new Uint8Array(PUBLIC_KEY));
      await expect(vaultSigningRegistry.getBinding(expectedBase58)).resolves.toEqual({
        vaultKeyName: 'u-1',
        transitPath: TRANSIT_PATH,
      });
    });

    it('creates the Vault key on demand when getKey throws (404 / not found)', async () => {
      (vaultService.getKey as jest.Mock).mockRejectedValue(new Error('not found'));
      (vaultService.transitCreateKey as jest.Mock).mockResolvedValue(PUBLIC_KEY);
      (didService.publishUserDid as jest.Mock).mockResolvedValue({
        did: PUBLISHED_DID,
        document: {},
        txIds: ['tx-1'],
      });

      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: { userId: 'oid4vc-issuer:test' },
      });

      expect(vaultService.transitCreateKey).toHaveBeenCalledWith(
        'oid4vc-issuer:test',
        TRANSIT_PATH,
        'vault-token',
      );
      expect(r.didState.state).toBe('finished');
    });

    it('returns a failed state when DidService.publishUserDid throws', async () => {
      (vaultService.getKey as jest.Mock).mockResolvedValue(PUBLIC_KEY);
      (didService.publishUserDid as jest.Mock).mockRejectedValue(new Error('chain down'));

      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: { userId: 'u-1' },
      });
      expect(r.didState.state).toBe('failed');
      expect((r.didState as { reason?: string }).reason).toContain('chain down');
    });

    it('refuses to lazy-create when the caller supplies an explicit transitPath', async () => {
      // Issuer-DID provisioning passes a managers-path override; in that
      // mode the OID4VC AppRole has no `keys/*` write capability, so we
      // must surface a clear "key missing" error rather than silently
      // failing inside transitCreateKey.
      (vaultService.getKey as jest.Mock).mockRejectedValue(new Error('not found'));

      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: { userId: 'manager', transitPath: 'pawn/managers' },
      });

      expect(r.didState.state).toBe('failed');
      expect((r.didState as { reason?: string }).reason).toContain('pawn/managers');
      expect((r.didState as { reason?: string }).reason).toContain('lazy-create is disabled');
      expect(vaultService.transitCreateKey).not.toHaveBeenCalled();
      expect(didService.publishUserDid).not.toHaveBeenCalled();
    });

    it('returns a failed state when Vault returns a non-32-byte key', async () => {
      (vaultService.getKey as jest.Mock).mockResolvedValue(Buffer.alloc(16));
      const r = await registrar.create(agentContext, {
        method: 'algo',
        options: { userId: 'u-1' },
      });
      expect(r.didState.state).toBe('failed');
      expect((r.didState as { reason?: string }).reason).toContain('expected 32 bytes');
      expect(didService.publishUserDid).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('always returns a failed state — did:algo is immutable in this iteration', async () => {
      const r = await registrar.update();
      expect(r.didState.state).toBe('failed');
    });
  });

  describe('deactivate', () => {
    it('fails when no userId can be resolved from local records', async () => {
      (didService.listRecords as jest.Mock).mockResolvedValue([]);
      const r = await registrar.deactivate(agentContext, {
        did: PUBLISHED_DID,
      } as AlgoDidDeactivateOptions);
      expect(r.didState.state).toBe('failed');
      expect(didService.deleteUserDid).not.toHaveBeenCalled();
    });

    it('looks up the userId from local records and delegates to DidService', async () => {
      (didService.listRecords as jest.Mock).mockResolvedValue([
        { did: PUBLISHED_DID, user_id: 'u-77' },
      ]);
      (didService.deleteUserDid as jest.Mock).mockResolvedValue({
        txIds: ['tx-rm'],
        cacheRemoved: true,
      });

      const r = await registrar.deactivate(agentContext, { did: PUBLISHED_DID });
      expect(didService.deleteUserDid).toHaveBeenCalledWith('u-77', 'vault-token');
      expect(r.didState.state).toBe('finished');
    });
  });
});
