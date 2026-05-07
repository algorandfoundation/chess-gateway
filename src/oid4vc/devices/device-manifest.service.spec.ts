import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { base58 } from '@scure/base';

import { DeviceManifestService, canonicaliseJson } from './device-manifest.service';
import { Oid4vcUserDeviceManifest } from '../entities/oid4vc-user-device-manifest.entity';
import { Oid4vcUserDeviceManifestRevision } from '../entities/oid4vc-user-device-manifest-revision.entity';

/**
 * In-memory fakes for the two repos + DataSource.transaction. Keeps the
 * tests focused on the service's signature/version logic without
 * spinning up TypeORM.
 */
function createFakeRepos() {
  const manifests: Oid4vcUserDeviceManifest[] = [];
  const revisions: Oid4vcUserDeviceManifestRevision[] = [];
  let manifestSeq = 0;
  let revisionSeq = 0;

  const manifestRepo = {
    findOne: jest.fn(async ({ where }: any) => {
      const found = manifests.find(
        (m) =>
          (where.didKey === undefined || m.didKey === where.didKey) &&
          (where.userId === undefined || m.userId === where.userId),
      );
      if (!found) return null;
      const withRev = { ...found } as Oid4vcUserDeviceManifest;
      withRev.currentRevision =
        revisions.find((r) => r.id === found.currentRevisionId) ?? null;
      return withRev;
    }),
    create: jest.fn((partial: Partial<Oid4vcUserDeviceManifest>) => ({ ...partial })),
    save: jest.fn(async (m: Oid4vcUserDeviceManifest) => {
      if (!m.id) {
        m.id = `manifest-${++manifestSeq}`;
        m.createdAt = new Date();
        manifests.push(m);
      } else {
        const i = manifests.findIndex((x) => x.id === m.id);
        if (i >= 0) manifests[i] = { ...manifests[i], ...m };
      }
      m.updatedAt = new Date();
      return m;
    }),
  };

  const revisionRepo = {
    create: jest.fn((partial: Partial<Oid4vcUserDeviceManifestRevision>) => ({ ...partial })),
    save: jest.fn(async (r: Oid4vcUserDeviceManifestRevision) => {
      r.id = `rev-${++revisionSeq}`;
      r.receivedAt = new Date();
      revisions.push(r);
      return r;
    }),
  };

  const dataSource = {
    transaction: async <T>(fn: (em: any) => Promise<T>) => {
      const em = {
        getRepository: (entity: any) => {
          if (entity === Oid4vcUserDeviceManifest) return manifestRepo;
          if (entity === Oid4vcUserDeviceManifestRevision) return revisionRepo;
          throw new Error(`unexpected entity ${entity?.name}`);
        },
      };
      return fn(em);
    },
  };

  return { manifestRepo, revisionRepo, dataSource, manifests, revisions };
}

/**
 * Builds a valid (DID document, did:key, signed payload) tuple for the
 * given Ed25519 public key.
 */
function buildSignedManifest(opts: {
  publicKey: Buffer;
  privateKeySign: (msg: Buffer) => Buffer;
  version: number;
  signedAt?: string;
  extraServices?: unknown[];
}): {
  didKey: string;
  didDocument: Record<string, unknown>;
  signature: string;
  signedAt: string;
  version: number;
} {
  const prefixed = new Uint8Array(2 + opts.publicKey.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(opts.publicKey, 2);
  const didKey = `did:key:z${base58.encode(prefixed)}`;
  const publicKeyMultibase = `z${base58.encode(prefixed)}`;

  const didDocument: Record<string, unknown> = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: didKey,
    verificationMethod: [
      {
        id: `${didKey}#keys-1`,
        type: 'Ed25519VerificationKey2020',
        controller: didKey,
        publicKeyMultibase,
      },
    ],
    authentication: [`${didKey}#keys-1`],
    assertionMethod: [`${didKey}#keys-1`],
    service: opts.extraServices ?? [],
  };

  const signedAt = opts.signedAt ?? new Date().toISOString();
  const canonical = canonicaliseJson({
    didKey,
    version: opts.version,
    signedAt,
    didDocument,
  });
  const signature = opts
    .privateKeySign(Buffer.from(canonical, 'utf8'))
    .toString('base64');

  return { didKey, didDocument, signature, signedAt, version: opts.version };
}

