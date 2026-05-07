import type { Repository } from 'typeorm';

import { Oid4vcVaultKeyBinding } from '../entities/oid4vc-vault-key-binding.entity';

/**
 * Process-singleton bridge between Credo's wallet (constructed by Credo's
 * own tsyringe container) and the rest of the Nest world.
 *
 * The Askar wallet — and our {@link VaultAskarWallet} subclass that overrides
 * `sign` for Vault-held keys — is instantiated by Credo, not by Nest, so we
 * cannot inject Nest providers into it directly. Instead, the Nest module
 * sets a TypeORM repository and a Vault signer on this singleton at boot,
 * and the wallet reaches in for both at sign time.
 *
 * Persistence model:
 *   - The mapping `publicKeyBase58 → { vaultKeyName, transitPath }` lives in
 *     the {@link Oid4vcVaultKeyBinding} table.
 *   - An in-process LRU-ish cache (a plain `Map`, sufficient for a small
 *     working set of issuer + a hot subset of users) backs the read path so
 *     the common case is a single in-memory lookup, not a SQL query.
 *   - Writes are write-through: `bind()` updates the cache and persists the
 *     row in the same call. Idempotent on `publicKeyBase58`.
 *
 * Replaces the previous in-memory-only registry plus `Oid4vcAgentProvider#rehydrateVaultBindings`
 * boot-time loop, which is no longer needed because bindings now survive
 * process restarts.
 */

/** Identifier for a Vault-held key plus the transit-engine path it lives under. */
export interface VaultKeyBinding {
  /** Vault transit key name (e.g. the platform user id, or a synthetic issuer id). */
  vaultKeyName: string;
  /** Vault transit mount + path, e.g. `pawn/users`. */
  transitPath: string;
}

/**
 * Signer callback the wallet invokes when a binding matches. Implementations
 * are expected to call Vault `transit/sign/<keyName>` and return the raw
 * 64-byte ed25519 signature (no `vault:v1:` prefix).
 */
export type VaultSigner = (binding: VaultKeyBinding, data: Uint8Array) => Promise<Uint8Array>;

/** Subset of the TypeORM `Repository` API the registry actually uses. */
export type VaultKeyBindingRepository = Pick<
  Repository<Oid4vcVaultKeyBinding>,
  'findOneBy' | 'save' | 'delete'
>;

const cache = new Map<string, VaultKeyBinding>();
let signer: VaultSigner | undefined;
let repository: VaultKeyBindingRepository | undefined;

export const vaultSigningRegistry = {
  /**
   * Register the publicKey → Vault-binding mapping. Idempotent: if a row
   * already exists for this key, it is updated. Cache is updated
   * synchronously so subsequent reads in the same request avoid the DB.
   */
  async bind(publicKeyBase58: string, binding: VaultKeyBinding): Promise<void> {
    cache.set(publicKeyBase58, binding);
    if (!repository) {
      // No repo wired yet (typical in unit tests that exercise only the
      // cache). Fall back to in-memory-only behaviour so callers don't
      // crash when the persistence layer hasn't been initialised.
      return;
    }
    await repository.save({
      publicKeyBase58,
      vaultKeyName: binding.vaultKeyName,
      transitPath: binding.transitPath,
    } as Oid4vcVaultKeyBinding);
  },

  /**
   * Look up a previously registered binding. Hot path: returns the cached
   * value without awaiting the DB when a hit exists. Cache misses fall
   * back to a single indexed lookup against the binding table and warm
   * the cache for next time.
   */
  async getBinding(publicKeyBase58: string): Promise<VaultKeyBinding | undefined> {
    const cached = cache.get(publicKeyBase58);
    if (cached) return cached;
    if (!repository) return undefined;
    const row = await repository.findOneBy({ publicKeyBase58 });
    if (!row) return undefined;
    const binding: VaultKeyBinding = {
      vaultKeyName: row.vaultKeyName,
      transitPath: row.transitPath,
    };
    cache.set(publicKeyBase58, binding);
    return binding;
  },

  /** Remove a binding (used by tests and by future deactivate flows). */
  async unbind(publicKeyBase58: string): Promise<void> {
    cache.delete(publicKeyBase58);
    if (repository) {
      await repository.delete({ publicKeyBase58 });
    }
  },

  /**
   * Set the global Vault signer. The agent provider calls this once at
   * startup with a closure that knows how to obtain a Vault token and
   * call `VaultService.sign`.
   */
  setSigner(s: VaultSigner): void {
    signer = s;
  },

  /**
   * Set the TypeORM repository the registry uses for write-through and
   * cache-miss reads. The agent provider calls this once at startup with
   * the Nest-managed repository for {@link Oid4vcVaultKeyBinding}.
   */
  setRepository(r: VaultKeyBindingRepository): void {
    repository = r;
  },

  /** Sign with Vault. Throws if no signer has been registered. */
  async sign(binding: VaultKeyBinding, data: Uint8Array): Promise<Uint8Array> {
    if (!signer) {
      throw new Error(
        'vaultSigningRegistry: no signer registered. Oid4vcAgentProvider.onModuleInit must call setSigner(...) before any credential signing.',
      );
    }
    return signer(binding, data);
  },

  /** Test-only: drop all bindings + the signer + the repository. */
  reset(): void {
    cache.clear();
    signer = undefined;
    repository = undefined;
  },
};

/**
 * Vault returns ed25519 signatures as `vault:v1:<base64>` strings (where the
 * base64 payload is the raw 64-byte signature). This helper normalises them.
 */
export function parseVaultSignature(signature: string): Uint8Array {
  // Vault prefixes signatures with the key version: `vault:v<version>:<b64>`.
  // We strip everything up to the last colon to be tolerant of future
  // versions while still failing loudly on a totally unexpected shape.
  const lastColon = signature.lastIndexOf(':');
  if (lastColon < 0 || !signature.startsWith('vault:')) {
    throw new Error(`parseVaultSignature: unexpected Vault signature format: ${signature.slice(0, 32)}…`);
  }
  const b64 = signature.slice(lastColon + 1);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length !== 64) {
    throw new Error(
      `parseVaultSignature: expected 64-byte ed25519 signature, got ${bytes.length} bytes (b64=${b64.slice(0, 16)}…)`,
    );
  }
  return new Uint8Array(bytes);
}
