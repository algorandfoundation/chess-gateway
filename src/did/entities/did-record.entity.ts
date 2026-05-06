import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Cached copy of a user's DID document published on the `did:algo`
 * registry. The agent service uses this both as a publisher
 * (storing the document at publish time) and as a local resolver —
 * sparing callers a round-trip to the universal resolver / chain
 * when we already hold the document in memory. A row exists if and
 * only if the on-chain document exists for the user.
 */
@Entity('did_records')
export class DidRecord {
  /** Vault user id this record belongs to. */
  @PrimaryColumn({ type: 'varchar' })
  user_id: string;

  /** Fully-qualified `did:algo:<network>:app:<app-id>:<hex-pubkey>` identifier. */
  @Column({ type: 'varchar' })
  did: string;

  /** Algorand genesis id used to compute the DID network segment. */
  @Column({ type: 'varchar' })
  network: string;

  /** App id of the `DIDAlgoStorage` smart contract that hosts the document. */
  @Column({ type: 'bigint' })
  app_id: string;

  /** JSON-encoded DID document published on chain. */
  @Column({ type: 'text' })
  document: string;

  /** Comma-separated list of confirmed transaction ids from the publish flow. */
  @Column({ type: 'text', nullable: true })
  tx_ids: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
