import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { auth } from './auth';
import { VerificationService } from './verification/verification.service';
import { WalletService } from '../wallet/wallet.service';

/**
 * Bootstraps Intermezzo wallet provisioning at application start.
 *
 * Replaces the previous `intermezzoIdentity` better-auth plugin (which
 * owned its own `intermezzo_identity` table) with a far simpler model:
 *
 *  - The persistent mapping between a better-auth user and a Vault
 *    transit key already exists in `link_verification` (TypeORM).
 *  - On startup we walk every better-auth `user` row, and for any user
 *    that does not yet have a `LinkVerification` we mint a Vault
 *    transit key (via `WalletService.userCreate`) and write the
 *    binding row.
 *
 * This is idempotent — users already linked are skipped, and Vault's
 * transit-key creation is itself idempotent for an already-existing
 * key name. Failures are logged but never fail the boot, so a missing
 * `INTERMEZZO_MANAGER_TOKEN` (or transient Vault unavailability) only
 * defers provisioning to the next restart.
 *
 * The Vault token used is the operator-supplied `INTERMEZZO_MANAGER_TOKEN`,
 * the same env var the UI uses for server-to-server calls.
 */
@Injectable()
export class IntermezzoProvisionerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntermezzoProvisionerService.name);

  constructor(
    private readonly verificationService: VerificationService,
    private readonly walletService: WalletService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const managerToken = process.env.INTERMEZZO_MANAGER_TOKEN;
    if (!managerToken) {
      this.logger.warn(
        'INTERMEZZO_MANAGER_TOKEN not set — skipping startup vault provisioning',
      );
      return;
    }

    let users: Array<{ id: string; email: string }> = [];
    try {
      const ctx: any = await (auth as any).$context;
      users = await ctx.adapter.findMany({ model: 'user' });
    } catch (err: any) {
      this.logger.warn(
        `Could not enumerate better-auth users: ${err?.message ?? err}`,
      );
      return;
    }

    if (!users.length) {
      this.logger.log('No better-auth users to provision');
      return;
    }

    let provisioned = 0;
    for (const user of users) {
      try {
        const existing = await this.verificationService.findByUserId(user.id);
        if (existing) continue;
        const vaultUserId = this.deriveVaultUserId(user.email, user.id);
        await this.walletService.userCreate(vaultUserId, managerToken);
        await this.verificationService.upsert(user.id, vaultUserId, true);
        provisioned += 1;
        this.logger.log(
          `Provisioned vault user '${vaultUserId}' for ${user.email} (be:${user.id})`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Provisioning failed for ${user.email ?? user.id}: ${err?.message ?? err}`,
        );
      }
    }

    if (provisioned > 0) {
      this.logger.log(`Bootstrap provisioning complete: ${provisioned} new user(s)`);
    }
  }

  /**
   * Derive a stable Vault transit-key name from the email's local part,
   * falling back to the better-auth id. Sanitised to the character set
   * Vault transit accepts.
   */
  private deriveVaultUserId(email: string | undefined, fallback: string): string {
    const candidate = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
    const sanitised = candidate.replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
    return sanitised || `user_${fallback.slice(0, 16)}`;
  }
}
