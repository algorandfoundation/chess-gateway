import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Application-level mapping for an OID4VP verification session.
 *
 * Credo holds the canonical OpenId4VcVerificationSessionRecord; this entity is
 * for our business-level correlation (which user requested verification, what
 * presentation definition was used, current state, last verified payload).
 */
@Entity('oid4vc_verification_session')
export class Oid4vcVerificationSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Identifier of the Credo OpenId4VcVerificationSessionRecord.
   */
  @Index()
  @Column({ nullable: true })
  credoVerificationSessionId?: string;

  /**
   * Verifier record id used inside Credo (`OpenId4VcVerifierRecord.verifierId`).
   */
  @Column()
  verifierId: string;

  /**
   * Application user (Better Auth user id) initiating the verification, if any.
   */
  @Index()
  @Column({ nullable: true })
  userId?: string;

  /**
   * Encoded `openid4vp://` (or `openid://`) authorization request URI to render
   * as a QR code for the wallet.
   */
  @Column({ type: 'text' })
  authorizationRequest: string;

  /**
   * The DIF presentation definition that was requested.
   */
  @Column({ type: 'simple-json', nullable: true })
  presentationDefinition?: Record<string, unknown>;

  @Column({ default: 'RequestCreated' })
  state: string;

  /**
   * Once the wallet responds with a presentation and Credo verifies it, the
   * extracted claims are persisted here so downstream business logic can react.
   */
  @Column({ type: 'simple-json', nullable: true })
  verifiedClaims?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
