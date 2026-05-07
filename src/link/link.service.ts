import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { VerificationService } from './verification/verification.service';
import { LinkVerification } from './verification/entities/link-verification.entity';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { VaultService } from '../vault/vault.service';
import { DidService } from '../did/did.service';
import { DeviceManifestService } from '../oid4vc/devices/device-manifest.service';
import type { UploadDeviceManifestDto } from '../oid4vc/dto/upload-device-manifest.dto';

@Injectable()
export class LinkService {
  private readonly logger = new Logger(LinkService.name);
  constructor(
    private readonly verificationService: VerificationService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly vaultService: VaultService,
    private readonly didService: DidService,
    private readonly deviceManifestService: DeviceManifestService,
  ) {}

  /**
   * Best-effort seed of the wallet's did:key device manifest on the
   * first attestation. Failures are logged but do not block the link
   * flow (wallets that don't yet send a manifest must still be able
   * to link). See `src/oid4vc/DISCOVERY.md` — "First-attestation
   * seeding".
   */
  private async seedDeviceManifest(
    userId: string,
    manifest: UploadDeviceManifestDto,
  ): Promise<void> {
    try {
      const result = await this.deviceManifestService.upsertManifest({
        userId,
        didKey: manifest.didKey,
        version: manifest.version,
        signedAt: manifest.signedAt,
        didDocument: manifest.didDocument,
        signature: manifest.signature,
        // Link-attestation has just verified device integrity, so this
        // is the one place we allow a previously-unseen did:key to
        // create a manifest row.
        trustedSeed: true,
      });
      this.logger.log(
        `Seeded device manifest userId=${userId} didKey=${manifest.didKey} version=${manifest.version} created=${result.created}`,
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to seed device manifest userId=${userId} didKey=${manifest?.didKey}: ${error?.message}`,
      );
    }
  }

  /**
   * Ensure the player has an on-chain DID document that reflects the
   * freshly linked wallet under `alsoKnownAs`.
   *
   * - If the player already has a document, force-republish it so the
   *   linked wallet shows up.
   * - If the player has *no* on-chain document yet (e.g. they registered
   *   but the manager hadn't provisioned one yet), provision it now —
   *   linking is exactly the moment we want the on-chain identity to
   *   exist.
   *
   * `publishUserDid` itself serialises concurrent invocations per user,
   * so a wallet that retries the link request will not race itself into
   * a "transaction already in ledger" error.
   */
  private async republishDidWithLink(
    playerId: string,
    identityPublicKey?: Uint8Array | null,
  ): Promise<void> {
    const roleId = this.configService.get<string>('VAULT_ROLE_ID');
    const secretId = this.configService.get<string>('VAULT_SECRET_ID');
    const token = await this.vaultService.getTokenWithRole(roleId, secretId);
    const publicKey = await this.vaultService.getUserPublicKey(playerId, token);
    const hasDoc = await this.didService.hasOnChainDocument(new Uint8Array(publicKey));
    await this.didService.publishUserDid({
      userId: playerId,
      publicKey: new Uint8Array(publicKey),
      vaultToken: token,
      // Republish if a doc already exists; provision it for first-time
      // linkers who have no on-chain document yet.
      force: hasDoc,
      // The wallet's primary device-held identity key, surfaced as
      // `#keys-2`. Passed explicitly so we don't need to depend on the
      // device-manifest table being keyed by the same id (it's keyed
      // by Better-Auth `userId`, whereas the DID is keyed by the vault
      // player id).
      identityPublicKey: identityPublicKey ?? null,
    });
    this.logger.log(
      hasDoc
        ? `Republished DID document for player ${playerId} with linked wallet.`
        : `Provisioned DID document for player ${playerId} on first link.`,
    );
  }

  /**
   * Extract the wallet's primary device-held ed25519 identity public
   * key from the supplied manifest payload. Returns `null` when the
   * manifest is absent or malformed (callers fall back to a
   * `#keys-1`-only DID document, which is the legacy behaviour).
   *
   * The extraction reuses {@link DeviceManifestService.extractPrimaryEd25519Key}
   * so the validation rules (multibase decoding, multicodec prefix,
   * key-length, primary-VM identification) stay in lockstep with the
   * manifest persistence path.
   */
  private extractIdentityPublicKey(
    manifest?: UploadDeviceManifestDto,
  ): Uint8Array | null {
    if (!manifest) return null;
    try {
      return new Uint8Array(
        this.deviceManifestService.extractPrimaryEd25519Key(manifest.didKey, manifest.didDocument),
      );
    } catch (error: any) {
      this.logger.warn(
        `Could not extract identity public key from device manifest: ${error?.message}`,
      );
      return null;
    }
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
    deviceManifest?: UploadDeviceManifestDto,
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

    // Pull the wallet's primary device-held identity ed25519 public
    // key out of the supplied manifest before publishing the DID
    // document — that's the key we'll surface as `#keys-2`. The
    // algorand wallet address is correlation metadata only and stays
    // in `alsoKnownAs`; it is no longer used as a verification method.
    const identityPublicKey = this.extractIdentityPublicKey(deviceManifest);

    // Republish the DID document so the linked wallet shows up under
    // `alsoKnownAs` and `#keys-2` reflects the device-held identity.
    // Failures propagate so callers see link/DID drift immediately
    // instead of silently.
    await this.republishDidWithLink(id, identityPublicKey);

    // Best-effort: seed the wallet's did:key device manifest if the
    // wallet supplied one. The manifest is keyed against the
    // authenticated `userId` (Better Auth), not the vault player id —
    // it represents the device, not the on-chain identity.
    if (deviceManifest) {
      await this.seedDeviceManifest(userId, deviceManifest);
    }

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
}
