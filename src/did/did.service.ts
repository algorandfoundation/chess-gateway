import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address, AlgorandClient } from '@algorandfoundation/algokit-utils';

import { DidRecord } from './entities/did-record.entity';
import {
  DidAlgoStorageClient,
  buildDidIdentifier,
  deleteDIDDocument,
  genesisIdToNetwork,
  uploadDIDDocument,
  Metadata,
} from '../../libs/did-algo';
import { buildDidDocument } from './did-document';
import { buildManagerSigner } from './vault-signer';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';
import { VerificationService } from '../link/verification/verification.service';

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

  constructor(
    @InjectRepository(DidRecord) private readonly didRepository: Repository<DidRecord>,
    private readonly configService: ConfigService,
    private readonly chainService: ChainService,
    private readonly vaultService: VaultService,
    private readonly verificationService: VerificationService,
  ) {}

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
  ): { did: string; network: string; appId: bigint; document: object } {
    const network = this.getNetwork();
    const appId = this.getAppId();
    const did = buildDidIdentifier(network, appId, publicKey);
    const document = buildDidDocument({ did, publicKey, linkedWalletAddress });
    return { did, network, appId, document };
  }

  /**
   * Look up the locally cached DID record for a user. Returns `null` if
   * we have no record (the universal resolver / on-chain registry remains
   * the canonical source of truth in that case).
   */
  async resolveLocal(userId: string): Promise<DidRecord | null> {
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
    options: { force?: boolean } = {},
  ): Promise<PublishedDidInfo> {
    const publicKey: Buffer = await this.vaultService.getUserPublicKey(userId, vaultToken);
    return this.publishUserDid({
      userId,
      publicKey: new Uint8Array(publicKey),
      vaultToken,
      force: options.force,
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
  }): Promise<PublishedDidInfo> {
    const { userId, publicKey, vaultToken, force } = params;

    // Pull the latest linked wallet (if any) so the published document
    // reflects the link verification service's current state.
    const linkedWalletAddress = await this.resolveLinkedWalletAddress(userId);
    const built = this.buildDocumentForUser(publicKey, linkedWalletAddress);
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
