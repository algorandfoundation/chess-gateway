import createMockInstance from 'jest-create-mock-instance';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { DidController } from './did.controller';
import { DidAlreadyPublishedError, DidService } from './did.service';
import { DidRecord } from './entities/did-record.entity';

describe('DidController', () => {
  let didService: jest.Mocked<DidService>;
  let controller: DidController;

  const VAULT_TOKEN = 'vault-token';
  const REQUEST = { vault_token: VAULT_TOKEN } as any;

  beforeEach(() => {
    didService = createMockInstance(DidService);
    controller = new DidController(didService);
  });

  describe('publish', () => {
    it('delegates to publishForUser and returns the publication result', async () => {
      didService.publishForUser.mockResolvedValueOnce({
        did: 'did:algo:testnet:app:1:abcd',
        document: { id: 'did:algo:testnet:app:1:abcd' },
        txIds: ['t1'],
      });

      const result = await controller.publish(REQUEST, 'jim');

      expect(didService.publishForUser).toHaveBeenCalledWith('jim', VAULT_TOKEN, { force: undefined });
      expect(result).toEqual({
        did: 'did:algo:testnet:app:1:abcd',
        document: { id: 'did:algo:testnet:app:1:abcd' },
        txIds: ['t1'],
      });
    });

    it('forwards the force flag through to the service', async () => {
      didService.publishForUser.mockResolvedValueOnce({ did: 'd', document: {}, txIds: [] });
      await controller.publish(REQUEST, 'jim', true);
      expect(didService.publishForUser).toHaveBeenCalledWith('jim', VAULT_TOKEN, { force: true });
    });

    it('maps DidAlreadyPublishedError to a 409 ConflictException', async () => {
      didService.publishForUser.mockRejectedValueOnce(new DidAlreadyPublishedError('jim'));
      await expect(controller.publish(REQUEST, 'jim')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows any other publish error untouched', async () => {
      const err = new Error('chain refused');
      didService.publishForUser.mockRejectedValueOnce(err);
      await expect(controller.publish(REQUEST, 'jim')).rejects.toBe(err);
    });
  });

  describe('resolveUser', () => {
    it('returns the cached record projected through DidRecordResponseDto', async () => {
      const updatedAt = new Date('2024-01-01T00:00:00Z');
      const record: DidRecord = {
        user_id: 'jim',
        did: 'did:algo:testnet:app:1:ab',
        network: 'testnet',
        app_id: '1',
        document: JSON.stringify({ id: 'did:algo:testnet:app:1:ab' }),
        tx_ids: 't1,t2',
        created_at: updatedAt,
        updated_at: updatedAt,
      };
      didService.resolveLocal.mockResolvedValueOnce(record);

      const dto = await controller.resolveUser('jim');
      expect(dto).toEqual({
        userId: 'jim',
        did: record.did,
        network: 'testnet',
        appId: '1',
        document: { id: record.did },
        txIds: ['t1', 't2'],
        updatedAt,
      });
    });

    it('emits an empty txIds array when tx_ids is null', async () => {
      didService.resolveLocal.mockResolvedValueOnce({
        user_id: 'jim',
        did: 'd',
        network: 'n',
        app_id: '1',
        document: '{}',
        tx_ids: null,
        created_at: new Date(),
        updated_at: new Date(),
      } as DidRecord);

      const dto = await controller.resolveUser('jim');
      expect(dto.txIds).toEqual([]);
    });

    it('throws 404 when no record is cached', async () => {
      didService.resolveLocal.mockResolvedValueOnce(null);
      await expect(controller.resolveUser('jim')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listRecords', () => {
    it('projects every record returned by the service', async () => {
      didService.listRecords.mockResolvedValueOnce([
        {
          user_id: 'a',
          did: 'd1',
          network: 'n',
          app_id: '1',
          document: '{"id":"d1"}',
          tx_ids: 'x',
          created_at: new Date(),
          updated_at: new Date(),
        } as DidRecord,
        {
          user_id: 'b',
          did: 'd2',
          network: 'n',
          app_id: '1',
          document: '{}',
          tx_ids: null,
          created_at: new Date(),
          updated_at: new Date(),
        } as DidRecord,
      ]);

      const dtos = await controller.listRecords();
      expect(dtos).toHaveLength(2);
      expect(dtos[0].userId).toBe('a');
      expect(dtos[0].txIds).toEqual(['x']);
      expect(dtos[1].userId).toBe('b');
      expect(dtos[1].txIds).toEqual([]);
    });
  });

  describe('deleteRecord', () => {
    it('does nothing extra when the on-chain doc was deleted', async () => {
      didService.deleteUserDid.mockResolvedValueOnce({ txIds: ['t1'], cacheRemoved: true });
      await expect(controller.deleteRecord(REQUEST, 'jim')).resolves.toBeUndefined();
      expect(didService.deleteUserDid).toHaveBeenCalledWith('jim', VAULT_TOKEN);
    });

    it('does nothing extra when only the cache row existed', async () => {
      didService.deleteUserDid.mockResolvedValueOnce({ txIds: null, cacheRemoved: true });
      await expect(controller.deleteRecord(REQUEST, 'jim')).resolves.toBeUndefined();
    });

    it('throws 404 only when neither on-chain doc nor cache row existed', async () => {
      didService.deleteUserDid.mockResolvedValueOnce({ txIds: null, cacheRemoved: false });
      await expect(controller.deleteRecord(REQUEST, 'jim')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
