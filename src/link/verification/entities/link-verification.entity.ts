import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity()
export class LinkVerification {
  @PrimaryColumn()
  id: string; // user_id from Vault

  @Column()
  userId: string; // ID from Better Auth

  @Column({ default: false })
  isVerified: boolean;

  @Column({ nullable: true })
  walletAddress: string;

  @CreateDateColumn()
  associatedAt: Date;
}
