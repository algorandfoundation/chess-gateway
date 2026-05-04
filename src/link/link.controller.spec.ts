import { Test, TestingModule } from '@nestjs/testing';

const mockUpdateSession = jest.fn();
jest.mock('./auth', () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: {
        updateSession: mockUpdateSession,
      },
    }),
  },
}));

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
    it('should return a challenge from the service and persist it on the session', async () => {
      mockLinkService.generateChallenge.mockResolvedValue('challenge123');
      const result = await controller.getChallenge(mockSession);
      expect(result).toEqual({ challenge: 'challenge123' });
      expect(service.generateChallenge).toHaveBeenCalled();
      expect(mockUpdateSession).toHaveBeenCalledWith(mockSession.session.token, { challenge: 'challenge123' });
    });

    it('should persist the challenge keyed by the inner session token (not the outer object)', async () => {
      mockLinkService.generateChallenge.mockResolvedValue('chal-path-check');
      await controller.getChallenge(mockSession);

      expect(mockUpdateSession).toHaveBeenCalledTimes(1);
      const [tokenArg, updateArg] = mockUpdateSession.mock.calls[0];
      // Path check: must use session.session.token, NOT session.token (which doesn't exist)
      expect(tokenArg).toBe(mockSession.session.token);
      expect(tokenArg).not.toBe((mockSession as any).token);
      // Path check: challenge is written at the top level of the update payload (becomes a column on the session row)
      expect(updateArg).toEqual({ challenge: 'chal-path-check' });
    });
  });

  describe('linkResponse', () => {
    it('should return success if email is verified, challenge is in session and service call succeeds', async () => {
      const mockResult = { success: true };
      mockLinkService.linkResponse.mockResolvedValue(mockResult);
      const sessionWithChallenge = { ...mockSession, session: { ...mockSession.session, challenge: 'challenge123' } };
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
      const sessionWithoutChallenge = { ...mockSession, session: { ...mockSession.session, challenge: undefined } };
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

    it('should reject when challenge is on the wrong path (outer session, not session.session)', async () => {
      // If a future refactor accidentally reads `session.challenge` instead of
      // `session.session.challenge`, this test will catch it.
      const wrongPathSession = {
        ...mockSession,
        challenge: 'wrong-path-challenge',
        session: { ...mockSession.session, challenge: undefined },
      };
      await expect(
        controller.linkResponse(wrongPathSession as any, {
          walletAddress: '0xWallet',
          integrityToken: 'token',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(service.linkResponse).not.toHaveBeenCalled();
    });
  });

  describe('challenge end-to-end (getChallenge -> linkResponse)', () => {
    it('should persist the challenge via getChallenge and read it back via linkResponse from session.session.challenge', async () => {
      // Step 1: getChallenge issues a challenge and persists it via internalAdapter.updateSession.
      mockLinkService.generateChallenge.mockResolvedValue('e2e-challenge');
      const challengeResp = await controller.getChallenge(mockSession);
      expect(challengeResp).toEqual({ challenge: 'e2e-challenge' });

      // Capture what was persisted and to which token.
      expect(mockUpdateSession).toHaveBeenCalledTimes(1);
      const [persistedToken, persistedPayload] = mockUpdateSession.mock.calls[0];
      expect(persistedToken).toBe(mockSession.session.token);
      expect(persistedPayload).toEqual({ challenge: 'e2e-challenge' });

      // Step 2: simulate better-auth reloading the session row on the next request.
      // Additional fields land on the inner session object, so we mirror that here.
      const reloadedSession: LinkSession = {
        ...mockSession,
        session: {
          ...mockSession.session,
          challenge: persistedPayload.challenge,
        },
      };

      // Step 3: linkResponse should read the challenge from session.session.challenge
      // and forward it to the service unchanged.
      mockLinkService.linkResponse.mockResolvedValue({ success: true });
      const result = await controller.linkResponse(reloadedSession, {
        walletAddress: '0xWallet',
        integrityToken: 'token',
      });

      expect(result).toEqual({ success: true });
      expect(service.linkResponse).toHaveBeenCalledWith(
        'user123',
        'test@example.com',
        '0xWallet',
        { integrityToken: 'token' },
        'e2e-challenge',
      );
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
