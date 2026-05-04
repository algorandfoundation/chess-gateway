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
   */
  async upsert(userId: string, id: string, isVerified = true, walletAddress?: string): Promise<LinkVerification> {
    let verification = await this.findByUserId(userId);

    if (verification) {
      verification.id = id;
      verification.associatedAt = new Date();
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
