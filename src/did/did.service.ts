import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address, AlgorandClient } from '@algorandfoundation/algokit-utils';

import { base58 } from '@scure/base';

import { DidRecord } from './entities/did-record.entity';
import {
  DidAlgoStorageClient,
  buildDidIdentifier,
  deleteDIDDocument,
  genesisIdToNetwork,
  uploadDIDDocument,
  Metadata,
} from '../../libs/did-algo';
import { buildDidDocument, ManifestAnchor, PromotedVerificationMethod } from './did-document';
import { buildManagerSigner } from './vault-signer';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';
import { VerificationService } from '../link/verification/verification.service';
import { Oid4vcUserDeviceManifest } from '../oid4vc/entities/oid4vc-user-device-manifest.entity';

/** Multicodec prefix for raw Ed25519 public keys (`0xed01`). */
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

/**
 * Read a user's metadata box from the contract, treating a 404
 * "box not found" response as a normal `undefined` (the box simply
 * doesn't exist yet). Any other error is rethrown.
 */
async function tryReadMetadata(appClient: DidAlgoStorageClient, pubKeyAddress: string): Promise<Metadata | undefined> {
  try {
    return await appClient.state.box.metadata.value(pubKeyAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/status\s*404/i.test(message) && /box not found/i.test(message)) {
      return undefined;
    }
    throw err;
  }
}

export interface PublishedDidInfo {
  did: string;
  document: object;
  txIds: string[];
}

/**
 * Thrown by {@link DidService.publishUserDid} when an on-chain DID
 * document already exists for the user and the caller did not opt in
 * to overwriting it via `force`. The HTTP layer maps this to 409.
 */
export class DidAlreadyPublishedError extends Error {
  constructor(public readonly userId: string) {
    super(`DID document already published for user ${userId}; pass force=true to republish.`);
    this.name = 'DidAlreadyPublishedError';
  }
}

/**
 * Publishes and resolves DID documents on the `did:algo` registry hosted
 * by a `DIDAlgoStorage` smart contract. Each user's vault key is referenced
 * as the verification method of their DID document; the manager identity
 * (held in Vault) acts as the on-chain controller and signs every app call.
 *
 * The service also doubles as a *local* resolver, returning the cached
 * document directly when callers ask about a user we have published — saving
 * a round-trip to the universal resolver / chain.
 */
@Injectable()
export class DidService {
  private readonly logger = new Logger(DidService.name);

  /**
   * Per-user serialisation lock for {@link publishUserDid}. The on-chain
   * publish flow is decidedly *not* idempotent — a concurrent
   * delete+upload sequence races itself into algod's "transaction
   * already in ledger" rejection. Coalescing by `userId` means a
   * retrying client (or two upstream call sites firing in parallel)
   * shares a single publish attempt instead of stomping on each other.
   */
  private readonly inFlightPublishes = new Map<string, Promise<PublishedDidInfo>>();

  constructor(
    @InjectRepository(DidRecord) private readonly didRepository: Repository<DidRecord>,
    @InjectRepository(Oid4vcUserDeviceManifest)
    private readonly manifestRepository: Repository<Oid4vcUserDeviceManifest>,
    private readonly configService: ConfigService,
    private readonly chainService: ChainService,
    private readonly vaultService: VaultService,
    private readonly verificationService: VerificationService,
  ) {}

