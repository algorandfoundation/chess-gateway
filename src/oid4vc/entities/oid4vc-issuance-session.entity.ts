import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Application-level mapping for an OID4VCI issuance session.
 *
 * Credo persists the canonical session state inside its own (Askar) wallet.
 * This entity stores additional business context (which user the offer was created
 * for, which credential configuration was offered, current status) so that other
 * Nest modules can correlate Credo records with our domain without depending on
 * Credo internals.
 */
@Entity('oid4vc_issuance_session')
export class Oid4vcIssuanceSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Identifier of the Credo OpenId4VcIssuanceSessionRecord. Filled in once the
   * Credo agent has produced the offer and given us its session id.
   */
  @Index()
  @Column({ nullable: true })
  credoIssuanceSessionId?: string;

  /**
   * Issuer record id used inside Credo (matches `OpenId4VcIssuerRecord.issuerId`).
   */
  @Column()
  issuerId: string;

  /**
   * Application user (Better Auth user id) the offer was created for.
   */
  @Index()
  @Column({ nullable: true })
  userId?: string;

  /**
   * Credential configuration ids that were offered.
   */
  @Column({ type: 'simple-json' })
  offeredCredentialConfigurationIds: string[];

  /**
   * Pre-authorized code or transaction code if any. Stored only for traceability
   * - Credo holds the authoritative copy.
   */
  @Column({ nullable: true })
  preAuthorizedCode?: string;

  /**
   * Full credential offer URI returned to the wallet (use this to render QR).
   */
  @Column({ type: 'text' })
  credentialOffer: string;

  @Column({ default: 'OfferCreated' })
  state: string;

  /**
   * Free-form metadata persisted alongside the offer (e.g. the actual claim
   * payload that should be issued when the wallet redeems the offer).
   */
  @Column({ type: 'simple-json', nullable: true })
  issuanceMetadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
