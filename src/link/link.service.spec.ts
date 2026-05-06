import { Test, TestingModule } from '@nestjs/testing';
import { LinkService } from './link.service';
import { VerificationService } from './verification/verification.service';
import { VaultService } from '../vault/vault.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DidService } from '../did/did.service';

describe('LinkService', () => {
  let service: LinkService;
  let verificationService: VerificationService;
  let vaultService: VaultService;
  let authService: AuthService;

  const mockVerificationService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByUserId: jest.fn(),
    findByPlayerId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    upsert: jest.fn(),
  };

  const mockVaultService = {
    getTokenWithRole: jest.fn(),
    getKeys: jest.fn(),
    getKey: jest.fn(),
    getUserPublicKey: jest.fn(),
  };

  const mockDidService = {
    hasOnChainDocument: jest.fn(),
    publishUserDid: jest.fn(),
  };

  const mockAuthService = {
    getUserIdByEmail: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LinkService,
        {
          provide: VerificationService,
          useValue: mockVerificationService,
        },
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
        {
          provide: VaultService,
          useValue: mockVaultService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: DidService,
          useValue: mockDidService,
        },
      ],
    }).compile();

    service = module.get<LinkService>(LinkService);
    verificationService = module.get<VerificationService>(VerificationService);
    authService = module.get<AuthService>(AuthService);
    vaultService = module.get<VaultService>(VaultService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('linkResponse', () => {
    it('should associate account and link wallet if user ID is found and integrity is verified', async () => {
      mockAuthService.getUserIdByEmail.mockResolvedValue('player123');
      mockVerificationService.upsert.mockResolvedValue({ id: 'player123', walletAddress: '0xWallet' });
      mockVaultService.getTokenWithRole.mockResolvedValue('manager-token');
      mockVaultService.getUserPublicKey.mockResolvedValue(Buffer.alloc(32));
      mockDidService.hasOnChainDocument.mockResolvedValue(false);

      const result = await service.linkResponse(
        'user123',
        'test@example.com',
        '0xWallet',
        {
          integrityToken: 'valid-token',
        },
        'challenge123',
      );

      expect(result.id).toBe('player123');
      expect(result.walletAddress).toBe('0xWallet');
      expect(mockAuthService.getUserIdByEmail).toHaveBeenCalledWith('test@example.com');
      expect(verificationService.upsert).toHaveBeenCalledWith('user123', 'player123', true, '0xWallet');
    });

    it('should throw BadRequestException if integrity verification fails', async () => {
      await expect(service.linkResponse('user123', 'test@example.com', '0xWallet', {}, 'challenge123')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if user ID is not found in AuthService', async () => {
      mockAuthService.getUserIdByEmail.mockResolvedValue(null);
      await expect(
        service.linkResponse(
          'user123',
          'unknown@example.com',
          '0xWallet',
          { integrityToken: 'valid-token' },
          'challenge123',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('generateChallenge', () => {
    it('should return a random string', async () => {
      const challenge = await service.generateChallenge();
      expect(typeof challenge).toBe('string');
      expect(challenge.length).toBeGreaterThan(10);
    });
  });

  describe('verifyIntegrity', () => {
    it('should return true if integrityToken is provided', async () => {
      const result = await service.verifyIntegrity('challenge123', { integrityToken: 'token' });
      expect(result).toBe(true);
    });

    it('should return true if attestationObject and keyId are provided', async () => {
      const result = await service.verifyIntegrity('challenge123', { attestationObject: 'obj', keyId: 'key' });
      expect(result).toBe(true);
    });

    it('should return false if no integrity data is provided', async () => {
      const result = await service.verifyIntegrity('challenge123', {});
      expect(result).toBe(false);
    });
  });

  describe('associateAccount', () => {
    it('should call upsert in verification service', async () => {
      mockVerificationService.upsert.mockResolvedValue({ id: 'new' });

      const result = await service.associateAccount('user1', 'new');

      expect(result.id).toBe('new');
      expect(verificationService.upsert).toHaveBeenCalledWith('user1', 'new', true);
    });
  });

  describe('autoAssociate', () => {
    it('should associate account if email is found in AuthService and player exists in Vault', async () => {
      mockAuthService.getUserIdByEmail.mockResolvedValue('vaultId');
      jest.spyOn(service, 'getVaultPlayer').mockResolvedValue({ user_id: 'vaultId' } as any);
      jest.spyOn(service, 'associateAccount').mockResolvedValue({} as any);

      await service.autoAssociate('authUser', 'test@example.com');

      expect(authService.getUserIdByEmail).toHaveBeenCalledWith('test@example.com');
      expect(service.getVaultPlayer).toHaveBeenCalledWith('vaultId');
      expect(service.associateAccount).toHaveBeenCalledWith('authUser', 'vaultId');
    });

    it('should return null if email is not found in AuthService', async () => {
      mockAuthService.getUserIdByEmail.mockResolvedValue(null);
      const result = await service.autoAssociate('authUser', 'unknown@example.com');
      expect(result).toBeNull();
    });

    it('should return null if player does not exist in Vault', async () => {
      mockAuthService.getUserIdByEmail.mockResolvedValue('vaultId');
      jest.spyOn(service, 'getVaultPlayer').mockResolvedValue(null);
      const result = await service.autoAssociate('authUser', 'test@example.com');
      expect(result).toBeNull();
    });
  });

  describe('getLinkVerification', () => {
    it('should find mapping by userId', async () => {
      const mapping = { userId: 'user1' };
      mockVerificationService.findByUserId.mockResolvedValue(mapping);

      const result = await service.getLinkVerification('user1');

      expect(result).toEqual(mapping);
      expect(verificationService.findByUserId).toHaveBeenCalledWith('user1');
    });
  });

  describe('findAll', () => {
    it('should return all verifications', async () => {
      const verifications = [{ id: 'v1' }, { id: 'v2' }];
      mockVerificationService.findAll.mockResolvedValue(verifications);

      const result = await service.findAll();

      expect(result).toEqual(verifications);
      expect(verificationService.findAll).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a verification by id', async () => {
      const verification = { id: 'v1' };
      mockVerificationService.findOne.mockResolvedValue(verification);

      const result = await service.findOne('v1');

      expect(result).toEqual(verification);
      expect(verificationService.findOne).toHaveBeenCalledWith('v1');
    });
  });

  describe('create', () => {
    it('should call verification service create', async () => {
      const data = { userId: 'u1', id: 'v1' };
      mockVerificationService.create.mockResolvedValue(data);

      const result = await service.create(data);

      expect(result).toEqual(data);
      expect(verificationService.create).toHaveBeenCalledWith(data);
    });
  });

  describe('update', () => {
    it('should call verification service update', async () => {
      const updateData = { userId: 'u1-new' };
      mockVerificationService.update.mockResolvedValue(updateData);

      const result = await service.update('v1', updateData);

      expect(result).toEqual(updateData);
      expect(verificationService.update).toHaveBeenCalledWith('v1', updateData);
    });
  });

  describe('remove', () => {
    it('should call verification service remove', async () => {
      mockVerificationService.remove.mockResolvedValue(undefined);
      await service.remove('v1');
      expect(verificationService.remove).toHaveBeenCalledWith('v1');
    });
  });

  describe('getVerifications', () => {
    it('should return verifications if token is valid', async () => {
      const verifications = [{ id: 'player1' }];
      mockConfigService.get.mockReturnValue('users-path');
      mockVaultService.getKey.mockResolvedValue(Buffer.from('public-key'));
      mockVerificationService.findByPlayerId.mockResolvedValue(verifications);

      const result = await service.getVerifications('player1', 'valid-token');

      expect(result).toEqual(verifications);
      expect(vaultService.getKey).toHaveBeenCalledWith('player1', 'users-path', 'valid-token');
      expect(verificationService.findByPlayerId).toHaveBeenCalledWith('player1');
    });

    it('should throw BadRequestException if vault verification fails', async () => {
      mockVaultService.getKey.mockRejectedValue(new Error('Vault error'));

      await expect(service.getVerifications('player1', 'invalid-token')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getVaultPlayer', () => {
    it('should return vault player if found', async () => {
      mockConfigService.get.mockImplementation((key) => {
        if (key === 'VAULT_ROLE_ID') return 'role';
        if (key === 'VAULT_SECRET_ID') return 'secret';
        return null;
      });
      mockVaultService.getTokenWithRole.mockResolvedValue('token');
      const players = [{ user_id: 'player1' }, { user_id: 'player2' }];
      mockVaultService.getKeys.mockResolvedValue(players);

      const result = await service.getVaultPlayer('player1');

      expect(result).toEqual(players[0]);
    });

    it('should return null if player is not found', async () => {
      mockVaultService.getTokenWithRole.mockResolvedValue('token');
      mockVaultService.getKeys.mockResolvedValue([{ user_id: 'other' }]);

      const result = await service.getVaultPlayer('player1');

      expect(result).toBeNull();
    });

    it('should return null and log error if exception occurs', async () => {
      mockVaultService.getTokenWithRole.mockRejectedValue(new Error('Vault error'));

      const result = await service.getVaultPlayer('player1');

      expect(result).toBeNull();
    });
  });
});
