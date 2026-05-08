import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VaultService } from '../vault/vault.service';
import { WalletService } from '../wallet/wallet.service';
import { VerificationService } from '../link/verification/verification.service';
import {
  BetterAuthCreatedUser,
  registerUserCreatedHandler,
} from '../link/auth-hooks';

/**
 * Listens for Better-Auth `user.create.after` events and mirrors the
 * new user into the vault:
 *
 *  1. Looks up an existing `LinkVerification` row (by Better-Auth
 *     `userId`) — if the manager already provisioned this user via
 *     `POST /auth/user`, we honour their chosen `vaultUserId`.
 *  2. Otherwise derives a `vaultUserId` from the email and ensures a
 *     vault transit key exists for it (best-effort: created if
 *     missing, reused if present). The server uses its own
 *     role-id / secret-id pair to authenticate against vault, so the
 *     hook works for OTP / social-sign-up flows where no manager
 *     vault token is in scope.
 *  3. Upserts the `LinkVerification` mapping with `isVerified=false`.
 *     The flag is only flipped to `true` once the user successfully
 *     completes a device + manifest attestation via
 *     `LinkService.linkResponse`.
 */
@Injectable()
export class AuthUserProvisioningService implements OnModuleInit {
  private readonly logger = new Logger(AuthUserProvisioningService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly vaultService: VaultService,
    private readonly walletService: WalletService,
    private readonly verificationService: VerificationService,
  ) {}

  onModuleInit(): void {
    registerUserCreatedHandler((user) => this.onUserCreated(user));
    this.logger.log('Registered Better-Auth user.create handler.');
  }

  async onUserCreated(user: BetterAuthCreatedUser): Promise<void> {
    if (!user?.id) {
      this.logger.warn('user.create hook received user with no id; skipping.');
      return;
    }

    // The manager-driven `POST /auth/user` flow writes the verification
    // row up-front — if it's already there we leave the chosen
    // vaultUserId alone and just make sure the row exists with the
    // correct unverified state.
    const existing = await this.verificationService.findByUserId(user.id);
    const vaultUserId = existing?.id ?? this.deriveVaultUserId(user.email, user.id);

    const serverToken = await this.acquireServerVaultToken();
    if (serverToken) {
      await this.ensureVaultUser(vaultUserId, serverToken);
    } else {
      this.logger.warn(
        `No server vault token available; deferring vault key creation for ${vaultUserId}.`,
      );
    }

    // Always (re)write the mapping but keep `isVerified=false` until
    // the device + manifest attestation succeeds. We deliberately do
    // not pass a wallet address here — that arrives with the link
    // attestation payload.
    await this.verificationService.upsert(user.id, vaultUserId, false);

    this.logger.log(
      `Provisioned vault mapping be:${user.id} ↔ vault:${vaultUserId} (${user.email}) — pending attestation.`,
    );
  }

  /**
   * Resolve a server-side vault token using the gateway's own
   * AppRole credentials. Returns `null` when the credentials are not
   * configured so the hook can degrade gracefully (the verification
   * row is still written, and a manager can supply the token via
   * `PUT /auth/user/:userId` later).
   */
  private async acquireServerVaultToken(): Promise<string | null> {
    const roleId = this.configService.get<string>('VAULT_ROLE_ID');
    const secretId = this.configService.get<string>('VAULT_SECRET_ID');
    if (!roleId || !secretId) return null;
    try {
      return await this.vaultService.getTokenWithRole(roleId, secretId);
    } catch (error: any) {
      this.logger.warn(
        `Could not acquire server vault token: ${error?.message ?? error}`,
      );
      return null;
    }
  }

  /**
   * Idempotently ensure the vault transit key for `vaultUserId`
   * exists. We probe with `getKey` first (creating one is the rare
   * path) and only mint a new key when the probe fails.
   */
  private async ensureVaultUser(vaultUserId: string, token: string): Promise<void> {
    const transitKeyPath = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');
    try {
      await this.vaultService.getKey(vaultUserId, transitKeyPath, token);
      this.logger.debug(`Vault transit key already exists for ${vaultUserId}.`);
      return;
    } catch {
      // Fall through to creation.
    }

    try {
      await this.walletService.userCreate(vaultUserId, token);
      this.logger.log(`Created vault transit key for ${vaultUserId}.`);
    } catch (error: any) {
      this.logger.warn(
        `Failed to create vault transit key for ${vaultUserId}: ${error?.message ?? error}`,
      );
    }
  }

  private deriveVaultUserId(email: string | undefined, fallback: string): string {
    const candidate = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
    const raw = candidate || `user_${fallback.slice(0, 16)}`;
    const sanitised = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
    return sanitised || `user_${fallback.slice(0, 16)}`;
  }
}
