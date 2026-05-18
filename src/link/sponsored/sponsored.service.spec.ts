import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SponsoredService } from './sponsored.service';
import { VerificationService } from '../verification/verification.service';
import { VaultService } from '../../vault/vault.service';
import { ChainService } from '../../chain/chain.service';
import { ConfigService } from '@nestjs/config';
import { WalletService } from '../../wallet/wallet.service';

describe('SponsoredService', () => {
    let service: SponsoredService;

    const mockVerificationService = {
        findByUserId: jest.fn(),
    };
    const mockVaultService = {
        getTokenWithRole: jest.fn(),
        getUserPublicKey: jest.fn(),
        getManagerPublicKey: jest.fn(),
    };
    const mockChainService = {
        getSuggestedParams: jest.fn(),
        craftPaymentTx: jest.fn(),
        craftAssetTransferTx: jest.fn(),
        setGroupID: jest.fn(),
        submitTransaction: jest.fn(),
    };
    const mockConfigService = {
        get: jest.fn(),
    };
    const mockWalletService = {
        signTxAsManager: jest.fn(),
        signTxAsUser: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SponsoredService,
                { provide: VerificationService, useValue: mockVerificationService },
                { provide: VaultService, useValue: mockVaultService },
                { provide: ChainService, useValue: mockChainService },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: WalletService, useValue: mockWalletService },
            ],
        }).compile();

        service = module.get<SponsoredService>(SponsoredService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('claimAsset', () => {
        it('should throw ForbiddenException when betterAuthUserId is empty', async () => {
            await expect(service.claimAsset('', 1234n, 5)).rejects.toThrow(ForbiddenException);
        });

        it('should throw BadRequestException with specific message when user account is not found', async () => {
            mockVerificationService.findByUserId.mockResolvedValue(null);

            await expect(service.claimAsset('user123', 1234n, 5)).rejects.toThrow(
                new BadRequestException('User account not found.'),
            );
        });

        it('should throw when user is not linked and verified', async () => {
            mockVerificationService.findByUserId.mockResolvedValue({
                id: 'vault-user-1',
                isVerified: false,
                walletAddress: null,
            });

            await expect(service.claimAsset('user123', 1234n, 5)).rejects.toThrow(BadRequestException);
        });

        it('should build, sign, and submit a sponsored claim group', async () => {
            mockVerificationService.findByUserId.mockResolvedValue({
                id: 'vault-user-1',
                isVerified: true,
                walletAddress: 'WALLET_ADDR',
            });
            mockConfigService.get.mockImplementation((key: string) => (key === 'VAULT_ROLE_ID' ? 'role' : 'secret'));
            mockVaultService.getTokenWithRole.mockResolvedValue('vault-token');
            mockVaultService.getUserPublicKey.mockResolvedValue(Buffer.alloc(32, 1));
            mockVaultService.getManagerPublicKey.mockResolvedValue(Buffer.alloc(32, 2));
            mockChainService.getSuggestedParams.mockResolvedValue({ minFee: 1000n });
            mockChainService.craftPaymentTx.mockResolvedValue(Uint8Array.from([1]));
            mockChainService.craftAssetTransferTx.mockResolvedValue(Uint8Array.from([2]));
            mockChainService.setGroupID.mockReturnValue([Uint8Array.from([3]), Uint8Array.from([4])]);
            mockWalletService.signTxAsManager.mockResolvedValue(Uint8Array.from([5]));
            mockWalletService.signTxAsUser.mockResolvedValue(Uint8Array.from([6]));
            mockChainService.submitTransaction.mockResolvedValue({ txid: 'TXID' });

            const result = await service.claimAsset('user123', 1234n, 5, 'lease', 'note');

            expect(result).toBe('TXID');
            expect(mockWalletService.signTxAsManager).toHaveBeenCalledTimes(1);
            expect(mockWalletService.signTxAsUser).toHaveBeenCalledWith(
                'vault-user-1',
                expect.any(Uint8Array),
                'vault-token',
            );
            expect(mockChainService.submitTransaction).toHaveBeenCalledTimes(1);
        });
    });
});
