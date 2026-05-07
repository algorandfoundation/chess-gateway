import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Oid4vcUserDeviceManifestRevision } from './oid4vc-user-device-manifest-revision.entity';

/**
 * One row per (user, did:key) pair seen by the platform.
 *
 * Created on the link-attestation seed path (the only place an unknown
 * `did:key` is allowed to bootstrap a manifest). Subsequent revisions
 * are appended to {@link Oid4vcUserDeviceManifestRevision}; this row
 * just tracks "which revision is currently live" plus the trust
 * lifecycle.
 *
 * See `src/oid4vc/DISCOVERY.md` for the full design.
 */
@Entity('oid4vc_user_device_manifest')
@Index(['userId', 'didKey'], { unique: true })
export class Oid4vcUserDeviceManifest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Better Auth user id the manifest belongs to.
   */
  @Index()
  @Column()
  userId: string;

  /**
   * The wallet's primary `did:key` identifier (multibase-encoded
   * Ed25519 public key with the standard `did:key:z…` prefix).
   */
  @Index({ unique: true })
  @Column()
  didKey: string;

  /**
   * Pointer to the currently-live revision. Null only during the
   * initial transactional insert before the first revision row exists.
   */
  @OneToOne(() => Oid4vcUserDeviceManifestRevision, { nullable: true })
  @JoinColumn({ name: 'currentRevisionId' })
  currentRevision?: Oid4vcUserDeviceManifestRevision | null;

  @Column({ nullable: true })
  currentRevisionId?: string | null;

  /**
   * Set when the link-attestation flow accepted this `did:key`. The
   * presence of `trustedAt` is what makes the manifest eligible to
   * receive subsequent (non-seed) updates.
   */
  @Column({ type: 'datetime' })
  trustedAt: Date;

  /**
   * Soft-delete marker for device-loss / re-link flows. A revoked
   * manifest is preserved (so we can answer "this credential's binding
   * was revoked at T") but no further revisions are accepted.
   */
  @Column({ type: 'datetime', nullable: true })
  revokedAt?: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
