import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { base58 } from '@scure/base';

import { Oid4vcUserDeviceManifest } from '../entities/oid4vc-user-device-manifest.entity';
import { Oid4vcUserDeviceManifestRevision } from '../entities/oid4vc-user-device-manifest-revision.entity';
import { DidService } from '../../did/did.service';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { ManifestAnchor, PromotedVerificationMethod } from '../../did/did-document';

/**
 * The signed payload structure the wallet computes the signature over.
 * See `src/oid4vc/DISCOVERY.md` — "Wire format".
 */
interface ManifestSignedPayload {
  didKey: string;
  version: number;
  signedAt: string;
  didDocument: Record<string, unknown>;
}

export interface UpsertManifestInput extends ManifestSignedPayload {
  userId: string;
  signature: string;
  /**
   * When true, this call is allowed to *create* the manifest row for a
   * previously unseen `didKey`. Set only by the link-attestation seed
   * path (where device integrity has just been verified).
   */
  trustedSeed: boolean;
}

export interface UpsertManifestResult {
  manifest: Oid4vcUserDeviceManifest;
  revision: Oid4vcUserDeviceManifestRevision;
  /**
   * True when the upload introduced a new revision; false when it was a
   * no-op (same `version` already on file).
   */
  created: boolean;
}

/** Standard SPKI prefix for Ed25519 public keys (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** did:key multicodec varint for Ed25519 public keys. */
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

@Injectable()
export class DeviceManifestService {
  private readonly logger = new Logger(DeviceManifestService.name);

  constructor(
    @InjectRepository(Oid4vcUserDeviceManifest)
    private readonly manifestRepo: Repository<Oid4vcUserDeviceManifest>,
    @InjectRepository(Oid4vcUserDeviceManifestRevision)
    private readonly revisionRepo: Repository<Oid4vcUserDeviceManifestRevision>,
    private readonly dataSource: DataSource,
    private readonly didService: DidService,
    private readonly algoVaultToken: AlgoVaultTokenProvider,
  ) {}

  /**
   * Validates the supplied manifest, verifies its signature, and either
   * creates a new manifest row (when `trustedSeed` is set and none
   * exists) or appends a new revision to an existing one.
   *
   * Idempotent on equal `version` — a duplicate push of the
   * already-current revision returns `created: false`.
   */
  async upsertManifest(input: UpsertManifestInput): Promise<UpsertManifestResult> {
    const { userId, didKey, version, signedAt, didDocument, signature, trustedSeed } = input;

    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('version must be a positive integer');
    }

    const signedAtDate = new Date(signedAt);
    if (Number.isNaN(signedAtDate.getTime())) {
      throw new BadRequestException('signedAt must be a valid ISO 8601 timestamp');
    }

    // 1. Resolve the primary verification method out of the document
    //    and 2. confirm it matches the supplied didKey.
    const publicKey = this.extractPrimaryEd25519Key(didKey, didDocument);

    // 3. Verify the signature over the canonicalised payload.
    this.verifyManifestSignature(publicKey, { didKey, version, signedAt, didDocument }, signature);

    // 4-6. Persist atomically.
    const result = await this.dataSource.transaction(async (em) => {
      const manifestRepo = em.getRepository(Oid4vcUserDeviceManifest);
      const revisionRepo = em.getRepository(Oid4vcUserDeviceManifestRevision);

      let manifest = await manifestRepo.findOne({
        where: { didKey },
        relations: { currentRevision: true },
      });

      if (manifest && manifest.userId !== userId) {
        // Same did:key claimed by two different users — refuse.
        throw new ForbiddenException('didKey is already bound to a different user');
      }

      if (!manifest) {
        if (!trustedSeed) {
          throw new ForbiddenException(
            'Unknown didKey for this user; manifest must be seeded via link attestation first',
          );
        }
        manifest = manifestRepo.create({
          userId,
          didKey,
          trustedAt: new Date(),
        });
        manifest = await manifestRepo.save(manifest);
      } else if (manifest.revokedAt) {
        throw new ForbiddenException('Manifest is revoked; no further updates accepted');
      }

      const current = manifest.currentRevision ?? null;
      if (current) {
        if (version === current.version) {
          // Idempotent re-upload of the same version.
          return { manifest, revision: current, created: false };
        }
        if (version < current.version) {
          throw new ConflictException({
            message: 'Manifest version is older than the currently-stored revision',
            currentVersion: current.version,
          });
        }
      }

      const revision = revisionRepo.create({
        manifestId: manifest.id,
        version,
        document: didDocument,
        signature,
        signedAt: signedAtDate,
      });
      const savedRevision = await revisionRepo.save(revision);

      manifest.currentRevisionId = savedRevision.id;
      manifest.currentRevision = savedRevision;
      const savedManifest = await manifestRepo.save(manifest);

      this.logger.log(
        `Stored device manifest revision userId=${userId} didKey=${didKey} version=${version} revisionId=${savedRevision.id}`,
      );
      return { manifest: savedManifest, revision: savedRevision, created: true };
    });