describe('DeviceManifestService', () => {
  let keyPair: ReturnType<typeof generateKeyPairSync>;
  let publicKeyBytes: Buffer;
  let signWith: (msg: Buffer) => Buffer;

  beforeAll(() => {
    keyPair = generateKeyPairSync('ed25519');
    // Extract raw 32-byte public key from the SPKI export (last 32 bytes).
    const spki = keyPair.publicKey.export({ format: 'der', type: 'spki' });
    publicKeyBytes = Buffer.from(spki.subarray(spki.length - 32));
    signWith = (msg: Buffer) => cryptoSign(null, msg, keyPair.privateKey);
  });

  function newService(opts: { vaultConfigured?: boolean } = {}) {
    const fakes = createFakeRepos();
    const didService = {
      republishForManifest: jest.fn().mockResolvedValue({ did: 'did:algo:ABC', document: {}, txIds: ['tx1'] }),
    };
    const algoVaultToken = {
      isConfigured: jest.fn().mockReturnValue(opts.vaultConfigured ?? false),
      getToken: jest.fn().mockResolvedValue('vault-token'),
    };
    const service = new DeviceManifestService(
      fakes.manifestRepo as any,
      fakes.revisionRepo as any,
      fakes.dataSource as any,
      didService as any,
      algoVaultToken as any,
    );
    return { service, didService, algoVaultToken, ...fakes };
  }

  describe('canonicaliseJson', () => {
    it('sorts object keys recursively and omits whitespace', () => {
      expect(canonicaliseJson({ b: 1, a: { z: 2, y: 3 } })).toBe('{"a":{"y":3,"z":2},"b":1}');
    });
    it('passes through arrays in source order', () => {
      expect(canonicaliseJson([3, 1, 2])).toBe('[3,1,2]');
    });
  });

  describe('extractPrimaryEd25519Key', () => {
    it('returns the raw 32-byte public key when the document is consistent', () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      const out = service.extractPrimaryEd25519Key(m.didKey, m.didDocument);
      expect(out.equals(publicKeyBytes)).toBe(true);
    });
    it('rejects a document whose id does not match the supplied didKey', () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      m.didDocument.id = 'did:key:zSomethingElse';
      expect(() => service.extractPrimaryEd25519Key(m.didKey, m.didDocument)).toThrow(BadRequestException);
    });
    it('rejects when no verification method is controlled by the didKey', () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      (m.didDocument.verificationMethod as any[])[0].id = 'did:key:zForeign#keys-1';
      expect(() => service.extractPrimaryEd25519Key(m.didKey, m.didDocument)).toThrow(BadRequestException);
    });
  });

  describe('upsertManifest', () => {
    it('seeds a new manifest when trustedSeed=true and persists revision 1', async () => {
      const { service, manifests, revisions } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });

      const result = await service.upsertManifest({
        userId: 'user-1',
        didKey: m.didKey,
        version: m.version,
        signedAt: m.signedAt,
        didDocument: m.didDocument,
        signature: m.signature,
        trustedSeed: true,
      });

      expect(result.created).toBe(true);
      expect(manifests).toHaveLength(1);
      expect(revisions).toHaveLength(1);
      expect(manifests[0].userId).toBe('user-1');
      expect(manifests[0].didKey).toBe(m.didKey);
      expect(manifests[0].currentRevisionId).toBe(revisions[0].id);
      expect(revisions[0].version).toBe(1);
    });

    it('refuses to create a manifest when trustedSeed=false and the didKey is unknown', async () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await expect(
        service.upsertManifest({
          userId: 'user-1',
          didKey: m.didKey,
          version: m.version,
          signedAt: m.signedAt,
          didDocument: m.didDocument,
          signature: m.signature,
          trustedSeed: false,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('appends a new revision on increasing version', async () => {
      const { service, revisions } = newService();
      const m1 = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await service.upsertManifest({ userId: 'u', ...m1, trustedSeed: true });

      const m2 = buildSignedManifest({
        publicKey: publicKeyBytes,
        privateKeySign: signWith,
        version: 2,
        extraServices: [{ id: 'svc#1', type: 'PasskeyService', passkeys: [] }],
      });
      const result = await service.upsertManifest({ userId: 'u', ...m2, trustedSeed: false });

      expect(result.created).toBe(true);
      expect(revisions).toHaveLength(2);
      expect(revisions[1].version).toBe(2);
    });

    it('is idempotent on equal version (no new revision)', async () => {
      const { service, revisions } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 4 });
      await service.upsertManifest({ userId: 'u', ...m, trustedSeed: true });
      const again = await service.upsertManifest({ userId: 'u', ...m, trustedSeed: false });
      expect(again.created).toBe(false);
      expect(revisions).toHaveLength(1);
    });

    it('rejects an older version with ConflictException carrying the current version', async () => {
      const { service } = newService();
      const newer = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 5 });
      await service.upsertManifest({ userId: 'u', ...newer, trustedSeed: true });

      const older = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 3 });
      await expect(
        service.upsertManifest({ userId: 'u', ...older, trustedSeed: false }),
      ).rejects.toMatchObject({
        // ConflictException with a structured response payload
        response: { message: expect.any(String), currentVersion: 5 },
      });
    });

    it('rejects a tampered signature', async () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      // Mutate the document after signing.
      (m.didDocument.service as any[]).push({ id: 'evil#1', type: 'Evil' });
      await expect(
        service.upsertManifest({ userId: 'u', ...m, trustedSeed: true }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to update a manifest already owned by a different user', async () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await service.upsertManifest({ userId: 'alice', ...m, trustedSeed: true });

      const next = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 2 });
      await expect(
        service.upsertManifest({ userId: 'mallory', ...next, trustedSeed: true }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks updates after revoke()', async () => {
      const { service, manifestRepo } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await service.upsertManifest({ userId: 'u', ...m, trustedSeed: true });
      await service.revoke('u', m.didKey);

      const next = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 2 });
      await expect(
        service.upsertManifest({ userId: 'u', ...next, trustedSeed: false }),
      ).rejects.toThrow(ForbiddenException);
      // Ensure the soft-delete actually wrote
      expect(manifestRepo.save).toHaveBeenCalled();
    });
  });

  describe('on-chain anchor (hybrid did:algo integration)', () => {
    it('skips republishing when the OID4VC AppRole is not configured', async () => {
      const { service, didService } = newService({ vaultConfigured: false });
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await service.upsertManifest({ userId: 'u', ...m, trustedSeed: true });
      expect(didService.republishForManifest).not.toHaveBeenCalled();
    });

    it('publishes a manifest anchor + promoted keys when configured', async () => {
      const { service, didService, algoVaultToken } = newService({ vaultConfigured: true });

      // Build a manifest carrying a #keys-1 (primary, ignored) and an
      // additional HD-derived Ed25519 subkey under #account-0.
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      const subkey = generateKeyPairSync('ed25519');
      const subkeySpki = subkey.publicKey.export({ format: 'der', type: 'spki' });
      const subkeyRaw = Buffer.from(subkeySpki.subarray(subkeySpki.length - 32));
      const prefixed = new Uint8Array(2 + subkeyRaw.length);
      prefixed[0] = 0xed;
      prefixed[1] = 0x01;
      prefixed.set(subkeyRaw, 2);
      const subkeyMultibase = `z${base58.encode(prefixed)}`;
      (m.didDocument.verificationMethod as any[]).push({
        id: `${m.didKey}#account-0`,
        type: 'Ed25519VerificationKey2020',
        controller: m.didKey,
        publicKeyMultibase: subkeyMultibase,
      });

      // Re-sign the (mutated) document.
      const reCanonical = canonicaliseJson({
        didKey: m.didKey,
        version: m.version,
        signedAt: m.signedAt,
        didDocument: m.didDocument,
      });
      const reSigned = signWith(Buffer.from(reCanonical, 'utf8')).toString('base64');

      await service.upsertManifest({
        userId: 'u',
        didKey: m.didKey,
        version: m.version,
        signedAt: m.signedAt,
        didDocument: m.didDocument,
        signature: reSigned,
        trustedSeed: true,
      });

      expect(algoVaultToken.getToken).toHaveBeenCalled();
      expect(didService.republishForManifest).toHaveBeenCalledTimes(1);
      const [userId, token, args] = didService.republishForManifest.mock.calls[0];
      expect(userId).toBe('u');
      expect(token).toBe('vault-token');
      expect(args.manifestAnchor.version).toBe(1);
      expect(args.manifestAnchor.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(args.promotedKeys).toHaveLength(1);
      expect(args.promotedKeys[0].fragment).toBe('account-0');
      expect(args.promotedKeys[0].algorithm).toBe('Ed25519');
      expect(Buffer.from(args.promotedKeys[0].publicKey).equals(subkeyRaw)).toBe(true);
    });

    it('does not roll back the revision when the chain publish fails', async () => {
      const { service, didService, revisions } = newService({ vaultConfigured: true });
      didService.republishForManifest.mockRejectedValueOnce(new Error('algod down'));
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      const result = await service.upsertManifest({ userId: 'u', ...m, trustedSeed: true });
      expect(result.created).toBe(true);
      expect(revisions).toHaveLength(1);
    });

    it('skips republishing on idempotent (same-version) re-uploads', async () => {
      const { service, didService } = newService({ vaultConfigured: true });
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await service.upsertManifest({ userId: 'u', ...m, trustedSeed: true });
      didService.republishForManifest.mockClear();
      await service.upsertManifest({ userId: 'u', ...m, trustedSeed: false });
      expect(didService.republishForManifest).not.toHaveBeenCalled();
    });
  });

  describe('extractPromotedKeys', () => {
    it('skips the primary #keys-1 verification method', () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      const out = service.extractPromotedKeys(m.didDocument);
      expect(out).toEqual([]);
    });
  });

  describe('getCurrentByUser', () => {
    it('throws NotFound when no manifest is seeded', async () => {
      const { service } = newService();
      await expect(service.getCurrentByUser('nope')).rejects.toThrow(NotFoundException);
    });

    it('returns the current revision when seeded', async () => {
      const { service } = newService();
      const m = buildSignedManifest({ publicKey: publicKeyBytes, privateKeySign: signWith, version: 1 });
      await service.upsertManifest({ userId: 'u', ...m, trustedSeed: true });

      const out = await service.getCurrentByUser('u');
      expect(out.userId).toBe('u');
      expect(out.didKey).toBe(m.didKey);
      expect(out.currentRevision?.version).toBe(1);
    });
  });
});
