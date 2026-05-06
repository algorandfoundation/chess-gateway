import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { VerificationService } from './verification/verification.service';
import { LinkVerification } from './verification/entities/link-verification.entity';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { VaultService } from '../vault/vault.service';
import { auth } from './auth';
import { OtpLookupResponseDto } from './link.dto';
import { DidService } from '../did/did.service';

@Injectable()
export class LinkService {
  private readonly logger = new Logger(LinkService.name);
  constructor(
    private readonly verificationService: VerificationService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly vaultService: VaultService,
    private readonly didService: DidService,
  ) {}

  /**
   * Force-republish the player's DID document so its `alsoKnownAs`
   * reflects the freshly linked wallet. Skips republish (with a log) if
   * the player has no on-chain document yet — `publishUserDid` will
   * pick up the linked wallet on the next regular publish.
   */
  private async republishDidWithLink(playerId: string): Promise<void> {
    const roleId = this.configService.get<string>('VAULT_ROLE_ID');
    const secretId = this.configService.get<string>('VAULT_SECRET_ID');
    const token = await this.vaultService.getTokenWithRole(roleId, secretId);
    const publicKey = await this.vaultService.getUserPublicKey(playerId, token);
    const hasDoc = await this.didService.hasOnChainDocument(new Uint8Array(publicKey));
    if (!hasDoc) {
      this.logger.log(`No on-chain DID document for player ${playerId}; skipping link republish.`);
      return;
    }
    await this.didService.publishUserDid({
      userId: playerId,
      publicKey: new Uint8Array(publicKey),
      vaultToken: token,
      force: true,
    });
    this.logger.log(`Republished DID document for player ${playerId} with linked wallet.`);
  }

  /**
   * Links a device and wallet by verifying app integrity, associating the account, and linking the wallet.
   * @param userId The ID of the authenticated user.
   * @param email The user's email address.
   * @param walletAddress The blockchain wallet address to link.
   * @param integrityData Data for app integrity verification.
   * @returns The updated LinkVerification.
   */
  async linkResponse(
    userId: string,
    email: string,
    walletAddress: string,
    integrityData: { integrityToken?: string; attestationObject?: string; keyId?: string },
    challenge: string,
  ): Promise<LinkVerification> {
    const isIntegrityVerified = await this.verifyIntegrity(challenge, integrityData);
    if (!isIntegrityVerified) {
      throw new BadRequestException('App integrity verification failed.');
    }

    const id = await this.authService.getUserIdByEmail(email);
    if (!id) {
      throw new NotFoundException(`Email ${email} not found in the player directory.`);
    }

    const verification = await this.verificationService.upsert(userId, id, true, walletAddress);
    // Republish the DID document so the linked wallet shows up under
    // `alsoKnownAs`. Failures propagate so callers see link/DID drift
    // immediately instead of silently.
    await this.republishDidWithLink(id);
    return verification;
  }

  /**
   * Generates a unique challenge for app integrity verification.
   * @returns A random challenge string.
   */
  async generateChallenge(): Promise<string> {
    const challenge = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return challenge;
  }

  /**
   * Verifies the app integrity using tokens from Expo AppIntegrity.
   * Currently implements a placeholder for Google Play Integrity and Apple App Attest.
   * @param challenge The challenge that was issued.
   * @param integrityData The data containing integrity tokens.
   * @returns True if verification passes.
   */
  async verifyIntegrity(
    challenge: string,
    integrityData: {
      integrityToken?: string;
      attestationObject?: string;
      keyId?: string;
    },
  ): Promise<boolean> {
    const { integrityToken, attestationObject, keyId } = integrityData;
    this.logger.debug(`Verifying integrity with challenge: ${challenge}`);

    if (integrityToken) {
      this.logger.log('Verifying Google Play Integrity token...');
      // TODO: Implement actual verification with Google Play Integrity API
      // For now, we accept all tokens in this placeholder
      return true;
    }

    if (attestationObject && keyId) {
      this.logger.log('Verifying Apple App Attest attestation...');
      // TODO: Implement actual verification with Apple App Attest service
      // For now, we accept all attestations in this placeholder
      return true;
    }

    this.logger.warn('No app integrity data provided');
    return false;
  }

  /**
   * Creates or updates a mapping between an authentication user and a vault player.
   * @param userId The ID of the authenticated user.
   * @param id The ID of the player in the vault.
   * @returns The updated or newly created LinkVerification.
   */
  async associateAccount(userId: string, id: string): Promise<LinkVerification> {
    return this.verificationService.upsert(userId, id, true);
  }