    // Hybrid `did:algo` integration — when a new revision was committed,
    // anchor its hash + promote any wallet-managed subkeys onto the
    // user's on-chain DID document. Done *outside* the DB transaction so
    // a chain failure does not roll back the accepted revision; on the
    // next push the wallet will simply re-sync.
    if (result.created) {
      await this.anchorRevisionOnChain(userId, result.revision, didDocument).catch((err) => {
        this.logger.warn(
          `Failed to anchor manifest revision on chain userId=${userId} version=${result.revision.version}: ${(err as Error).message}`,
        );
      });
    }

    return result;
  }

  /**
   * Republish the user's `did:algo` document carrying:
   *   - a `DeviceManifestAnchor` service entry committing to the canonical
   *     hash + version of the supplied revision, and
   *   - one verification method per wallet-managed subkey extracted from
   *     the manifest (HD-derived account keys, passkey keys).
   *
   * Best-effort by design — see {@link upsertManifest}'s call site.
   */
  private async anchorRevisionOnChain(
    userId: string,
    revision: Oid4vcUserDeviceManifestRevision,
    didDocument: Record<string, unknown>,
  ): Promise<void> {
    if (!this.algoVaultToken.isConfigured()) {
      this.logger.debug(
        `Skipping on-chain manifest anchor (OID4VC AppRole not configured) userId=${userId}`,
      );
      return;
    }

    const manifestAnchor: ManifestAnchor = {
      hash: this.computeManifestHash(revision),
      version: revision.version,
    };
    const promotedKeys = this.extractPromotedKeys(didDocument);

    const token = await this.algoVaultToken.getToken();
    await this.didService.republishForManifest(userId, token, {
      manifestAnchor,
      promotedKeys,
    });
    this.logger.log(
      `Anchored device manifest revision on chain userId=${userId} version=${revision.version} promotedKeys=${promotedKeys.length}`,
    );
  }

  /**
   * Computes the canonical SHA-256 hash of a manifest revision (`sha256:<hex>`).
   *
   * Verifiers re-canonicalise the manifest payload they receive
   * off-chain and compare against this hash to confirm it matches the
   * version the user has anchored on chain.
   *
   * Exposed for unit tests.
   */
  computeManifestHash(revision: Oid4vcUserDeviceManifestRevision): string {
    const payload = {
      didKey: '', // filled below from the manifest row
      version: revision.version,
      signedAt: revision.signedAt.toISOString(),
      didDocument: revision.document,
    };
    // The didKey is whatever the document committed to — the wallet's
    // signature already covers it.
    if (revision.document && typeof revision.document === 'object') {
      const id = (revision.document as Record<string, unknown>)['id'];
      if (typeof id === 'string') payload.didKey = id;
    }
    const canonical = canonicaliseJson(payload);
    return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * Walks the manifest's DID document and returns every promotable
   * verification method (HD-derived Ed25519 / P-256 plus passkey P-256
   * keys advertised under `PasskeyService`). The `#keys-1` primary VM
   * is intentionally excluded — it's already represented on chain by
   * the `did:algo` document's primary verification method.
   *
   * Per the discovery doc: only the public key bytes cross this
   * boundary. Per-key metadata (derivation path, origin, counter)
   * stays off chain.
   *
   * Exposed for unit tests.
   */
  extractPromotedKeys(didDocument: Record<string, unknown>): PromotedVerificationMethod[] {
    const out: PromotedVerificationMethod[] = [];
    const seenFragments = new Set<string>();

    const docId = typeof didDocument['id'] === 'string' ? (didDocument['id'] as string) : '';
    const verificationMethods = Array.isArray(didDocument['verificationMethod'])
      ? (didDocument['verificationMethod'] as Record<string, unknown>[])
      : [];

    for (const vm of verificationMethods) {
      const id = vm['id'];
      const multibase = vm['publicKeyMultibase'];
      if (typeof id !== 'string' || typeof multibase !== 'string' || !multibase.startsWith('z')) {
        continue;
      }
      // Skip the primary key — keys-1 / id without a fragment.
      const fragmentIdx = id.indexOf('#');
      if (fragmentIdx < 0) continue;
      const fragment = id.slice(fragmentIdx + 1);
      if (!fragment || fragment === 'keys-1') continue;
      if (seenFragments.has(fragment)) continue;

      let decoded: Uint8Array;
      try {
        decoded = base58.decode(multibase.slice(1));
      } catch {
        continue;
      }

      // Ed25519: 0xed 0x01 prefix + 32 bytes.
      if (
        decoded.length === 34 &&
        decoded[0] === ED25519_MULTICODEC_PREFIX[0] &&
        decoded[1] === ED25519_MULTICODEC_PREFIX[1]
      ) {
        out.push({
          fragment,
          algorithm: 'Ed25519',
          publicKey: decoded.slice(2),
        });
        seenFragments.add(fragment);
        continue;
      }
      // P-256: 0x80 0x24 prefix + 33 bytes (compressed).
      if (decoded.length === 35 && decoded[0] === 0x80 && decoded[1] === 0x24) {
        out.push({
          fragment,
          algorithm: 'P-256',
          publicKey: decoded.slice(2),
        });
        seenFragments.add(fragment);
        continue;
      }
      // Anything else (unknown curve / bad encoding) is silently
      // ignored — the manifest still carries the metadata the wallet
      // needs locally; we just don't promote what we can't represent.
    }

    // Suppress unused-warn for docId (kept for future verification).
    void docId;
    return out;
  }

  /**
   * Returns the manifest + current revision for the given user, or
   * throws `NotFoundException`.
   */
  async getCurrentByUser(userId: string, didKey?: string): Promise<Oid4vcUserDeviceManifest> {
    const where: Record<string, unknown> = { userId };
    if (didKey) where.didKey = didKey;
    const manifest = await this.manifestRepo.findOne({
      where,
      relations: { currentRevision: true },
    });
    if (!manifest) {
      throw new NotFoundException('No device manifest for this user');
    }
    return manifest;
  }

  /**
   * Soft-revokes a manifest (used by device-loss / re-link flows).
   */
  async revoke(userId: string, didKey: string): Promise<void> {
    const manifest = await this.manifestRepo.findOne({ where: { userId, didKey } });
    if (!manifest) {
      throw new NotFoundException('No device manifest for this user/didKey');
    }
    if (manifest.revokedAt) return;
    manifest.revokedAt = new Date();
    await this.manifestRepo.save(manifest);
  }

  /**
   * Locates the primary Ed25519 verification method in the supplied
   * document and returns the raw 32-byte public key. Also confirms
   * that re-encoding it with the multibase + multicodec prefix yields
   * the supplied `didKey` (anti confused-deputy).
   *
   * Exposed for unit tests.
   */
  extractPrimaryEd25519Key(didKey: string, didDocument: Record<string, unknown>): Buffer {
    const docId = didDocument['id'];
    if (docId !== didKey) {
      throw new BadRequestException(
        `didDocument.id (${String(docId)}) does not match didKey (${didKey})`,
      );
    }

    const verificationMethods = didDocument['verificationMethod'];
    if (!Array.isArray(verificationMethods) || verificationMethods.length === 0) {
      throw new BadRequestException('didDocument.verificationMethod is missing or empty');
    }

    // The wallet's primary VM has id === did or id === did + '#…' AND the
    // controller is the did itself. We pick the first VM whose id starts
    // with the did and whose key decodes back to the did:key.
    const candidates = verificationMethods.filter((vm: unknown): vm is Record<string, unknown> => {
      if (!vm || typeof vm !== 'object') return false;
      const id = (vm as Record<string, unknown>).id;
      return typeof id === 'string' && (id === didKey || id.startsWith(`${didKey}#`));
    });

    if (candidates.length === 0) {
      throw new BadRequestException('No verification method controlled by the didKey');
    }

    for (const vm of candidates) {
      const multibase = vm['publicKeyMultibase'];
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
      const rawKey = Buffer.from(decoded.slice(2));
      const reEncoded = `did:key:z${base58.encode(decoded)}`;
      if (reEncoded === didKey) {
        return rawKey;
      }
    }

    throw new BadRequestException(
      'No Ed25519 verification method whose public key derives the supplied didKey',
    );
  }

  /**
   * Verifies the manifest signature against the wallet's primary
   * Ed25519 public key. Exposed for unit tests.
   */
  verifyManifestSignature(
    publicKey: Buffer,
    payload: ManifestSignedPayload,
    signatureBase64: string,
  ): void {
    const canonical = canonicaliseJson(payload);
    const message = Buffer.from(canonical, 'utf8');

    let signature: Buffer;
    try {
      signature = Buffer.from(signatureBase64, 'base64');
    } catch {
      throw new BadRequestException('signature is not valid base64');
    }
    if (signature.length !== 64) {
      throw new BadRequestException('Ed25519 signature must be 64 bytes');
    }

    const spki = Buffer.concat([ED25519_SPKI_PREFIX, publicKey]);
    const keyObject = createPublicKey({ key: spki, format: 'der', type: 'spki' });

    // Node accepts `null` as the algorithm for Ed25519 (PureEdDSA).
    const ok = cryptoVerify(null, message, keyObject, signature);
    if (!ok) {
      throw new BadRequestException('Manifest signature verification failed');
    }
  }
}

/**
 * RFC 8785-style JSON Canonicalisation (subset sufficient for our
 * payloads: object keys sorted lexicographically, no whitespace, no
 * exotic Number values). The wallet performs the same transformation
 * before signing.
 */
export function canonicaliseJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicaliseJson(v)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  const parts = entries.map(
    (k) => `${JSON.stringify(k)}:${canonicaliseJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}
