import createMockInstance from 'jest-create-mock-instance';
import { ConfigService } from '@nestjs/config';
import { Address } from '@algorandfoundation/algokit-utils';
import { Repository } from 'typeorm';

import { DidAlreadyPublishedError, DidService } from './did.service';
import { DidRecord } from './entities/did-record.entity';
import { ChainService } from '../chain/chain.service';
import { VaultService } from '../vault/vault.service';
import { VerificationService } from '../link/verification/verification.service';

// Mock the on-chain primitives so the service can run without a real
// algod node or DIDAlgoStorage contract.
jest.mock('../../libs/did-algo', () => {
  const actual = jest.requireActual('../../libs/did-algo');
  return {
    ...actual,
    DidAlgoStorageClient: jest.fn(),
    uploadDIDDocument: jest.fn(),
    deleteDIDDocument: jest.fn(),
  };
});
jest.mock('./vault-signer', () => ({
  buildManagerSigner: jest.fn(),
}));

import { DidAlgoStorageClient, deleteDIDDocument, uploadDIDDocument } from '../../libs/did-algo';
import { buildManagerSigner } from './vault-signer';

const DidAlgoStorageClientMock = DidAlgoStorageClient as unknown as jest.Mock;
const uploadDIDDocumentMock = uploadDIDDocument as unknown as jest.Mock;
const deleteDIDDocumentMock = deleteDIDDocument as unknown as jest.Mock;
const buildManagerSignerMock = buildManagerSigner as unknown as jest.Mock;