  /**
   * Resolve the wallet's primary device-held identity ed25519 public
   * key — the one published as the primary verification method in the
   * device manifest's `did:key` document. This is the key the wallet
   * actually signs OID4VCI proof JWTs / DID-Auth assertions with, so
   * it's the right thing to publish as the user's `#keys-2`.
   *
   * Returns `null` when the user hasn't seeded a manifest yet (e.g.
   * legacy accounts or wallets that haven't completed the link
   * attestation). Callers may publish a `#keys-1`-only document in
   * that case.
   */
  private async resolveIdentityPublicKey(userId: string): Promise<Uint8Array | null> {
    const manifest = await this.manifestRepository.findOne({
      where: { userId },
      relations: { currentRevision: true },
      order: { updatedAt: 'DESC' },
    });
    if (!manifest || manifest.revokedAt || !manifest.currentRevision) return null;

    const rawDoc = manifest.currentRevision.document;
    let parsed: Record<string, unknown>;
    try {
      parsed =
        typeof rawDoc === 'string'
          ? (JSON.parse(rawDoc) as Record<string, unknown>)
          : (rawDoc as Record<string, unknown>);
    } catch (err) {
      this.logger.warn(
        `resolveIdentityPublicKey: stored manifest document for userId=${userId} is unparseable: ${(err as Error).message}`,
      );
      return null;
    }

    const didKey = manifest.didKey;
    const verificationMethods = parsed['verificationMethod'];
    if (!Array.isArray(verificationMethods)) return null;

    for (const vm of verificationMethods) {
      if (!vm || typeof vm !== 'object') continue;
      const id = (vm as Record<string, unknown>)['id'];
      if (typeof id !== 'string') continue;
      // Primary VM is controlled by the did:key itself (id === didKey
      // or id === didKey + '#…'); skip P-256 / passkey subkeys.
      if (id !== didKey && !id.startsWith(`${didKey}#`)) continue;
      const multibase = (vm as Record<string, unknown>)['publicKeyMultibase'];
      if (typeof multibase !== 'string' || !multibase.startsWith('z')) continue;
      let decoded: Uint8Array;
      try {
        decoded = base58.decode(multibase.slice(1));
      } catch {
        continue;
      }
      if (
        decoded.length !== ED25519_MULTICODEC_PREFIX.length + 32 ||
        decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
        decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
      ) {
        continue;
      }
      return decoded.slice(2);
    }
    return null;
  }

  /**
   * Resolve the wallet address the user has linked via the link
   * verification service, if any. Returns the most recently associated
   * record's `walletAddress` (matching the wallet response shape) or
   * `null` when no link exists.
   */
  private async resolveLinkedWalletAddress(userId: string): Promise<string | null> {
    const verifications = await this.verificationService.findByPlayerId(userId);
    if (!verifications || verifications.length === 0) return null;
    const verification = verifications.reduce((a, b) =>
      a.associatedAt && b.associatedAt && a.associatedAt > b.associatedAt ? a : b,
    );
    return verification.walletAddress ? verification.walletAddress : null;
  }

  /** App id of the deployed `DIDAlgoStorage` contract for the active network. */
  private getAppId(): bigint {
    const raw = this.configService.get<string>('DID_ALGO_APP_ID');
    if (!raw) throw new Error('DID_ALGO_APP_ID is not configured');
    return BigInt(raw);
  }

  /** Slug used for the `did:algo:<network>:...` identifier (derived from `GENESIS_ID`). */
  private getNetwork(): string {
    return genesisIdToNetwork(this.configService.get<string>('GENESIS_ID'));
  }

  /**
   * Build a configured `AlgorandClient` pointing at the project's algod node.
   * Reuses the existing `NODE_HTTP_SCHEME` / `NODE_HOST` / `NODE_PORT` / `NODE_TOKEN`
   * variables already used by `ChainService`, so a single set of env vars governs
   * both transaction submission and DID publication.
   */
  private buildAlgorandClient(): AlgorandClient {
    const scheme = this.configService.get<string>('NODE_HTTP_SCHEME') ?? 'http';
    const host = this.configService.get<string>('NODE_HOST') ?? 'localhost';
    const port = this.configService.get<string>('NODE_PORT') ?? 4001;
    return AlgorandClient.fromConfig({
      algodConfig: {
        server: `${scheme}://${host}`,
        port,
        token: this.configService.get<string>('NODE_TOKEN') ?? '',
      },
    });
  }

