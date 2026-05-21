import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import { mapUpstreamError } from '../common/upstream-error';
import {
  AccountAssetsResponse,
  AssetHolding,
  TruncatedAccountAssetResponse,
  TruncatedAccountResponse,
  TruncatedAssetHolding,
  TruncatedPostTransactionsResponse,
  TruncatedSuggestedParamsResponse,
} from './algo-node-responses';
import {
  AssetTransferTransactionFields,
  decodeTransaction,
  encodeSignedTransaction,
  encodeTransaction,
  groupTransactions,
  PaymentTransactionFields,
  SignedTransaction,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact';
import { AssetConfigTransactionFields, TransactionParams } from '@algorandfoundation/algokit-utils/transact';
import { Address } from '@algorandfoundation/algokit-utils';

@Injectable()
export class ChainService {
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private parseLease(lease: string): Uint8Array {
    return new Uint8Array(Buffer.from(lease, 'base64'));
  }

  addSignatureToTxn(encodedTransaction: Uint8Array, signature: Uint8Array): Uint8Array {
    const decodedTxn = decodeTransaction(encodedTransaction);
    const stxn: SignedTransaction = { txn: decodedTxn, sig: signature };
    return encodeSignedTransaction(stxn);
  }

  /**
   * Sets the group ID for a list of transactions.
   *
   * This function computes a group ID for the given transactions and then sets this ID for each transaction.
   *
   * @param txns The list of transactions to be grouped.
   * @returns The list of transactions with the group ID set.
   */
  setGroupID(txns: Uint8Array[]): Uint8Array[] {
    const decodedTxns = txns.map(decodeTransaction);
    const groupedTxns = groupTransactions(decodedTxns);
    return groupedTxns.map(encodeTransaction);
  }

  async craftAssetCreateTx(
    creatorAddress: string,
    options: {
      total: number;
      decimals: bigint;
      defaultFrozen: boolean;
      unitName: string;
      assetName: string;
      url: string;
      managerAddress?: string;
      reserveAddress?: string;
      freezeAddress?: string;
      clawbackAddress?: string;
    },
  ): Promise<Uint8Array> {
    const suggested_params: TruncatedSuggestedParamsResponse = await this.getSuggestedParams();

    const assetParams: AssetConfigTransactionFields = {
      assetId: 0n,
      total: BigInt(options.total),
      decimals: Number(options.decimals),
      defaultFrozen: options.defaultFrozen,
      unitName: options.unitName,
      assetName: options.assetName,
      url: options.url,
      manager: Address.fromString(options.managerAddress),
      reserve: Address.fromString(options.reserveAddress),
      freeze: Address.fromString(options.freezeAddress),
      clawback: Address.fromString(options.clawbackAddress),
    };

    const txnParams: TransactionParams = {
      type: TransactionType.AssetConfig,
      assetConfig: assetParams,
      sender: Address.fromString(creatorAddress),
      fee: BigInt(suggested_params.minFee),
      firstValid: suggested_params.lastRound,
      lastValid: suggested_params.lastRound + 1000n,
      genesisHash: Uint8Array.from(Buffer.from(this.configService.get<string>('GENESIS_HASH'), 'base64')),
      genesisId: this.configService.get<string>('GENESIS_ID'),
    };

    return encodeTransaction(new Transaction(txnParams));
  }

  async craftPaymentTx(
    from: string,
    to: string,
    amount: number,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params ? suggested_params : await this.getSuggestedParams();

    const pay: PaymentTransactionFields = {
      amount: BigInt(amount),
      receiver: Address.fromString(to),
    };

    const txnParams: TransactionParams = {
      type: TransactionType.Payment,
      payment: pay,
      sender: Address.fromString(from),
      fee: BigInt(suggested_params.minFee),
      firstValid: suggested_params.lastRound,
      lastValid: suggested_params.lastRound + 1000n,
      genesisHash: Uint8Array.from(Buffer.from(this.configService.get<string>('GENESIS_HASH'), 'base64')),
      genesisId: this.configService.get<string>('GENESIS_ID'),
    };

    return encodeTransaction(new Transaction(txnParams));
  }

  async craftAssetTransferTx(
    from: string,
    to: string,
    asset_id: bigint,
    amount: number | bigint,
    lease?: string,
    note?: string,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params ? suggested_params : await this.getSuggestedParams();

    const assetTransfer: AssetTransferTransactionFields = {
      assetId: asset_id,
      amount: BigInt(amount),
      receiver: Address.fromString(to),
    };

    const txnParams: TransactionParams = {
      type: TransactionType.AssetTransfer,
      assetTransfer: assetTransfer,
      sender: Address.fromString(from),
      fee: BigInt(suggested_params.minFee),
      firstValid: suggested_params.lastRound,
      lastValid: suggested_params.lastRound + 1000n,
      genesisHash: Uint8Array.from(Buffer.from(this.configService.get<string>('GENESIS_HASH'), 'base64')),
      genesisId: this.configService.get<string>('GENESIS_ID'),
      note: note ? Uint8Array.from(Buffer.from(note)) : undefined,
      lease: lease ? this.parseLease(lease) : undefined,
    };

    return encodeTransaction(new Transaction(txnParams));
  }

  async craftAssetClawbackTx(
    clawbackAddress: string,
    from: string,
    to: string,
    asset_id: bigint,
    amount: number | bigint,
    lease?: string,
    note?: string,
    suggested_params?: TruncatedSuggestedParamsResponse,
  ): Promise<Uint8Array> {
    suggested_params = suggested_params ? suggested_params : await this.getSuggestedParams();

    const assetTransfer: AssetTransferTransactionFields = {
      assetId: asset_id,
      amount: BigInt(amount),
      receiver: Address.fromString(to),
      assetSender: Address.fromString(from),
    };

    const txnParams: TransactionParams = {
      type: TransactionType.AssetTransfer,
      assetTransfer: assetTransfer,
      sender: Address.fromString(clawbackAddress),
      fee: BigInt(suggested_params.minFee),
      firstValid: suggested_params.lastRound,
      lastValid: suggested_params.lastRound + 1000n,
      genesisHash: Uint8Array.from(Buffer.from(this.configService.get<string>('GENESIS_HASH'), 'base64')),
      genesisId: this.configService.get<string>('GENESIS_ID'),
      note: note ? Uint8Array.from(Buffer.from(note)) : undefined,
      lease: lease ? this.parseLease(lease) : undefined,
    };

    return encodeTransaction(new Transaction(txnParams));
  }

  async makeAlgoNodeRequest(path: string, method: 'GET' | 'POST', data?: any): Promise<any> {
    const nodeHttpScheme: string = this.configService.get<string>('NODE_HTTP_SCHEME');
    const nodeHost: string = this.configService.get<string>('NODE_HOST');
    const nodePort: string = this.configService.get<string>('NODE_PORT');
    const token: string = this.configService.get<string>('NODE_TOKEN');

    const url: string = `${nodeHttpScheme}://${nodeHost}:${nodePort}/${path}`;

    try {
      const config = {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Algo-API-Token': token,
        },
      };

      let result: AxiosResponse<any>;

      if (method === 'POST') {
        result = await this.httpService.axiosRef.post(url, data, config);
      } else {
        result = await this.httpService.axiosRef.get(url, config);
      }

      return result.data;
    } catch (error) {
      throw error;
    }
  }

  async waitConfirmation(txId: string, waitRounds: bigint = 20n) {
    // copy paste logic from algo-sdk
    const startRound = (await this.getSuggestedParams()).lastRound;
    const stopRound = startRound + waitRounds;

    let currentRound = startRound;
    while (currentRound < stopRound) {
      let poolError = false;
      try {
        const pendingInfo = await this.makeAlgoNodeRequest(`v2/transactions/pending/${txId}`, 'GET');

        if (pendingInfo['confirmed-round']) {
          // Got the completed Transaction
          return pendingInfo;
        }

        if (pendingInfo['pool-error']) {
          // If there was a pool error, then the transaction has been rejected
          poolError = true;
          throw new Error(`Transaction Rejected: ${pendingInfo['pool-error']}`);
        }
      } catch (err) {
        // Ignore errors from PendingTransactionInformation, since it may return 404 if the algod
        // instance is behind a load balancer and the request goes to a different algod than the
        // one we submitted the transaction to
        if (poolError) {
          // Rethrow error only if it's because the transaction was rejected
          throw err;
        }
      }

      await this.makeAlgoNodeRequest(`v2/status/wait-for-block-after/${currentRound}`, 'GET');
      currentRound += BigInt(1);
    }
  }

  async getSuggestedParams(): Promise<TruncatedSuggestedParamsResponse> {
    try {
      const response = await this.makeAlgoNodeRequest('v2/transactions/params', 'GET');
      const suggestedParams: TruncatedSuggestedParamsResponse = {
        lastRound: BigInt(response['last-round']),
        minFee: response['min-fee'],
      };
      return suggestedParams;
    } catch (error) {
      throw mapUpstreamError('AlgodNode', error);
    }
  }

  /**
   * Get the account detail for a specific public address.
   *
   * @param public_address - The public address of the account.
   * @returns - The account detail including amount, min balance, and asset holdings.
   */
  async getAccountDetail(public_address: string): Promise<TruncatedAccountResponse> {
    try {
      const response = await this.makeAlgoNodeRequest(`v2/accounts/${public_address}`, 'GET');

      Logger.debug(`Account detail response: ${JSON.stringify(response)}`);

      const truncatedAccountResponse: TruncatedAccountResponse = {
        amount: BigInt(response['amount']),
        minBalance: BigInt(response['min-balance']),
        assets: response['assets'].map(
          (asset: any) => ({ assetId: asset['asset-id'], balance: asset['amount'] }) as TruncatedAssetHolding,
        ),
      };
      return truncatedAccountResponse;
    } catch (error) {
      throw mapUpstreamError('AlgodNode', error);
    }
  }

  // Get Algo Balance, fetch balance from AlgoD
  async getAccountBalance(public_address: string): Promise<bigint> {
    try {
      const response = await this.makeAlgoNodeRequest(`v2/accounts/${public_address}`, 'GET');

      Logger.debug(`Account balance response: ${JSON.stringify(response)}`);

      return BigInt(response['amount']);
    } catch (error) {
      throw mapUpstreamError('AlgodNode', error);
    }
  }

  /**
   * Get the asset holding for a specific account and asset ID.
   *
   * @param public_address - The public address of the account.
   * @param asset_id - The ID of the asset.
   * @returns - The asset holding for the account and asset ID, or null if not found.
   */
  async getAccountAssetHoldings(public_address: string): Promise<AssetHolding[]> {
    try {
      const response: AccountAssetsResponse = await this.makeAlgoNodeRequest(`v2/accounts/${public_address}`, 'GET');

      Logger.debug(`Account asset holdings response: ${JSON.stringify(response)}`);

      return response.assets;
    } catch (error) {
      throw mapUpstreamError('AlgodNode', error);
    }
  }

  /**
   * Get the asset holding for a specific account and asset ID.
   *
   * @param public_address - The public address of the account.
   * @param asset_id - The ID of the asset.
   * @returns - The asset holding for the account and asset ID, or null if not found.
   */

  async getAccountAsset(public_address: string, asset_id: bigint): Promise<TruncatedAccountAssetResponse | null> {
    try {
      await this.makeAlgoNodeRequest(`v2/accounts/${public_address}/assets/${asset_id}/`, 'GET');
      const truncatedAccountAssetResponse: TruncatedAccountAssetResponse = {};
      return truncatedAccountAssetResponse;
    } catch (error) {
      const status = error.response?.status;
      if (status === 404) {
        return null;
      }
      throw mapUpstreamError('AlgodNode', error);
    }
  }

  /**
   * Get the last round number from the Algorand node.
   *
   * @returns - last round number
   */
  async getLastRound(): Promise<bigint> {
    try {
      const response = await this.makeAlgoNodeRequest('v2/status', 'GET');
      return BigInt(response['last-round']);
    } catch (error) {
      throw mapUpstreamError('AlgodNode', error);
    }
  }

  /**
   * Submits a transaction or transactions to the Algorand network.
   *
   * @param txnOrtxns - The transaction or transactions to be submitted.
   * @returns - The transaction ID of the submitted transaction.
   */
  async submitTransaction(txnOrtxns: Uint8Array | Uint8Array[]): Promise<TruncatedPostTransactionsResponse> {
    try {
      const data = txnOrtxns instanceof Uint8Array ? Buffer.from(txnOrtxns) : Buffer.concat(txnOrtxns);
      const response = await this.makeAlgoNodeRequest('v2/transactions', 'POST', data);
      const postTransactionResponse: TruncatedPostTransactionsResponse = {
        txid: response['txId'],
      };

      await this.waitConfirmation(postTransactionResponse.txid);
      return postTransactionResponse;
    } catch (error) {
      throw mapUpstreamError('AlgodNode', error);
    }
  }
}
