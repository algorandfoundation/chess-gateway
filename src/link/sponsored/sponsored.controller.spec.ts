import { Test, TestingModule } from '@nestjs/testing';
import { SponsoredController } from './sponsored.controller';
import { SponsoredService } from './sponsored.service';
import { LinkSession } from '../link.types';

describe('SponsoredController', () => {
    let controller: SponsoredController;
    let service: SponsoredService;

    const mockSponsoredService = {
        claimAsset: jest.fn(),
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
            controllers: [SponsoredController],
            providers: [{ provide: SponsoredService, useValue: mockSponsoredService }],
        }).compile();

        controller = module.get<SponsoredController>(SponsoredController);
        service = module.get<SponsoredService>(SponsoredService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('claimAsset', () => {
        it('should only pass the authenticated user ID from session to service', async () => {
            mockSponsoredService.claimAsset.mockResolvedValue('TXID');

            const result = await controller.claimAsset(mockSession, { assetId: 1234n, amount: 5 });

            expect(result).toEqual({ transaction_id: 'TXID' });
            // Verify the service is called with the authenticated user's ID, not from body
            expect(service.claimAsset).toHaveBeenCalledWith('user123', 1234n, 5, undefined, undefined);
        });

        it('should forward optional lease and note', async () => {
            mockSponsoredService.claimAsset.mockResolvedValue('TXID2');

            const result = await controller.claimAsset(mockSession, {
                assetId: 99n,
                amount: 3,
                lease: 'lease==',
                note: 'hello',
            });

            expect(result).toEqual({ transaction_id: 'TXID2' });
            expect(service.claimAsset).toHaveBeenCalledWith('user123', 99n, 3, 'lease==', 'hello');
        });

        it('should use session user ID regardless of session user changes', async () => {
            mockSponsoredService.claimAsset.mockResolvedValue('TXID3');
            const differentUserSession = { ...mockSession, user: { ...mockSession.user, id: 'user456' } };

            await controller.claimAsset(differentUserSession, { assetId: 100n, amount: 1 });

            // Verify it uses the session user ID (user456), not the original session
            expect(service.claimAsset).toHaveBeenCalledWith('user456', 100n, 1, undefined, undefined);
        });
    });
});