  /**
   * Build a DID identifier and W3C document for a freshly created user.
   * The user's ed25519 public key is referenced as the sole authentication
   * and assertion method.
   */
  buildDocumentForUser(
    publicKey: Uint8Array,
    linkedWalletAddress?: string | null,
    extras: {
      identityPublicKey?: Uint8Array | null;
      promotedKeys?: PromotedVerificationMethod[];
      manifestAnchor?: ManifestAnchor;
    } = {},
  ): { did: string; network: string; appId: bigint; document: object } {
    const network = this.getNetwork();
    const appId = this.getAppId();
    const did = buildDidIdentifier(network, appId, publicKey);
    const document = buildDidDocument({
      did,
      publicKey,
      linkedWalletAddress,
      identityPublicKey: extras.identityPublicKey,
      promotedKeys: extras.promotedKeys,
      manifestAnchor: extras.manifestAnchor,
    });
    return { did, network, appId, document };
  }

  /**
   * Look up the locally cached DID record for a user. Returns `null` if
   * we have no record (the universal resolver / on-chain registry remains
   * the canonical source of truth in that case).
   */
  async resolveLocal(userId: string): Promise<DidRecord | null> {
    userId = await this.verificationService.resolveVaultUserId(userId);
    return this.didRepository.findOne({ where: { user_id: userId } });
  }

  /**
   * Resolve the published DID identifier attached to user-info responses.
   * Returns `null` if the user has no record yet (e.g. legacy accounts
   * created before this feature shipped) so callers can surface
   * `did: null` on the API.
   */
  async buildUserDidInfo(userId: string): Promise<string | null> {
    const record = await this.resolveLocal(userId);
    if (!record) return null;
    return record.did ?? null;
  }

  /**
   * List every locally cached DID record. Used by the management /
   * admin endpoints to enumerate publication state across the vault.
   */
  async listRecords(): Promise<DidRecord[]> {
    return this.didRepository.find({ order: { updated_at: 'DESC' } });
  }

  /**
   * Remove the locally cached DID record for a user. Does **not** touch
   * the on-chain document — see {@link deleteUserDid} for the full
   * delete-and-reclaim flow.
   *
   * Returns `true` if a record existed and was deleted, `false` otherwise.
   */
  async deleteRecord(userId: string): Promise<boolean> {
    const result = await this.didRepository.delete({ user_id: userId });
    return (result.affected ?? 0) > 0;
  }

  /**
   * Check whether the user currently has a metadata box on the
   * `DIDAlgoStorage` contract — i.e. an on-chain DID document exists for
   * their public key. Used to gate (re)publish requests.
   */
  async hasOnChainDocument(publicKey: Uint8Array): Promise<boolean> {
    const algorand = this.buildAlgorandClient();
    const appId = this.getAppId();
    const appClient = new DidAlgoStorageClient({ appId, algorand });
    const pubKeyAddress = new Address(publicKey).toString();
    const metadata = await tryReadMetadata(appClient, pubKeyAddress);
    return metadata !== undefined && metadata !== null;
  }

  /**
   * Tear down a user's DID document on chain (reclaiming all box MBR
   * back to the manager) and then drop the local cache row.
   *
   * Returns the list of confirmed transaction ids on success, or `null`
   * if no on-chain document existed (the local cache is still cleared).
   */
  async deleteUserDid(userId: string, vaultToken: string): Promise<{ txIds: string[] | null; cacheRemoved: boolean }> {
    userId = await this.verificationService.resolveVaultUserId(userId);
    const publicKey: Buffer = await this.vaultService.getUserPublicKey(userId, vaultToken);
    const publicKeyBytes = new Uint8Array(publicKey);

    const algorand = this.buildAlgorandClient();
    const appId = this.getAppId();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    algorand.setSigner(managerAddress, signer);
    algorand.setDefaultSigner(signer);

    const appClient = new DidAlgoStorageClient({
      appId,
      algorand,
      defaultSender: managerAddress,
      defaultSigner: signer,
    });

    const pubKeyAddress = new Address(publicKeyBytes).toString();
    const metadata = await tryReadMetadata(appClient, pubKeyAddress);

    let txIds: string[] | null = null;
    if (metadata) {
      txIds = await deleteDIDDocument(appClient, algorand, appId, publicKeyBytes, managerAddress);
      this.logger.log(`deleteUserDid: removed on-chain doc userId=${userId} txCount=${txIds.length}`);
    } else {
      this.logger.log(`deleteUserDid: no on-chain doc to remove userId=${userId}`);
    }

    const cacheRemoved = await this.deleteRecord(userId);
    return { txIds, cacheRemoved };
  }