describe('DidService', () => {
  // --- Fakes / harness ----------------------------------------------------

  type RepoMock<T> = {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  } & Pick<Repository<T>, 'findOne' | 'find' | 'save' | 'create' | 'delete'>;

  const buildRepoMock = <T>(): RepoMock<T> => {
    const repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((row) => row),
      create: jest.fn().mockImplementation((row) => row),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    return repo as unknown as RepoMock<T>;
  };

  let didRepo: RepoMock<DidRecord>;
  let configService: jest.Mocked<ConfigService>;
  let chainService: jest.Mocked<ChainService>;
  let vaultService: jest.Mocked<VaultService>;
  let verificationService: jest.Mocked<VerificationService>;
  let didService: DidService;

  const APP_ID = '1234';
  const PUB_KEY = new Uint8Array(32).fill(0x77);
  const MANAGER_PUB_KEY = new Uint8Array(32).fill(0x88);
  const MANAGER_ADDRESS = new Address(MANAGER_PUB_KEY);

  const metadataValueMock = jest.fn();

  beforeEach(() => {
    didRepo = buildRepoMock<DidRecord>();
    configService = createMockInstance(ConfigService);
    chainService = createMockInstance(ChainService);
    vaultService = createMockInstance(VaultService);
    verificationService = createMockInstance(VerificationService);

    configService.get.mockImplementation((key: string) => {
      const cfg: Record<string, string> = {
        DID_ALGO_APP_ID: APP_ID,
        GENESIS_ID: 'testnet-v1.0',
        NODE_HTTP_SCHEME: 'http',
        NODE_HOST: 'localhost',
        NODE_PORT: '4001',
        NODE_TOKEN: '',
      };
      return cfg[key];
    });

    verificationService.findByPlayerId.mockResolvedValue([]);
    vaultService.getUserPublicKey.mockResolvedValue(Buffer.from(PUB_KEY));
    buildManagerSignerMock.mockResolvedValue({
      address: MANAGER_ADDRESS,
      signer: jest.fn(),
    });

    metadataValueMock.mockReset();
    DidAlgoStorageClientMock.mockImplementation(() => ({
      state: {
        box: { metadata: { value: metadataValueMock } },
        global: { currentIndex: jest.fn().mockResolvedValue(0n) },
      },
      appClient: { getABIMethod: (n: string) => ({ name: n }) },
    }));
    uploadDIDDocumentMock.mockResolvedValue(['tx-upload-1']);
    deleteDIDDocumentMock.mockResolvedValue(['tx-del-1']);

    didService = new DidService(
      didRepo as unknown as Repository<DidRecord>,
      configService,
      chainService,
      vaultService,
      verificationService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // --- buildDocumentForUser ----------------------------------------------

  describe('buildDocumentForUser', () => {
    it('builds the canonical did identifier from GENESIS_ID + DID_ALGO_APP_ID', () => {
      const built = didService.buildDocumentForUser(PUB_KEY);
      expect(built.network).toBe('testnet');
      expect(built.appId).toBe(BigInt(APP_ID));
      expect(built.did).toBe(`did:algo:testnet:app:${APP_ID}:${Buffer.from(PUB_KEY).toString('hex')}`);
      expect(built.document).toMatchObject({ id: built.did });
    });

    it('throws when DID_ALGO_APP_ID is not configured', () => {
      configService.get.mockImplementation(() => undefined);
      expect(() => didService.buildDocumentForUser(PUB_KEY)).toThrow(/DID_ALGO_APP_ID/);
    });
  });

  // --- Cache helpers ------------------------------------------------------

  describe('resolveLocal / listRecords / deleteRecord / buildUserDidInfo', () => {
    it('resolveLocal returns the row from the repository', async () => {
      const row = { user_id: 'u1', did: 'did:algo:...' } as DidRecord;
      didRepo.findOne.mockResolvedValueOnce(row);
      await expect(didService.resolveLocal('u1')).resolves.toBe(row);
      expect(didRepo.findOne).toHaveBeenCalledWith({ where: { user_id: 'u1' } });
    });

    it('listRecords returns rows ordered by updated_at DESC', async () => {
      didRepo.find.mockResolvedValueOnce([]);
      await didService.listRecords();
      expect(didRepo.find).toHaveBeenCalledWith({ order: { updated_at: 'DESC' } });
    });

    it('deleteRecord returns true only when affected > 0', async () => {
      didRepo.delete.mockResolvedValueOnce({ affected: 1 } as any);
      await expect(didService.deleteRecord('u1')).resolves.toBe(true);
      didRepo.delete.mockResolvedValueOnce({ affected: 0 } as any);
      await expect(didService.deleteRecord('u1')).resolves.toBe(false);
    });

    it('buildUserDidInfo returns the cached did or null', async () => {
      didRepo.findOne.mockResolvedValueOnce(null);
      await expect(didService.buildUserDidInfo('u1')).resolves.toBeNull();
      didRepo.findOne.mockResolvedValueOnce({ did: 'did:algo:foo' } as DidRecord);
      await expect(didService.buildUserDidInfo('u1')).resolves.toBe('did:algo:foo');
    });
  });

  // --- hasOnChainDocument ------------------------------------------------

  describe('hasOnChainDocument', () => {
    it('returns true when metadata is present', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });
      await expect(didService.hasOnChainDocument(PUB_KEY)).resolves.toBe(true);
    });

    it('returns false when metadata is undefined', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);
      await expect(didService.hasOnChainDocument(PUB_KEY)).resolves.toBe(false);
    });

    it('returns false when the contract reports a 404 "box not found"', async () => {
      metadataValueMock.mockRejectedValueOnce(
        new Error('Request to /v2/applications/1234/box failed with status 404: box not found'),
      );
      await expect(didService.hasOnChainDocument(PUB_KEY)).resolves.toBe(false);
    });

    it('rethrows non-404 errors from the contract', async () => {
      metadataValueMock.mockRejectedValueOnce(new Error('boom: status 500: something else'));
      await expect(didService.hasOnChainDocument(PUB_KEY)).rejects.toThrow(/boom/);
    });
  });

  // --- publishUserDid -----------------------------------------------------

  describe('publishUserDid', () => {
    it('publishes a fresh document when no metadata exists on chain', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);

      const result = await didService.publishUserDid({
        userId: 'jim',
        publicKey: PUB_KEY,
        vaultToken: 'vt',
      });

      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
      expect(uploadDIDDocumentMock).toHaveBeenCalledTimes(1);
      // Cache row written after the on-chain success.
      expect(didRepo.save).toHaveBeenCalled();
      expect(result.txIds).toEqual(['tx-upload-1']);
      expect(result.did).toMatch(/^did:algo:testnet:app:1234:/);
    });

    it('throws DidAlreadyPublishedError when metadata exists and force is not set', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });

      await expect(
        didService.publishUserDid({ userId: 'jim', publicKey: PUB_KEY, vaultToken: 'vt' }),
      ).rejects.toBeInstanceOf(DidAlreadyPublishedError);
      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
      expect(uploadDIDDocumentMock).not.toHaveBeenCalled();
      // No cache row written on conflict.
      expect(didRepo.save).not.toHaveBeenCalled();
    });

    it('force: deletes the existing on-chain document before uploading the new one', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });

      const result = await didService.publishUserDid({
        userId: 'jim',
        publicKey: PUB_KEY,
        vaultToken: 'vt',
        force: true,
      });

      // Both on-chain primitives must run, in order.
      expect(deleteDIDDocumentMock).toHaveBeenCalledTimes(1);
      expect(uploadDIDDocumentMock).toHaveBeenCalledTimes(1);
      const deleteOrder = deleteDIDDocumentMock.mock.invocationCallOrder[0];
      const uploadOrder = uploadDIDDocumentMock.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(uploadOrder);
      expect(result.did).toMatch(/^did:algo:testnet:app:1234:/);
    });

    it('propagates the upload error and does not write a cache row', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);
      uploadDIDDocumentMock.mockRejectedValueOnce(new Error('chain refused'));

      await expect(didService.publishUserDid({ userId: 'jim', publicKey: PUB_KEY, vaultToken: 'vt' })).rejects.toThrow(
        /chain refused/,
      );
      expect(didRepo.save).not.toHaveBeenCalled();
    });
  });

  // --- deleteUserDid ------------------------------------------------------

  describe('deleteUserDid', () => {
    it('runs deleteDIDDocument and clears the local cache when the on-chain doc exists', async () => {
      metadataValueMock.mockResolvedValueOnce({ start: 0n, end: 0n, status: 1, lastDeleted: 0n, endSize: 0n });
      didRepo.delete.mockResolvedValueOnce({ affected: 1 } as any);

      const result = await didService.deleteUserDid('jim', 'vt');

      expect(deleteDIDDocumentMock).toHaveBeenCalledTimes(1);
      expect(didRepo.delete).toHaveBeenCalledWith({ user_id: 'jim' });
      expect(result.txIds).toEqual(['tx-del-1']);
      expect(result.cacheRemoved).toBe(true);
    });

    it('skips deleteDIDDocument when no on-chain doc exists but still drops cache row if any', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);
      didRepo.delete.mockResolvedValueOnce({ affected: 1 } as any);

      const result = await didService.deleteUserDid('jim', 'vt');

      expect(deleteDIDDocumentMock).not.toHaveBeenCalled();
      expect(result.txIds).toBeNull();
      expect(result.cacheRemoved).toBe(true);
    });

    it('returns txIds=null + cacheRemoved=false when nothing existed at all', async () => {
      metadataValueMock.mockResolvedValueOnce(undefined);
      didRepo.delete.mockResolvedValueOnce({ affected: 0 } as any);

      const result = await didService.deleteUserDid('jim', 'vt');
      expect(result).toEqual({ txIds: null, cacheRemoved: false });
    });
  });
});
