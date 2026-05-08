import { Injectable, Logger } from '@nestjs/common';
import { auth } from './auth';
import { VerificationService } from './verification/verification.service';

/**
 * Email ↔ Vault `userId` resolution.
 *
 * Source of truth:
 *  - `link_verification` (TypeORM) holds the persistent
 *    `id` (vault userId) ↔ `userId` (better-auth user id) mapping.
 *  - The better-auth `user` table holds the canonical email for each
 *    better-auth user id.
 *
 * Composing those two tables gives us `email ↔ vault userId` without
 * requiring a separate identity-binding table. The previous
 * `intermezzo_identity` better-auth plugin schema has been retired in
 * favour of this composition (see {@link IntermezzoProvisionerService}
 * for the bootstrap-time provisioning that maintains it).
 */
@Injectable()
export class IdentityService {
  private static readonly logger = new Logger(IdentityService.name);

  constructor(private readonly verificationService: VerificationService) {}

  /** Resolve the better-auth adapter from the live `auth` instance. */
  private async getAdapter(): Promise<any> {
    const ctx: any = await (auth as any).$context;
    return ctx.adapter;
  }

  /** Look up a better-auth user row by email. */
  private async findBetterAuthUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string } | null> {
    const adapter = await this.getAdapter();
    return adapter.findOne({
      model: 'user',
      where: [{ field: 'email', value: email.toLowerCase() }],
    });
  }

  /** Look up a better-auth user row by primary key. */
  private async findBetterAuthUserById(
    userId: string,
  ): Promise<{ id: string; email: string } | null> {
    const adapter = await this.getAdapter();
    return adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    });
  }

  /** Resolve the email bound to a Vault `userId` (transit-key name). */
  async getUserEmail(userId: string): Promise<string | null> {
    try {
      const verification = await this.verificationService.findOne(userId);
      const beUser = await this.findBetterAuthUserById(verification.userId);
      return beUser?.email ?? null;
    } catch (err: any) {
      IdentityService.logger.warn(
        `getUserEmail(${userId}) failed: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /** Resolve the Vault `userId` (transit-key name) bound to an email. */
  async getUserIdByEmail(email: string): Promise<string | null> {
    try {
      const beUser = await this.findBetterAuthUserByEmail(email);
      if (!beUser) return null;
      const verification = await this.verificationService.findByUserId(beUser.id);
      return verification?.id ?? null;
    } catch (err: any) {
      IdentityService.logger.warn(
        `getUserIdByEmail(${email}) failed: ${err?.message ?? err}`,
      );
      return null;
    }
  }
}