  /**
   * Convenience wrapper that resolves the user's ed25519 public key from
   * Vault and then publishes their DID document. Lets HTTP controllers
   * (and the wallet module) trigger a publish/republish without having to
   * juggle Vault calls themselves.
   */
  async publishForUser(
    userId: string,
    vaultToken: string,
    options: {
      force?: boolean;
      promotedKeys?: PromotedVerificationMethod[];
      manifestAnchor?: ManifestAnchor;
    } = {},
  ): Promise<PublishedDidInfo> {
    userId = await this.verificationService.resolveVaultUserId(userId);
    const publicKey: Buffer = await this.vaultService.getUserPublicKey(userId, vaultToken);
    return this.publishUserDid({
      userId,
      publicKey: new Uint8Array(publicKey),
      vaultToken,
      force: options.force,
      promotedKeys: options.promotedKeys,
      manifestAnchor: options.manifestAnchor,
    });
  }

  /**
   * Re-publish the user's DID document after the wallet's device manifest
   * has changed: bumps the on-chain `DeviceManifestAnchor` service entry
   * and promotes any wallet-managed subkeys (HD-derived account keys,
   * passkey keys) to first-class verification methods.
   *
   * Always forces a republish so the chain reflects the latest revision.
   */
  async republishForManifest(
    userId: string,
    vaultToken: string,
    args: { manifestAnchor: ManifestAnchor; promotedKeys: PromotedVerificationMethod[] },
  ): Promise<PublishedDidInfo> {
    return this.publishForUser(userId, vaultToken, {
      force: true,
      manifestAnchor: args.manifestAnchor,
      promotedKeys: args.promotedKeys,
    });
  }

  /**
   * Persist or update a user's DID record after a successful on-chain
   * publish. The row exists if and only if the document exists on chain.
   */
  private async upsertRecord(record: Partial<DidRecord> & { user_id: string }): Promise<DidRecord> {
    const existing = await this.didRepository.findOne({ where: { user_id: record.user_id } });
    if (existing) {
      Object.assign(existing, record);
      return this.didRepository.save(existing);
    }
    return this.didRepository.save(this.didRepository.create(record));
  }

  /**
   * Publish a DID document for the supplied user on the configured
   * `did:algo` registry, signing all transactions with the manager's
   * Vault-backed key. The publication state is mirrored in the
   * `did_records` table; failures are surfaced via the returned info
   * object so callers can decide whether to fail loudly or merely log.
   */
  async publishUserDid(params: {
    userId: string;
    publicKey: Uint8Array;
    vaultToken: string;
    /**
     * When the user already has an on-chain DID document, the publish
     * fails with a `DidAlreadyPublishedError` unless `force` is set —
     * in which case the existing document is deleted (reclaiming MBR)
     * before the new one is uploaded.
     */
    force?: boolean;
    /**
     * Wallet-managed subkeys to surface as on-chain verification
     * methods. Only the public-key bytes cross this boundary; per-key
     * metadata (derivation path, origin, etc.) stays off chain.
     */
    promotedKeys?: PromotedVerificationMethod[];
    /** On-chain anchor for the off-chain device manifest. */
    manifestAnchor?: ManifestAnchor;
    /**
     * Wallet's primary device-held identity ed25519 public key, to be
     * published as `#keys-2`. Provided explicitly by callers who
     * already have it in hand (e.g. `LinkService.linkResponse` reads
     * it straight from the wallet's just-uploaded manifest); when not
     * supplied, the service falls back to `resolveIdentityPublicKey`
     * which queries the manifest table by the same `userId`.
     */
    identityPublicKey?: Uint8Array | null;
  }): Promise<PublishedDidInfo> {
    // Coalesce concurrent calls for the same user — the wallet's link
    // flow used to fire two parallel `publishUserDid`s (one from the
    // link verifier, another from the device-manifest seed) and both
    // raced into the algod pool with the same delete+upload txns,
    // tripping "transaction already in ledger" on whichever lost the
    // race. Sharing a single in-flight promise avoids the race entirely.
    const existing = this.inFlightPublishes.get(params.userId);
    if (existing) {
      this.logger.log(
        `publishUserDid: coalescing concurrent publish for userId=${params.userId} (waiting on in-flight call)`,
      );
      return existing;
    }
    const inFlight = this.publishUserDidUnlocked(params).finally(() => {
      this.inFlightPublishes.delete(params.userId);
    });
    this.inFlightPublishes.set(params.userId, inFlight);
    return inFlight;
  }

