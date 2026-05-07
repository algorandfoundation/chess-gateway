import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Oid4vcIssuerService } from './oid4vc-issuer.service';
import { Oid4vcAgentProvider } from '../agent/oid4vc-agent.provider';
import { Oid4vcConfig } from '../oid4vc.config';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';

describe('Oid4vcIssuerService', () => {
  const mockRepo = {
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({ id: 'local-1', ...v })),
    findOneBy: jest.fn(),
    find: jest.fn(async () => []),
  };

  const issuerApi = {
    getIssuerByIssuerId: jest.fn(),
    createIssuer: jest.fn(),
    updateIssuerMetadata: jest.fn(),
    createCredentialOffer: jest.fn(),
  };

  const fakeAgent = { modules: { openId4VcIssuer: issuerApi } } as never;

  const agentProvider = {
    getAgent: jest.fn(async () => fakeAgent),
    setCredentialMapper: jest.fn(),
    // The mapper resolves the issuer DID via `ensureIssuerDid` (did:algo
    // only, no fallback) and binds credentials to the user's did:algo.
    ensureIssuerDid: jest.fn(async () => ({
      did: 'did:algo:testnet:app:1:' + 'b'.repeat(64),
      verificationMethodId: 'did:algo:testnet:app:1:' + 'b'.repeat(64) + '#keys-1',
    })),
    resolveUserAlgoDid: jest.fn(async () => null as string | null),
    resolveUserAlgoDidDocument: jest.fn(
      async () =>
        null as null | { did: string; verificationMethodIds: string[] },
    ),
  };

  const config = { autoInit: false, issuerDisplayName: 'Test' } as Oid4vcConfig;

  let service: Oid4vcIssuerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        Oid4vcIssuerService,
        { provide: Oid4vcAgentProvider, useValue: agentProvider },
        { provide: Oid4vcConfig, useValue: config },
        { provide: getRepositoryToken(Oid4vcIssuanceSession), useValue: mockRepo },
      ],
    }).compile();
    service = moduleRef.get(Oid4vcIssuerService);
  });

  it('registers a credential mapper on bootstrap', async () => {
    await service.onModuleInit();
    expect(agentProvider.setCredentialMapper).toHaveBeenCalledTimes(1);
    expect(typeof agentProvider.setCredentialMapper.mock.calls[0][0]).toBe('function');
  });

  describe('ensureIssuer', () => {
    it('returns the existing issuer when one is already present and configs match', async () => {
      const { DEFAULT_CREDENTIAL_CONFIGURATIONS } = await import('./oid4vc-issuer.service');
      issuerApi.getIssuerByIssuerId.mockResolvedValue({
        issuerId: Oid4vcIssuerService.ISSUER_ID,
        credentialConfigurationsSupported: DEFAULT_CREDENTIAL_CONFIGURATIONS,
      });
      const r = await service.ensureIssuer();
      expect(r).toMatchObject({ issuerId: Oid4vcIssuerService.ISSUER_ID });
      expect(issuerApi.createIssuer).not.toHaveBeenCalled();
      expect(issuerApi.updateIssuerMetadata).not.toHaveBeenCalled();
    });

    it('refreshes issuer metadata when persisted credential configurations drift', async () => {
      const stale = { 'RewardCredential-sd-jwt': { format: 'vc+sd-jwt' } };
      issuerApi.getIssuerByIssuerId
        .mockResolvedValueOnce({
          issuerId: Oid4vcIssuerService.ISSUER_ID,
          credentialConfigurationsSupported: stale,
        })
        .mockResolvedValueOnce({
          issuerId: Oid4vcIssuerService.ISSUER_ID,
        });
      issuerApi.updateIssuerMetadata.mockResolvedValue(undefined);
      await service.ensureIssuer();
      expect(issuerApi.updateIssuerMetadata).toHaveBeenCalledTimes(1);
      const arg = issuerApi.updateIssuerMetadata.mock.calls[0][0];
      expect(Object.keys(arg.credentialConfigurationsSupported).sort()).toEqual([
        'credential-jwt-vc',
        'credential-sd-jwt',
      ]);
    });

    it('creates a new issuer with both credential configurations when missing', async () => {
      issuerApi.getIssuerByIssuerId.mockRejectedValue(new Error('not found'));
      issuerApi.createIssuer.mockResolvedValue({ issuerId: Oid4vcIssuerService.ISSUER_ID });
      await service.ensureIssuer();
      expect(issuerApi.createIssuer).toHaveBeenCalledTimes(1);
      const arg = issuerApi.createIssuer.mock.calls[0][0];
      expect(arg.issuerId).toBe(Oid4vcIssuerService.ISSUER_ID);
      expect(Object.keys(arg.credentialConfigurationsSupported).sort()).toEqual([
        'credential-jwt-vc',
        'credential-sd-jwt',
      ]);
    });
  });

  describe('createOffer', () => {
    it('creates a Credo offer and persists a local session record', async () => {
      issuerApi.getIssuerByIssuerId.mockResolvedValue({ issuerId: Oid4vcIssuerService.ISSUER_ID });
      issuerApi.createCredentialOffer.mockResolvedValue({
        issuanceSession: { id: 'credo-1', preAuthorizedCode: 'pac', state: 'OfferCreated' },
        credentialOffer: 'openid-credential-offer://x',
      });

      const result = await service.createOffer({
        credentialConfigurationIds: ['credential-sd-jwt'],
        userId: 'user-1',
        issuanceMetadata: { rewardTier: 'gold' },
      });

      expect(issuerApi.createCredentialOffer).toHaveBeenCalledWith(
        expect.objectContaining({
          issuerId: Oid4vcIssuerService.ISSUER_ID,
          offeredCredentials: ['credential-sd-jwt'],
        }),
      );
      expect(mockRepo.save).toHaveBeenCalled();
      expect(result).toMatchObject({
        credoIssuanceSessionId: 'credo-1',
        credentialOffer: 'openid-credential-offer://x',
        userId: 'user-1',
      });
    });
  });

  describe('credential mapper', () => {
    const userAlgoDid = 'did:algo:testnet:app:1234:' + 'a'.repeat(64);
    const docWithKeys2 = {
      did: userAlgoDid,
      verificationMethodIds: [`${userAlgoDid}#keys-1`, `${userAlgoDid}#keys-2`],
    };
    const docWithoutKeys2 = {
      did: userAlgoDid,
      verificationMethodIds: [`${userAlgoDid}#keys-1`],
    };

    it('binds SD-JWT VC credentials to the user #keys-2 (self-custody) verification method', async () => {
      // Capture the mapper that the service registers on bootstrap.
      await service.onModuleInit();
      const mapper = agentProvider.setCredentialMapper.mock.calls[0][0] as (input: unknown) => Promise<unknown>;

      agentProvider.resolveUserAlgoDidDocument.mockResolvedValueOnce(docWithKeys2);

      const signed: any = await mapper({
        credentialConfigurationIds: ['credential-sd-jwt'],
        issuanceSession: { issuanceMetadata: { _userId: 'user-1', rewardTier: 'gold' } },
        holderBinding: { method: 'did', didUrl: `${userAlgoDid}#keys-2` },
      });

      expect(signed.format).toBe('vc+sd-jwt');
      expect(signed.holder).toEqual({ method: 'did', didUrl: `${userAlgoDid}#keys-2` });
      expect(agentProvider.resolveUserAlgoDidDocument).toHaveBeenCalledWith('user-1');
    });

    it('throws when the user has no published did:algo', async () => {
      await service.onModuleInit();
      const mapper = agentProvider.setCredentialMapper.mock.calls[0][0] as (input: unknown) => Promise<unknown>;

      agentProvider.resolveUserAlgoDidDocument.mockResolvedValueOnce(null);

      await expect(
        mapper({
          credentialConfigurationIds: ['credential-sd-jwt'],
          issuanceSession: { issuanceMetadata: { _userId: 'user-1' } },
          holderBinding: { method: 'did', didUrl: `${userAlgoDid}#keys-2` },
        }),
      ).rejects.toThrow(/does not have a published did:algo/);
    });

    it('throws when the user has not registered a self-custody #keys-2', async () => {
      await service.onModuleInit();
      const mapper = agentProvider.setCredentialMapper.mock.calls[0][0] as (input: unknown) => Promise<unknown>;

      agentProvider.resolveUserAlgoDidDocument.mockResolvedValueOnce(docWithoutKeys2);

      await expect(
        mapper({
          credentialConfigurationIds: ['credential-sd-jwt'],
          issuanceSession: { issuanceMetadata: { _userId: 'user-1' } },
          holderBinding: { method: 'did', didUrl: `${userAlgoDid}#keys-2` },
        }),
      ).rejects.toThrow(/has not registered a self-custody wallet key \(#keys-2\)/);
    });

    it('rejects holder bindings against #keys-1 (the platform key)', async () => {
      await service.onModuleInit();
      const mapper = agentProvider.setCredentialMapper.mock.calls[0][0] as (input: unknown) => Promise<unknown>;

      agentProvider.resolveUserAlgoDidDocument.mockResolvedValueOnce(docWithKeys2);

      await expect(
        mapper({
          credentialConfigurationIds: ['credential-sd-jwt'],
          issuanceSession: { issuanceMetadata: { _userId: 'user-1' } },
          holderBinding: { method: 'did', didUrl: `${userAlgoDid}#keys-1` },
        }),
      ).rejects.toThrow(/Holder binding mismatch/);
    });

    it('rejects holder bindings that are not the user did:algo', async () => {
      await service.onModuleInit();
      const mapper = agentProvider.setCredentialMapper.mock.calls[0][0] as (input: unknown) => Promise<unknown>;

      agentProvider.resolveUserAlgoDidDocument.mockResolvedValueOnce(docWithKeys2);

      await expect(
        mapper({
          credentialConfigurationIds: ['credential-sd-jwt'],
          issuanceSession: { issuanceMetadata: { _userId: 'user-1' } },
          holderBinding: { method: 'did', didUrl: 'did:key:zSomethingElse#zSomethingElse' },
        }),
      ).rejects.toThrow(/Holder binding mismatch/);
    });

    it('rejects non-did holder bindings (e.g. raw jwk) for DID-bound formats', async () => {
      await service.onModuleInit();
      const mapper = agentProvider.setCredentialMapper.mock.calls[0][0] as (input: unknown) => Promise<unknown>;

      agentProvider.resolveUserAlgoDidDocument.mockResolvedValueOnce(docWithKeys2);

      await expect(
        mapper({
          credentialConfigurationIds: ['credential-sd-jwt'],
          issuanceSession: { issuanceMetadata: { _userId: 'user-1' } },
          holderBinding: { method: 'jwk', jwk: { kty: 'OKP' } },
        }),
      ).rejects.toThrow(/holder binding method 'jwk' is not supported/);
    });
  });

  describe('findSession', () => {
    it('throws NotFoundException when missing', async () => {
      mockRepo.findOneBy.mockResolvedValue(null);
      await expect(service.findSession('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the persisted session when present', async () => {
      const existing = { id: 'x', credentialOffer: 'u', state: 'OfferCreated' };
      mockRepo.findOneBy.mockResolvedValue(existing);
      await expect(service.findSession('x')).resolves.toBe(existing);
    });
  });
});