  /**
   * Attempts to automatically associate an authenticated user with a vault player
   * based on their email address.
   * @param userId The ID of the authenticated user.
   * @param email The user's email address.
   * @returns The LinkVerification if association was successful, null otherwise.
   */
  async autoAssociate(userId: string, email: string): Promise<LinkVerification | null> {
    const id = await this.authService.getUserIdByEmail(email);
    if (!id) return null;

    const player = await this.getVaultPlayer(id);
    if (!player) return null;

    this.logger.log(`Auto-associating user ${userId} (${email}) with vault player ${id}`);
    return this.associateAccount(userId, id);
  }

  /**
   * Retrieves the mapping for a specific authenticated user.
   * @param userId The ID of the authenticated user.
   * @returns The LinkVerification if found, null otherwise.
   */
  async getLinkVerification(userId: string): Promise<LinkVerification | null> {
    return this.verificationService.findByUserId(userId);
  }

  /**
   * Retrieves all link verifications.
   * @returns A list of all LinkVerifications.
   */
  async findAll(): Promise<LinkVerification[]> {
    return this.verificationService.findAll();
  }

  async findOne(id: string): Promise<LinkVerification> {
    return this.verificationService.findOne(id);
  }

  async create(data: Partial<LinkVerification>): Promise<LinkVerification> {
    return this.verificationService.create(data);
  }

  async update(id: string, data: Partial<LinkVerification>): Promise<LinkVerification> {
    return this.verificationService.update(id, data);
  }

  async remove(id: string): Promise<void> {
    return this.verificationService.remove(id);
  }

  /**
   * Retrieves all link verifications for a specific vault player.
   * Verifies that the provided vault token has access to the player.
   * @param id The ID of the player in the vault.
   * @param vaultToken The vault token for verification.
   * @returns A list of LinkVerifications.
   */
  async getVerifications(id: string, vaultToken: string): Promise<LinkVerification[]> {
    await this.verifyVaultAccess(id, vaultToken);
    return this.verificationService.findByPlayerId(id);
  }

  /**
   * Verifies that a vault token has access to a specific player.
   * @param id The ID of the player.
   * @param vaultToken The vault token.
   * @throws BadRequestException if access is denied.
   */
  private async verifyVaultAccess(id: string, vaultToken: string): Promise<void> {
    try {
      const transitPath = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');
      await this.vaultService.getKey(id, transitPath, vaultToken);
    } catch (error) {
      this.logger.error(`Unauthorized access attempt for player ${id}`, error.stack);
      throw new BadRequestException('Invalid vault token or unauthorized access to player.');
    }
  }

  /**
   * Fetches player information from the vault.
   * @param id The ID of the player in the vault.
   * @returns The player information or null if not found or on error.
   */
  async getVaultPlayer(id: string) {
    try {
      const roleId = this.configService.get<string>('VAULT_ROLE_ID');
      const secretId = this.configService.get<string>('VAULT_SECRET_ID');
      const token = await this.vaultService.getTokenWithRole(roleId, secretId);

      const players = await this.vaultService.getKeys(token);
      return players.find((p) => p.user_id === id) || null;
    } catch (error) {
      this.logger.error(`Failed to fetch vault player ${id}`, error.stack);
      return null;
    }
  }

  /**
   * @deprecated Demo-only helper. Returns the latest OTP issued to `email`
   * for the given `type` from Better Auth's `verification` store.
   *
   * Guarded by the manager Vault approle: the caller's `vaultToken` must be
   * able to read the managers transit key; otherwise `ForbiddenException`
   * is thrown. Do NOT enable this endpoint in production.
   */
  async getOtpForManager(email: string, type: string, vaultToken: string): Promise<OtpLookupResponseDto> {
    if (!vaultToken) {
      throw new ForbiddenException('Manager Vault token required.');
    }
    try {
      await this.vaultService.getManagerPublicKey(vaultToken);
    } catch (error) {
      this.logger.warn(`getOtpForManager: vault token failed manager check: ${error?.message ?? error}`);
      throw new ForbiddenException('Manager role required.');
    }

    const identifier = `${type}-otp-${email}`;
    const ctx = await auth.$context;
    const rows: any[] = await ctx.adapter.findMany({
      model: 'verification',
      where: [{ field: 'identifier', value: identifier }],
      sortBy: { field: 'expiresAt', direction: 'desc' },
      limit: 1,
    });
    const row = rows?.[0];

    if (!row) {
      throw new NotFoundException(`No OTP found for identifier '${identifier}'.`);
    }

    const raw: string = typeof row.value === 'string' ? row.value : String(row.value ?? '');
    const sepIdx = raw.indexOf(':');
    const otp = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
    const attempts = sepIdx >= 0 ? Number.parseInt(raw.slice(sepIdx + 1), 10) || 0 : 0;
    const expiresAt = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);

    return { email, type, otp, attempts, expiresAt };
  }
}
