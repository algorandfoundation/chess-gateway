import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Oid4vcUserDeviceManifest } from './oid4vc-user-device-manifest.entity';

/**
 * Append-only history of {@link Oid4vcUserDeviceManifest} versions.
 *
 * One row per signed manifest the wallet has pushed. Rows are never
 * mutated — the parent manifest's `currentRevisionId` is what moves.
 * This gives us:
 *
 * - replay protection (`(manifestId, version)` is unique),
 * - an audit trail for credential bindings ("the cnf was valid as of
 *   revision N"), and
 * - a soft-revocation surface ("subkey X is no longer in the current
 *   revision, so credentials bound to it should not be honoured").
 *
 * See `src/oid4vc/DISCOVERY.md`.
 */
@Entity('oid4vc_user_device_manifest_revision')
@Unique(['manifestId', 'version'])
export class Oid4vcUserDeviceManifestRevision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  manifestId: string;

  @ManyToOne(() => Oid4vcUserDeviceManifest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'manifestId' })
  manifest?: Oid4vcUserDeviceManifest;

  /**
   * Wallet-assigned monotonic version. Equal versions are no-ops, lower
   * versions are rejected with 409.
   */
  @Column({ type: 'integer' })
  version: number;

  /**
   * The full DID Document as the wallet sent it, stored verbatim so we
   * can re-verify the signature later if needed.
   */
  @Column({ type: 'simple-json' })
  document: Record<string, unknown>;

  /**
   * Base64-encoded Ed25519 signature over the JCS canonicalisation of
   * `{ didKey, version, signedAt, didDocument }`.
   */
  @Column({ type: 'text' })
  signature: string;

  /**
   * Wallet-supplied wall-clock at signing time (debug-only; not
   * security-critical).
   */
  @Column({ type: 'datetime' })
  signedAt: Date;

  @CreateDateColumn()
  receivedAt: Date;
}
