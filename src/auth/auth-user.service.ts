import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { auth } from '../link/auth';
import { VerificationService } from '../link/verification/verification.service';
import { WalletService } from '../wallet/wallet.service';
import {
  AuthUserResponseDto,
  AuthUserRole,
  CreateAuthUserDto,
  UpdateAuthUserDto,
} from './auth-user.dto';

/**
 * Server-side provisioning of Intermezzo Better-Auth users.
 *
 * Replaces the boot-time provisioner: instead of crawling the
 * Better-Auth `user` table on startup, the third-party (or the
 * manager UI) calls `POST /auth/user` whenever it needs to add
 * someone, and `PUT /auth/user/:userId` to amend their record.
 *
 * Each call performs three coordinated writes:
 *
 *   1. Better-Auth user row (via the `admin` plugin's server API,
 *      which also assigns the role).
 *   2. Vault transit key for the user (via `WalletService.userCreate`,
 *      which is idempotent against existing keys).
 *   3. `LinkVerification` row mapping Better-Auth `userId` →
 *      `vaultUserId`, so wallet-link flows can later attach a
 *      `walletAddress` without us having to mint a key on the fly.
 *
 * Managers are expected to call these endpoints whenever they need
 * to add a missing user or rebind an existing one to a different
 * vault key — there is no third-party directory to consult.
 */
@Injectable()
export class AuthUserService {
  private readonly logger = new Logger(AuthUserService.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly verificationService: VerificationService,
  ) {}

  /**
   * Creates a Better-Auth user, mints a vault wallet, and writes the
   * link verification row. The caller's `vaultToken` (taken from the
   * JWT) is the manager-scoped token used to create the transit key.
   */
  async createUser(
    dto: CreateAuthUserDto,
    vaultToken: string,
  ): Promise<AuthUserResponseDto> {
    const role: AuthUserRole = dto.role ?? 'user';

    // Passwordless system — Better-Auth's `createUser` still requires
    // a password column to be populated, so we mint a random,
    // unguessable value that is never returned to the caller. Users
    // sign in exclusively via OTP, social SSO, or passkey.
    const throwawayPassword = this.generateThrowawayPassword();

    let beUser: { id: string; email: string; name: string };
    try {
      const created: any = await (auth as any).api.createUser({
        body: {
          email: dto.email,
          name: dto.name,
          password: throwawayPassword,
          role,
        },
      });
      // `createUser` returns either `{ user }` or the user directly
      // depending on better-auth version — accept either shape.
      beUser = created?.user ?? created;
      if (!beUser?.id) {
        throw new Error('Better-Auth createUser returned no id');
      }
    } catch (err: any) {
      this.logger.error(`Better-Auth createUser failed for ${dto.email}: ${err?.message ?? err}`);
      throw new BadRequestException(
        `Could not create Better-Auth user: ${err?.message ?? 'unknown error'}`,
      );
    }

    const vaultUserId = this.normaliseVaultUserId(
      dto.vaultUserId ?? this.deriveVaultUserId(dto.email, beUser.id),
    );

    const wallet = await this.walletService.userCreate(vaultUserId, vaultToken);
    // Manager provisioning only writes the mapping — verification is
    // gated on the user completing a device + manifest attestation
    // via the link flow, so we deliberately leave `isVerified=false`.
    await this.verificationService.upsert(beUser.id, vaultUserId, false);

    this.logger.log(
      `Provisioned be:${beUser.id} ↔ vault:${vaultUserId} (${dto.email}) with role=${role}`,
    );

    return {
      userId: beUser.id,
      email: beUser.email,
      name: beUser.name,
      role,
      vaultUserId,
      publicAddress: wallet.public_address ?? null,
    };
  }

  /**
   * Updates an existing Better-Auth user. Any subset of `email`,
   * `name`, `role` and `vaultUserId` may be supplied. When
   * `vaultUserId` changes, we (idempotently) ensure the new transit
   * key exists and rewrite the verification mapping accordingly.
   */
  async updateUser(
    userId: string,
    dto: UpdateAuthUserDto,
    vaultToken: string,
  ): Promise<AuthUserResponseDto> {
    const ctx: any = await (auth as any).$context;
    const adapter = ctx.adapter;
    const existing = await adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    });
    if (!existing) {
      throw new NotFoundException(`Better-Auth user ${userId} not found`);
    }

    const updates: Record<string, unknown> = {};
    if (dto.email && dto.email !== existing.email) updates.email = dto.email;
    if (dto.name && dto.name !== existing.name) updates.name = dto.name;
    if (Object.keys(updates).length > 0) {
      await adapter.update({
        model: 'user',
        where: [{ field: 'id', value: userId }],
        update: updates,
      });
    }

    if (dto.role && dto.role !== existing.role) {
      try {
        await (auth as any).api.setRole({
          body: { userId, role: dto.role },
        });
      } catch (err: any) {
        this.logger.warn(
          `setRole failed for ${userId}; falling back to direct update: ${err?.message ?? err}`,
        );
        await adapter.update({
          model: 'user',
          where: [{ field: 'id', value: userId }],
          update: { role: dto.role },
        });
      }
    }

    const verification = await this.verificationService.findByUserId(userId);
    let vaultUserId = verification?.id ?? this.deriveVaultUserId(existing.email, userId);
    let walletAddress: string | null = verification?.walletAddress ?? null;

    if (dto.vaultUserId && dto.vaultUserId !== vaultUserId) {
      vaultUserId = this.normaliseVaultUserId(dto.vaultUserId);
      const wallet = await this.walletService.userCreate(vaultUserId, vaultToken);
      walletAddress = wallet.public_address ?? walletAddress;
      // Re-binding to a different vault key resets verification —
      // the user must re-attest from the new device.
      await this.verificationService.upsert(userId, vaultUserId, false);
    } else if (!verification) {
      // Backfill — user existed in Better-Auth but had no link row.
      const wallet = await this.walletService.userCreate(vaultUserId, vaultToken);
      walletAddress = wallet.public_address ?? walletAddress;
      await this.verificationService.upsert(userId, vaultUserId, false);
    }

    const refreshed = await adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    });

    return {
      userId,
      email: refreshed.email,
      name: refreshed.name,
      role: (refreshed.role as AuthUserRole) ?? 'user',
      vaultUserId,
      publicAddress: walletAddress,
    };
  }

  private generateThrowawayPassword(): string {
    // Better-Auth requires a password column even though sign-in is
    // passwordless; this value is never surfaced to clients.
    return randomBytes(32).toString('base64url');
  }

  private deriveVaultUserId(email: string, fallback: string): string {
    const candidate = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
    return this.normaliseVaultUserId(candidate || `user_${fallback.slice(0, 16)}`);
  }

  private normaliseVaultUserId(raw: string): string {
    const sanitised = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
    if (!sanitised) {
      throw new BadRequestException('vaultUserId must contain at least one alphanumeric character');
    }
    return sanitised;
  }
}
