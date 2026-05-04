import { Test, TestingModule } from '@nestjs/testing';
import { LinkController } from './link.controller';
import { LinkService } from './link.service';
import { BadRequestException } from '@nestjs/common';
import { LinkSession } from './link.types';

describe('LinkController', () => {
  let controller: LinkController;
  let service: LinkService;

  const mockLinkService = {
    generateChallenge: jest.fn(),
    linkResponse: jest.fn(),
    getLinkVerification: jest.fn(),
    autoAssociate: jest.fn(),
    getVaultPlayer: jest.fn(),
  };

  const mockSession: LinkSession = {
    user: {
      id: 'user123',
      email: 'test@example.com',
      emailVerified: true,
      name: 'Test User',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    session: {
      id: 'sess123',
      userId: 'user123',
      expiresAt: new Date(),
      token: 'token',
      ipAddress: '127.0.0.1',
      userAgent: 'Mozilla',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LinkController],
      providers: [
        {
          provide: LinkService,
          useValue: mockLinkService,
        },
      ],
    }).compile();

    controller = module.get<LinkController>(LinkController);
    service = module.get<LinkService>(LinkService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getChallenge', () => {
    it('should return a challenge from the service', async () => {
      mockLinkService.generateChallenge.mockResolvedValue('challenge123');
      const result = await controller.getChallenge(mockSession);
      expect(result).toEqual({ challenge: 'challenge123' });
      expect(service.generateChallenge).toHaveBeenCalled();
    });
  });

  describe('linkResponse', () => {
    it('should return success if email is verified, challenge is in session and service call succeeds', async () => {
      const mockResult = { success: true };
      mockLinkService.linkResponse.mockResolvedValue(mockResult);
      const sessionWithChallenge = { ...mockSession, challenge: 'challenge123' };
      const result = await controller.linkResponse(sessionWithChallenge as any, {
        walletAddress: '0xWallet',
        integrityToken: 'token',
      });
      expect(result).toEqual(mockResult);
      expect(service.linkResponse).toHaveBeenCalledWith(
        'user123',
        'test@example.com',
        '0xWallet',
        {
          integrityToken: 'token',
        },
        'challenge123',
      );
    });

    it('should throw BadRequestException if challenge is missing in session', async () => {
      const sessionWithoutChallenge = { ...mockSession, challenge: undefined };
      await expect(
        controller.linkResponse(sessionWithoutChallenge as any, {
          walletAddress: '0xWallet',
          integrityToken: 'token',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if email is not verified', async () => {
      const unverifiedSession = {
        ...mockSession,
        user: { ...mockSession.user, emailVerified: false },
      };
      await expect(
        controller.linkResponse(unverifiedSession as any, {
          walletAddress: '0xWallet',
          integrityToken: 'token',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getSession', () => {
    it('should return authenticated status and user info if authenticated', async () => {
      const verification = { id: 'vault123' };
      const player = { user_id: 'vault123' };
      mockLinkService.getLinkVerification.mockResolvedValue(verification);
      mockLinkService.getVaultPlayer.mockResolvedValue(player);

      const result = await controller.getSession(mockSession);

      expect(result).toEqual({
        authenticated: true,
        user: mockSession.user,
        verification,
        player,
      });
    });

    it('should autoAssociate if mapping is missing and email exists', async () => {
      mockLinkService.getLinkVerification.mockResolvedValue(null);
      mockLinkService.autoAssociate.mockResolvedValue({ id: 'vault123' });
      mockLinkService.getVaultPlayer.mockResolvedValue({ user_id: 'vault123' });

      await controller.getSession(mockSession);

      expect(service.autoAssociate).toHaveBeenCalledWith('user123', 'test@example.com');
    });

    it('should return authenticated false if no session', async () => {
      const result = await controller.getSession(null as any);
      expect(result).toEqual({ authenticated: false });
    });
  });
});
