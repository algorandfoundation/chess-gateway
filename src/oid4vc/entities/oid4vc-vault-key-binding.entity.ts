import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Persistent mapping between an Ed25519 public key (as Credo sees it on the
 * wallet's `Key`) and the HashiCorp Vault transit key that owns the matching
 * private half.
 *
 * Why a dedicated table:
 *
 * The `VaultAskarWallet` overrides `sign` and routes Ed25519 signatures to
 * Vault, but `WalletSignOptions` only carries `publicKeyBase58` — there is
 * no field for "the Vault key name". The previous implementation kept this
 * mapping in a process-local `Map` and rebuilt it on every boot by walking
 * `did_records` and querying Vault for each one (`Oid4vcAgentProvider#rehydrateVaultBindings`).
 * That works for small deployments but is O(n) Vault reads per restart and
 * doesn't survive a stale token at boot. Persisting the mapping locally lets
 * the wallet do a single indexed lookup at signing time and removes the
 * boot-time rehydration loop entirely.
 *
 * Rows are written by {@link AlgoDidRegistrar} when a `did:algo` is created
 * (or reused) and by {@link Oid4vcAgentProvider} when the issuer DID's
 * binding is materialised. They are read by `VaultAskarWallet` on every
 * Ed25519 sign call (cached in-process after the first hit).
 */
@Entity('oid4vc_vault_key_binding')
export class Oid4vcVaultKeyBinding {
  /**
   * Base58-encoded ed25519 public key. Matches the value Credo's wallet
   * exposes via `Key.publicKeyBase58`, which is what `VaultAskarWallet#sign`
   * is given at sign time. Used as the primary key because it's the only
   * identifier the wallet has access to in that path.
   */
  @PrimaryColumn()
  publicKeyBase58: string;

  /**
   * Vault transit key name (typically the platform user id, or the manager
   * key name for the issuer DID).
   */
  @Index()
  @Column()
  vaultKeyName: string;

  /**
   * Vault transit mount + path that holds the key, e.g. `pawn/users` or
   * `pawn/managers`. Stored alongside the key name so the wallet can call
   * `transit/sign/<path>/<name>` without having to consult `ConfigService`.
   */
  @Column()
  transitPath: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
