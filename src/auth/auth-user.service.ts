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
  AuthUserDetailDto,
  AuthUserResponseDto,
  AuthUserRole,
  CreateAuthUserDto,
  UpdateAuthUserDto,
} from './auth-user.dto';
import { LinkVerification } from '../link/verification/entities/link-verification.entity';

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
   * Lists every Better-Auth user with the data the manager UI needs
   * to render them: email, name, role, vault binding (if any) and the
   * Algorand `public_address` derived from the vault transit key. The
   * vault list is queried with the caller's manager-scoped JWT vault
   * token, same as `GET /v1/wallet/users/`.
   */
  async listUsers(vaultToken: string): Promise<AuthUserDetailDto[]> {
    const ctx: any = await (auth as any).$context;
    const adapter = ctx.adapter;
    const beUsers: any[] = await adapter.findMany({ model: 'user' });

    const verifications = await this.verificationService.findAll();
    const verificationByUserId = new Map<string, LinkVerification>(
      verifications.map((v) => [v.userId, v]),
    );

    let publicAddressByVaultId = new Map<string, string>();
    try {
      const keys = await this.walletService.getKeys(vaultToken);
      publicAddressByVaultId = new Map(
        keys.map((k) => [k.user_id, k.public_address]),
      );
    } catch (err: any) {
      this.logger.warn(
        `listUsers: could not fetch vault keys (${err?.message ?? err}); public addresses will be omitted`,
      );
    }

    return beUsers.map((u) => {
      const v = verificationByUserId.get(u.id);
      // Only surface a vaultUserId / publicAddress once the user is
      // actually bound to a vault transit key (manager provisioning
      // via POST /auth/user). Self-signups remain unbound until a
      // manager links them via PUT /auth/user/:userId.
      const vaultUserId = v?.id ?? null;
      return {
        userId: u.id,
        email: u.email,
        name: u.name,
        role: (u.role as AuthUserRole) ?? 'user',
        vaultUserId,
        publicAddress: vaultUserId
          ? publicAddressByVaultId.get(vaultUserId) ?? null
          : null,
        isVerified: v?.isVerified ?? false,
        walletAddress: v?.walletAddress ?? null,
        associatedAt: v?.associatedAt ? new Date(v.associatedAt).toISOString() : null,
      };
    });
  }

  /**
   * Returns the enriched detail view of a single Better-Auth user
   * (better-auth profile, role, vault binding, public address, and
   * verification status). The current device manifest / DID Document
   * is exposed by a separate admin endpoint on the OID4VC module to
   * keep this service free of cross-module dependencies.
   */
  async getUser(userId: string, vaultToken: string): Promise<AuthUserDetailDto> {
    const ctx: any = await (auth as any).$context;
    const adapter = ctx.adapter;
    const u = await adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    });
    if (!u) {
      throw new NotFoundException(`Better-Auth user ${userId} not found`);
    }

    const v = await this.verificationService.findByUserId(userId);
    // Only surface a vaultUserId / publicAddress once the user is
    // actually bound to a vault transit key (manager provisioning).
    const vaultUserId = v?.id ?? null;
    let publicAddress: string | null = null;
    if (vaultUserId) {
      try {
        const keys = await this.walletService.getKeys(vaultToken);
        publicAddress = keys.find((k) => k.user_id === vaultUserId)?.public_address ?? null;
      } catch (err: any) {
        this.logger.warn(
          `getUser ${userId}: could not fetch vault keys (${err?.message ?? err})`,
        );
      }
    }

    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      role: (u.role as AuthUserRole) ?? 'user',
      vaultUserId,
      publicAddress,
      isVerified: v?.isVerified ?? false,
      walletAddress: v?.walletAddress ?? null,
      associatedAt: v?.associatedAt ? new Date(v.associatedAt).toISOString() : null,
    };
  }

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
    let vaultUserId: string | null = verification?.id ?? null;
    let walletAddress: string | null = verification?.walletAddress ?? null;

    // Vault operations only run when the manager explicitly supplies a
    // `vaultUserId` — never as an implicit side-effect of a profile edit.
    // Users without a vault binding (e.g. a name-only update from the
    // user dashboard) are left untouched on the vault side; user-role
    // tokens lack the policy to mint transit keys anyway.
    if (dto.vaultUserId && dto.vaultUserId !== vaultUserId) {
      vaultUserId = this.normaliseVaultUserId(dto.vaultUserId);
      const wallet = await this.walletService.userCreate(vaultUserId, vaultToken);
      walletAddress = wallet.public_address ?? walletAddress;
      // Re-binding to a different vault key resets verification —
      // the user must re-attest from the new device.
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

  /**
   * Deletes a Better-Auth user along with their `LinkVerification`
   * mapping. The vault transit key itself is intentionally left in
   * place — it may be re-bound to a freshly created user via
   * `POST /auth/user`, and Vault transit keys cannot be re-created
   * with the same name once destroyed.
   */
  async deleteUser(userId: string): Promise<{ userId: string; deleted: true }> {
    const ctx: any = await (auth as any).$context;
    const adapter = ctx.adapter;
    const existing = await adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    });
    if (!existing) {
      throw new NotFoundException(`Better-Auth user ${userId} not found`);
    }

    try {
      await this.verificationService.deleteByUserId(userId);
    } catch (err: any) {
      this.logger.warn(
        `deleteUser: failed to remove verification for ${userId}: ${err?.message ?? err}`,
      );
    }

    // Best-effort cleanup of related auth rows (sessions, accounts)
    // before removing the user itself, so foreign-key-style relations
    // don't leave orphans.
    for (const model of ['session', 'account']) {
      try {
        await adapter.deleteMany({
          model,
          where: [{ field: 'userId', value: userId }],
        });
      } catch (err: any) {
        this.logger.warn(
          `deleteUser: failed to clean ${model} rows for ${userId}: ${err?.message ?? err}`,
        );
      }
    }

    await adapter.delete({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    });

    this.logger.log(`Deleted be:${userId} (${existing.email})`);
    return { userId, deleted: true };
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
