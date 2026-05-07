import { vaultSigningRegistry, parseVaultSignature } from './vault-signing-registry';
import type { VaultKeyBindingRepository } from './vault-signing-registry';
import { Oid4vcVaultKeyBinding } from '../entities/oid4vc-vault-key-binding.entity';

describe('vaultSigningRegistry', () => {
  beforeEach(() => vaultSigningRegistry.reset());

  it('stores and retrieves bindings by publicKeyBase58 (cache-only when no repo is set)', async () => {
    await vaultSigningRegistry.bind('pkA', { vaultKeyName: 'k1', transitPath: 'pawn/users' });
    await expect(vaultSigningRegistry.getBinding('pkA')).resolves.toEqual({
      vaultKeyName: 'k1',
      transitPath: 'pawn/users',
    });
    await expect(vaultSigningRegistry.getBinding('pkB')).resolves.toBeUndefined();
  });

  it('overrides bindings on re-bind (idempotent for the same key)', async () => {
    await vaultSigningRegistry.bind('pk', { vaultKeyName: 'old', transitPath: 'p' });
    await vaultSigningRegistry.bind('pk', { vaultKeyName: 'new', transitPath: 'p' });
    await expect(vaultSigningRegistry.getBinding('pk')).resolves.toMatchObject({
      vaultKeyName: 'new',
    });
  });

  it('removes bindings via unbind', async () => {
    await vaultSigningRegistry.bind('pk', { vaultKeyName: 'k', transitPath: 'p' });
    await vaultSigningRegistry.unbind('pk');
    await expect(vaultSigningRegistry.getBinding('pk')).resolves.toBeUndefined();
  });

  it('throws from sign() when no signer has been registered', async () => {
    await expect(
      vaultSigningRegistry.sign({ vaultKeyName: 'k', transitPath: 'p' }, new Uint8Array([1])),
    ).rejects.toThrow(/no signer registered/);
  });

  it('delegates to the registered signer', async () => {
    const signer = jest.fn(async (_b, _d) => new Uint8Array([9, 9, 9]));
    vaultSigningRegistry.setSigner(signer);
    const out = await vaultSigningRegistry.sign(
      { vaultKeyName: 'k', transitPath: 'p' },
      new Uint8Array([1, 2]),
    );
    expect(signer).toHaveBeenCalledWith(
      { vaultKeyName: 'k', transitPath: 'p' },
      new Uint8Array([1, 2]),
    );
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  describe('with a TypeORM repository', () => {
    // Minimal in-memory fake — exercises the write-through and cache-miss
    // fallback behaviour without spinning up sqlite.
    const buildFakeRepo = (): { repo: VaultKeyBindingRepository; rows: Map<string, Oid4vcVaultKeyBinding> } => {
      const rows = new Map<string, Oid4vcVaultKeyBinding>();
      const repo: VaultKeyBindingRepository = {
        save: jest.fn(async (entity: any) => {
          rows.set(entity.publicKeyBase58, entity as Oid4vcVaultKeyBinding);
          return entity;
        }) as any,
        findOneBy: jest.fn(async (where: any) => rows.get(where.publicKeyBase58) ?? null) as any,
        delete: jest.fn(async (where: any) => {
          rows.delete(where.publicKeyBase58);
          return { affected: 1 } as any;
        }) as any,
      };
      return { repo, rows };
    };

    it('persists bindings through bind() (write-through)', async () => {
      const { repo, rows } = buildFakeRepo();
      vaultSigningRegistry.setRepository(repo);

      await vaultSigningRegistry.bind('pk-persist', { vaultKeyName: 'kn', transitPath: 'pawn/users' });

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(rows.get('pk-persist')).toMatchObject({
        publicKeyBase58: 'pk-persist',
        vaultKeyName: 'kn',
        transitPath: 'pawn/users',
      });
    });

    it('falls back to the repository when the cache misses, and warms the cache', async () => {
      const { repo } = buildFakeRepo();
      // Pre-seed a row directly (simulates a previous process having
      // persisted a binding before this one started).
      (repo.save as jest.Mock).mock.calls.length;
      await repo.save({
        publicKeyBase58: 'pk-cold',
        vaultKeyName: 'kn-cold',
        transitPath: 'pawn/users',
      } as Oid4vcVaultKeyBinding);
      vaultSigningRegistry.setRepository(repo);

      // First lookup: cache miss → DB hit.
      const first = await vaultSigningRegistry.getBinding('pk-cold');
      expect(first).toEqual({ vaultKeyName: 'kn-cold', transitPath: 'pawn/users' });
      expect(repo.findOneBy).toHaveBeenCalledTimes(1);

      // Second lookup: served from cache, no extra DB call.
      const second = await vaultSigningRegistry.getBinding('pk-cold');
      expect(second).toEqual({ vaultKeyName: 'kn-cold', transitPath: 'pawn/users' });
      expect(repo.findOneBy).toHaveBeenCalledTimes(1);
    });

    it('unbind() deletes the row and the cache entry', async () => {
      const { repo, rows } = buildFakeRepo();
      vaultSigningRegistry.setRepository(repo);
      await vaultSigningRegistry.bind('pk-rm', { vaultKeyName: 'kn', transitPath: 'p' });
      await vaultSigningRegistry.unbind('pk-rm');
      expect(rows.has('pk-rm')).toBe(false);
      await expect(vaultSigningRegistry.getBinding('pk-rm')).resolves.toBeUndefined();
    });
  });
});

describe('parseVaultSignature', () => {
  it('parses a valid vault:v1:<b64> signature into 64 raw bytes', () => {
    const raw = Buffer.alloc(64, 0x42);
    const wire = `vault:v1:${raw.toString('base64')}`;
    const out = parseVaultSignature(wire);
    expect(out).toEqual(new Uint8Array(raw));
  });

  it('tolerates higher key versions in the prefix', () => {
    const raw = Buffer.alloc(64, 0x07);
    const wire = `vault:v17:${raw.toString('base64')}`;
    expect(parseVaultSignature(wire)).toEqual(new Uint8Array(raw));
  });

  it('rejects signatures missing the vault: prefix', () => {
    expect(() => parseVaultSignature('plain:base64data==')).toThrow(/unexpected Vault signature/);
  });

  it('rejects signatures whose payload is not 64 bytes', () => {
    const wire = `vault:v1:${Buffer.alloc(32, 0).toString('base64')}`;
    expect(() => parseVaultSignature(wire)).toThrow(/expected 64-byte ed25519 signature/);
  });
});