  private async publishUserDidUnlocked(params: {
    userId: string;
    publicKey: Uint8Array;
    vaultToken: string;
    force?: boolean;
    promotedKeys?: PromotedVerificationMethod[];
    manifestAnchor?: ManifestAnchor;
    identityPublicKey?: Uint8Array | null;
  }): Promise<PublishedDidInfo> {
    const {
      userId,
      publicKey,
      vaultToken,
      force,
      promotedKeys,
      manifestAnchor,
      identityPublicKey: explicitIdentityPublicKey,
    } = params;

    // Pull the latest linked wallet (if any) and the wallet's primary
    // device-held identity key so the published document reflects the
    // current state of *both* the link verification service (which
    // gives us `alsoKnownAs: algorand:<addr>`) and the wallet's device
    // manifest (whose primary `did:key` VM is the user-side signer
    // published as `#keys-2`). Explicit identity keys win over the
    // manifest-derived fallback so callers that already have the key
    // in hand (e.g. `LinkService` reading from the just-uploaded
    // manifest payload) don't depend on the manifest having been
    // committed yet.
    const linkedWalletAddress = await this.resolveLinkedWalletAddress(userId);
    const identityPublicKey =
      explicitIdentityPublicKey ?? (await this.resolveIdentityPublicKey(userId));
    const built = this.buildDocumentForUser(publicKey, linkedWalletAddress, {
      identityPublicKey,
      promotedKeys,
      manifestAnchor,
    });
    const { did, appId, network } = built;
    const document = built.document;
    const documentJson = JSON.stringify(document);
    const data = Buffer.from(documentJson, 'utf-8');

    // Set up the manager signer + app client before touching the database
    // so we can do the on-chain existence check and surface conflicts as
    // the dedicated `DidAlreadyPublishedError` (mapped to 409 by the
    // controller) without leaving a stray `pending` row behind.
    const algorand = this.buildAlgorandClient();
    const { address: managerAddress, signer } = await buildManagerSigner(
      this.vaultService,
      this.chainService,
      vaultToken,
    );
    algorand.setSigner(managerAddress, signer);
    algorand.setDefaultSigner(signer);
    const appClient = new DidAlgoStorageClient({
      appId,
      algorand,
      defaultSender: managerAddress,
      defaultSigner: signer,
    });

    const pubKeyAddress = new Address(publicKey).toString();
    const existing = await tryReadMetadata(appClient, pubKeyAddress);
    if (existing) {
      if (!force) {
        throw new DidAlreadyPublishedError(userId);
      }
      this.logger.log(`publishUserDid: force=true, deleting existing on-chain doc userId=${userId} before republish`);
      await deleteDIDDocument(appClient, algorand, appId, publicKey, managerAddress);
    }

    // Any failure from here propagates to the caller — we deliberately
    // do not write a cache row before the on-chain upload succeeds, so
    // the local cache always reflects the on-chain state (a row exists
    // iff the document was published).
    const txIds = await uploadDIDDocument(appClient, algorand, data, appId, publicKey, managerAddress);

    await this.upsertRecord({
      user_id: userId,
      did,
      network,
      app_id: appId.toString(),
      document: documentJson,
      tx_ids: txIds.join(','),
    });

    this.logger.log(`publishUserDid: published did=${did} userId=${userId} txCount=${txIds.length}`);
    return { did, document, txIds };
  }
}
