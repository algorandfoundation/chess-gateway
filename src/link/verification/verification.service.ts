import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LinkVerification } from './entities/link-verification.entity';

@Injectable()
export class VerificationService {
  constructor(
    @InjectRepository(LinkVerification)
    private readonly linkVerificationRepository: Repository<LinkVerification>,
  ) {}

  /**
   * Retrieves all link verifications.
   */
  async findAll(): Promise<LinkVerification[]> {
    return this.linkVerificationRepository.find();
  }

  /**
   * Retrieves a specific link verification by ID (vault player ID).
   */
  async findOne(id: string): Promise<LinkVerification> {
    const verification = await this.linkVerificationRepository.findOneBy({ id });
    if (!verification) {
      throw new NotFoundException(`LinkVerification with ID ${id} not found.`);
    }
    return verification;
  }

  /**
   * Retrieves the mapping for a specific authenticated user.
   */
  async findByUserId(userId: string): Promise<LinkVerification | null> {
    return this.linkVerificationRepository.findOneBy({ userId });
  }

  /**
   * Resolve a public-facing user identifier to the canonical vault user id.
   *
   * Wallet/DID URL params (`/wallet/assets/:user_id`, `/did/users/:user_id`,
   * …) accept either:
   *  - the **vault user id** (used as the transit key name in Vault), or
   *  - the **Better-Auth user id** (carried in JWTs after a UI sign-in).
   *
   * When a `LinkVerification` row maps the supplied Better-Auth `userId` to
   * a vault `id`, we return that vault id; otherwise we treat the input as
   * already being a vault id and return it unchanged. This keeps every
   * downstream Vault/Chain lookup keyed by the vault id while letting the
   * UI pass whichever identifier it has.
   */
  async resolveVaultUserId(idOrAuthUserId: string): Promise<string> {
    if (!idOrAuthUserId) return idOrAuthUserId;
    const verification = await this.findByUserId(idOrAuthUserId);
    return verification?.id ?? idOrAuthUserId;
  }

  /**
   * Retrieves all link verifications for a specific vault player ID.
   */
  async findByPlayerId(id: string): Promise<LinkVerification[]> {
    return this.linkVerificationRepository.findBy({ id });
  }

  /**
   * Creates a new link verification.
   */
  async create(data: Partial<LinkVerification>): Promise<LinkVerification> {
    const verification = this.linkVerificationRepository.create(data);
    return this.linkVerificationRepository.save(verification);
  }

  /**
   * Updates a link verification by ID.
   */
  async update(id: string, data: Partial<LinkVerification>): Promise<LinkVerification> {
    const verification = await this.findOne(id);
    Object.assign(verification, data);
    return this.linkVerificationRepository.save(verification);
  }

  /**
   * Deletes a link verification by ID.
   */
  async remove(id: string): Promise<void> {
    const result = await this.linkVerificationRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`LinkVerification with ID ${id} not found.`);
    }
  }

  /**
   * Upserts a link verification for a user.
   *
   * `isVerified` defaults to `false` — verification is only granted
   * after a successful device + did:key manifest attestation
   * (`LinkService.linkResponse`). All other call sites (the
   * Better-Auth user-create hook, manager-driven provisioning,
   * pre-attestation auto-association, …) should leave it `false`.
   */
  async upsert(userId: string, id: string, isVerified = false, walletAddress?: string): Promise<LinkVerification> {
    let verification = await this.findByUserId(userId);

    if (verification) {
      verification.id = id;
      verification.associatedAt = new Date();
      // Honour the supplied flag explicitly: pre-attestation flows
      // (hook / manager provisioning) keep it `false`, the device +
      // manifest attestation flow flips it to `true`.
      verification.isVerified = isVerified;
    } else {
      verification = this.linkVerificationRepository.create({
        userId,
        id,
        isVerified,
      });
    }

    if (walletAddress) {
      verification.walletAddress = walletAddress;
    }

    return this.linkVerificationRepository.save(verification);
  }
}
