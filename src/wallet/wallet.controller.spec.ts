import { Test, TestingModule } from '@nestjs/testing';
import { Wallet } from './wallet.controller';
import { WalletService } from './wallet.service';
import { CreateAssetDto } from './create-asset.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import createMockInstance from 'jest-create-mock-instance';
import { AssetTransferRequestDto } from './asset-transfer-request.dto';
import { AssetTransferResponseDto } from './asset-transfer-response.dto';
import { AssetClawbackRequestDto } from './asset-clawback-request.dto';
import { plainToClass } from 'class-transformer';
import { AlgoTransferRequestDto } from './algo-transfer-request.dto';
import { AssetHolding } from 'src/chain/algo-node-responses';

describe('Wallet Controller', () => {
  let walletController: Wallet;
  let mockWalletService: jest.Mocked<WalletService>;

  beforeAll(async () => {
    mockWalletService = createMockInstance(WalletService);

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [Wallet],
      providers: [
        {
          provide: WalletService,
          useValue: mockWalletService,
        },
      ],
    }).compile();

    walletController = moduleRef.get<Wallet>(Wallet);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('userDetail', () => {
    it('should return a public address for a user', async () => {
      const userId = 'user123';
      const vaultToken = 'vault-token-abc';
      const expectedPublicAddress = 'PUBLIC_ADDRESS_XYZ';
      const expectedAmount = '666';

      // Set up the WalletService mock for getUserPublicAddress.
      mockWalletService.getUserInfo.mockResolvedValueOnce({
        user_id: userId,
        public_address: expectedPublicAddress,
        algoBalance: expectedAmount,
      });
      const requestMock = { vault_token: vaultToken };

      const result = await walletController.userDetail(requestMock, userId);

      expect(mockWalletService.getUserInfo).toHaveBeenCalledWith(userId, vaultToken);
      expect(result).toEqual({ user_id: userId, public_address: expectedPublicAddress, algoBalance: expectedAmount });
    });

    it('\(OK) create user', async () => {
      const userId = 'user123';
      const vaultToken = 'vault-token-abc';
      const expectedPublicAddress = 'PUBLIC_ADDRESS_XYZ';
      const expectedSecretId = 'b6a23f3e-7b1f-4c84-9c8a-2a3d3a5e9f10';

      mockWalletService.userCreate.mockResolvedValueOnce({
        user_id: userId,
        public_address: expectedPublicAddress,
        algoBalance: '0',
        role_id: userId,
        secret_id: expectedSecretId,
      });

      const result: UserInfoResponseDto = await walletController.userCreate(
        { vault_token: vaultToken },
        { user_id: userId },
      );

      expect(result.user_id).toEqual(userId);
      expect(result.public_address).toEqual(expectedPublicAddress);
      expect(result.algoBalance).toEqual('0'); // Initial balance is set to 0
      // The per-user AppRole credentials provisioned by WalletService must be
      // passed through verbatim — they are the only handle the caller will
      // ever get on the user's `secret_id`.
      expect(result.role_id).toEqual(userId);
      expect(result.secret_id).toEqual(expectedSecretId);
      expect(mockWalletService.userCreate).toHaveBeenCalledWith(userId, vaultToken);
    });
  });

  describe('userCreateAppRole', () => {
    it('should delegate to WalletService.createUserAppRole with the path param and request vault token', async () => {
      // Legacy-user backfill route: the controller is intentionally thin —
      // it just forwards the `:user_id` path param and the manager's vault
      // token from the request. All identity/preflight checks live in
      // `WalletService.createUserAppRole`, so the only thing worth asserting
      // here is the wiring.
      const vaultToken = 'manager-vault-token';
      const userId = 'legacy-user-7';
      const expected = {
        user_id: userId,
        role_id: userId,
        secret_id: 'b6a23f3e-7b1f-4c84-9c8a-2a3d3a5e9f10',
      };

      mockWalletService.createUserAppRole.mockResolvedValueOnce(expected);

      const requestMock = { vault_token: vaultToken };
      const result = await walletController.userCreateAppRole(requestMock, userId);

      expect(mockWalletService.createUserAppRole).toHaveBeenCalledWith(userId, vaultToken);
      expect(result).toEqual(expected);
    });
  });

  describe('transferAlgoToAddress', () => {
    it('should transfer Algos to a specified address and return the transaction id', async () => {
      const vaultToken = 'vault-token-xyz';
      const userId = 'user123'; // from user
      const toAddress = 'TO_ADDRESS_ABC';
      const amount = 500000; // in microAlgos
      const expectedTransactionId = 'tx123456789';

      // Set up the WalletService mock for transferAlgoToAddress.
      mockWalletService.transferAlgoToAddress.mockResolvedValueOnce(expectedTransactionId);

      const requestMock = { vault_token: vaultToken };
      const bodyRequest: AlgoTransferRequestDto = {
        toAddress,
        amount,
        fromUserId: userId,
      };

      const result = await walletController.algoTransferTx(requestMock, bodyRequest);

      expect(mockWalletService.transferAlgoToAddress).toHaveBeenCalledWith(vaultToken, userId, toAddress, amount);
      expect(result).toEqual({ transaction_id: expectedTransactionId });
    });
  });

  describe('assetsBalances', () => {
    it('should return asset balances for a user', async () => {
      const userId = 'user123';
      const vaultToken = 'vault-token-abc';
      const expectedPublicAddress = 'PUBLIC_ADDRESS_XYZ';
      const algoBalanceExpected = '1000000'; // Example balance in microAlgos
      const expectedAssets: AssetHolding[] = [
        { amount: BigInt(100), 'asset-id': 123, 'is-frozen': false },
        { amount: BigInt(200), 'asset-id': 456, 'is-frozen': true },
      ];
      const expectedAccountAssetsDto = {
        address: expectedPublicAddress,
        assets: expectedAssets,
      };
      const requestMock = { vault_token: vaultToken };
      mockWalletService.getAssetHoldings.mockResolvedValueOnce(expectedAssets);
      mockWalletService.getUserInfo.mockResolvedValueOnce({
        user_id: userId,
        public_address: expectedPublicAddress,
        algoBalance: algoBalanceExpected,
      });
      const result = await walletController.assetsBalances(requestMock, userId);
      expect(mockWalletService.getAssetHoldings).toHaveBeenCalledWith(userId, vaultToken);
      expect(mockWalletService.getUserInfo).toHaveBeenCalledWith(userId, vaultToken);
      expect(result).toEqual(expectedAccountAssetsDto);
    });
  });

  describe('createAsset', () => {
    it('should create an asset transaction and return the transaction id', async () => {
      const vaultToken = 'vault-token-def';
      const createAssetParams: CreateAssetDto = {
        total: 1000,
        decimals: BigInt(2),
        defaultFrozen: false,
        unitName: 'UNIT',
        assetName: 'Test Asset',
        url: 'http://example.com/asset',
        // optional properties like managerAddress, reserveAddress etc. can be added as needed
      };
      const expectedTransactionId = 'tx123456789';

      // Set up the WalletService mock for createAsset.
      mockWalletService.createAsset.mockResolvedValueOnce(expectedTransactionId);

      const requestMock = { vault_token: vaultToken };

      const result = await walletController.createAsset(requestMock, createAssetParams);

      expect(mockWalletService.createAsset).toHaveBeenCalledWith(createAssetParams, vaultToken);
      expect(result).toEqual({ transaction_id: expectedTransactionId });
    });
  });

  describe('assetTransferTx', () => {
    it('should transfer an asset and return the transaction id', async () => {
      const vaultToken = 'vault-token-ghi';
      const assetTransferRequest: AssetTransferRequestDto = {
        assetId: 123n,
        userId: 'user456',
        amount: 10,
        lease: '9kykoZ1IpuOAqhzDgRVaVY2ME0ZlCNrUpnzxpXlEF/s=',
        note: 'This is my note. I am not proud of it but it is what it is.',
      };
      const expectedTransactionId = 'tx987654321';

      mockWalletService.transferAsset.mockResolvedValueOnce(expectedTransactionId);

      const requestMock = { vault_token: vaultToken };

      const result: AssetTransferResponseDto = await walletController.assetTransferTx(
        requestMock,
        assetTransferRequest,
      );

      expect(mockWalletService.transferAsset).toHaveBeenCalledWith(
        vaultToken,
        assetTransferRequest.assetId,
        assetTransferRequest.userId,
        assetTransferRequest.amount,
        assetTransferRequest.lease,
        assetTransferRequest.note,
      );
      expect(result).toEqual(plainToClass(AssetTransferResponseDto, { transaction_id: expectedTransactionId }));
    });
  });

  describe('assetClawbackTx', () => {
    it('should clawback an asset and return the transaction id', async () => {
      const vaultToken = 'vault-token-jkl';
      const assetClawbackRequest: AssetClawbackRequestDto = {
        assetId: 123n,
        userId: 'user456',
        amount: 10,
        lease: '9kykoZ1IpuOAqhzDgRVaVY2ME0ZlCNrUpnzxpXlEF/s=',
        note: 'This is my note. I am not proud of it but it is what it is.',
      };
      const expectedTransactionId = 'tx987654321';
      mockWalletService.clawbackAsset.mockResolvedValueOnce(expectedTransactionId);
      const requestMock = { vault_token: vaultToken };
      const result: AssetTransferResponseDto = await walletController.assetClawbackTx(
        requestMock,
        assetClawbackRequest,
      );
      expect(mockWalletService.clawbackAsset).toHaveBeenCalledWith(
        vaultToken,
        assetClawbackRequest.assetId,
        assetClawbackRequest.userId,
        assetClawbackRequest.amount,
        assetClawbackRequest.lease,
        assetClawbackRequest.note,
      );
      expect(result).toEqual(
        plainToClass(AssetTransferResponseDto, {
          transaction_id: expectedTransactionId,
        }),
      );
    });
  });
});
