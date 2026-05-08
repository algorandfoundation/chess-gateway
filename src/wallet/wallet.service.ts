import { Injectable, Logger } from '@nestjs/common';
import { VaultService } from '../vault/vault.service';
import { ChainService } from '../chain/chain.service';
import { DidService } from '../did/did.service';
import { VerificationService } from '../link/verification/verification.service';
import { LinkVerification } from '../link/verification/entities/link-verification.entity';
import { CreateAssetDto } from './create-asset.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import { ConfigService } from '@nestjs/config';
import { ManagerDetailDto } from './manager-detail.dto';
import { plainToClass } from 'class-transformer';
import { AssetHolding } from 'src/chain/algo-node-responses';
import { Address } from '@algorandfoundation/algokit-utils';
import { decodeTransaction } from '@algorandfoundation/algokit-utils/transact';

@Injectable()
export class WalletService {
  constructor(
    private readonly vaultService: VaultService,
    private readonly chainService: ChainService,
    private readonly configService: ConfigService,
    private readonly didService: DidService,
    private readonly verificationService: VerificationService,
  ) {}

  /**
   * Resolve the associated local wallet address for a user, if any.
   * Returns `null` when no link verification record exists or when the
   * most recent association did not supply a wallet address — callers
   * always emit `wallet_address` (string or null) on responses.
   */
  private async resolveLinkedWalletAddress(user_id: string): Promise<string | null> {
    const verifications: LinkVerification[] = await this.verificationService.findByPlayerId(user_id);
    if (!verifications || verifications.length === 0) return null;
    // Pick the most recently associated verification when multiple exist.
    const verification = verifications.reduce((a, b) =>
      a.associatedAt && b.associatedAt && a.associatedAt > b.associatedAt ? a : b,
    );
    return verification.walletAddress ? verification.walletAddress : null;
  }

  async getUserInfo(user_id: string, vault_token: string): Promise<UserInfoResponseDto> {
    // Accept either the vault user id or the Better-Auth user id; resolve
    // to the canonical vault id before any Vault / DID / verification lookups.
    user_id = await this.verificationService.resolveVaultUserId(user_id);
    const public_address = await this.vaultService.getUserPublicKey(user_id, vault_token);

    // get algo balance
    const encodedAddress = new Address(public_address).toString();
    const algoBalance: bigint = await this.chainService.getAccountBalance(encodedAddress);
    Logger.debug(`User ${user_id} Algo Balance: ${algoBalance}`);

    const did = await this.didService.buildUserDidInfo(user_id);
    const wallet_address = await this.resolveLinkedWalletAddress(user_id);
    return {
      user_id,
      public_address: encodedAddress,
      algoBalance: algoBalance.toString(),
      did,
      wallet_address,
    };
  }

  async getManagerInfo(vault_token: string): Promise<ManagerDetailDto> {
    const public_address = await this.vaultService.getManagerPublicKey(vault_token);
    // asset holdings
    const account: AssetHolding[] = await this.chainService.getAccountAssetHoldings(
      new Address(public_address).toString(),
    );

    // Log debug with stringify
    Logger.debug(`Manager account details: ${JSON.stringify(account)}`);

    // Get Algo Balance
    const algoBalance: bigint = await this.chainService.getAccountBalance(new Address(public_address).toString());
    Logger.debug(`Manager Algo Balance: ${algoBalance}`);

    return plainToClass(ManagerDetailDto, {
      public_address: new Address(public_address).toString(),
      assets: account,
      algoBalance: algoBalance.toString(),
    });
  }

  // Create new user and key
  async userCreate(user_id: string, vault_token: string): Promise<UserInfoResponseDto> {
    const transitKeyPath: string = this.configService.get<string>('VAULT_TRANSIT_USERS_PATH');

    const public_key: Buffer = await this.vaultService.transitCreateKey(user_id, transitKeyPath, vault_token);
    const public_address: string = new Address(public_key).toString();

    // Publish the new user's DID document on the did:algo registry.
    // Any failure here propagates and aborts user creation — we will not
    // leave a user behind without a valid on-chain DID.
    const publication = await this.didService.publishUserDid({
      userId: user_id,
      publicKey: new Uint8Array(public_key),
      vaultToken: vault_token,
    });

    const wallet_address = await this.resolveLinkedWalletAddress(user_id);
    return {
      user_id,
      public_address,
      algoBalance: '0',
      did: publication.did ?? null,
      wallet_address,
    };
  }

  // Get all users
  async getKeys(vault_token: string): Promise<UserInfoResponseDto[]> {
    const keys: UserInfoResponseDto[] = (await this.vaultService.getKeys(vault_token)) as UserInfoResponseDto[];

    // Enrich each entry: convert raw vault public key bytes to an Algorand
    // address and attach the DID and link/verification status so the list
    // endpoint exposes the same shape as the per-user detail endpoint.
    return Promise.all(
      keys.map(async (key) => {
        key.public_address = new Address(Buffer.from(key.public_address, 'base64')).toString();
        key.did = await this.didService.buildUserDidInfo(key.user_id);
        key.wallet_address = await this.resolveLinkedWalletAddress(key.user_id);
        return key;
      }),
    );
  }
  /**
   *
   * Fetches the asset balance for a user by their user ID and vault token.
   * @param user_id - The ID of the user whose asset balance is to be fetched.
   * @param vault_token - The token used to authenticate with the vault.
   * @returns An array of AssetHolding objects representing the user's asset balance.
   * @throws Will throw an error if the user is not found or if there is an issue with the vault token.
   */
  async getAssetHoldings(user_id: string, vault_token: string): Promise<AssetHolding[]> {
    const userPublicAddress: string = (await this.getUserInfo(user_id, vault_token)).public_address;

    // log
    Logger.debug(`Fetching asset balance for user: ${user_id} with address: ${userPublicAddress}`);

    const account: AssetHolding[] = await this.chainService.getAccountAssetHoldings(userPublicAddress);
    return account;
  }

  /**
   * Signs a transaction as a user and adds the signature to the transaction.
   *
   * @param user_id The ID of the user signing the transaction.
   * @param tx The transaction to be signed, as a Uint8Array.
   * @param vault_token The token used to authenticate with the vault.
   * @returns The signed transaction, as a Uint8Array.
   */
  async signTxAsUser(
    user_id: string,
    tx: Uint8Array<ArrayBufferLike>,
    vault_token: string,
  ): Promise<Uint8Array<ArrayBufferLike>> {
    user_id = await this.verificationService.resolveVaultUserId(user_id);
    const vaultRawSig: Buffer = await this.vaultService.signAsUser(user_id, tx, vault_token);
    // split vault specific prefixes vault:${version}:signature
    const signature = vaultRawSig.toString().split(':')[2];
    // vault default base64 decode
    const decoded: Buffer = Buffer.from(signature, 'base64');
    // return as Uint8Array
    const sig: Uint8Array = new Uint8Array(decoded);

    const signedTx: Uint8Array<ArrayBufferLike> = this.chainService.addSignatureToTxn(tx, sig);
    return signedTx;
  }

  /**
   * Signs a transaction as a manager and adds the signature to the transaction.
   *
   * @param tx The transaction to be signed, as a Uint8Array.
   * @param vault_token The token used to authenticate with the vault.
   * @returns The signed transaction, as a Uint8Array.
   */
  async signTxAsManager(tx: Uint8Array<ArrayBufferLike>, vault_token: string): Promise<Uint8Array<ArrayBufferLike>> {
    const vaultRawSig: Buffer = await this.vaultService.signAsManager(tx, vault_token);
    // split vault specific prefixes vault:${version}:signature
    const signature = vaultRawSig.toString().split(':')[2];
    // vault default base64 decode
    const decoded: Buffer = Buffer.from(signature, 'base64');
    // return as Uint8Array
    const sig: Uint8Array = new Uint8Array(decoded);
    const signedTx: Uint8Array<ArrayBufferLike> = this.chainService.addSignatureToTxn(tx, sig);
    return signedTx;
  }

  async createAsset(options: CreateAssetDto, vault_token: string) {
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();
    const tx: Uint8Array<ArrayBufferLike> = await this.chainService.craftAssetCreateTx(managerPublicAddress, options);
    const signedTx: Uint8Array<ArrayBufferLike> = await this.signTxAsManager(tx, vault_token);
    const transactionId: string = (await this.chainService.submitTransaction(signedTx)).txid;

    return transactionId;
  }

  /**
   *
   * Transfers Algos from one user to another.
   *
   * @param vault_token The token used to authenticate with the vault.
   * @param fromUserId The ID of the user sending the asset.
   * @param toAddress The address of the user receiving the asset.
   * @param amount The amount of the asset to be transferred.
   */
  async transferAlgoToAddress(
    vault_token: string,
    fromUserId: string,
    toAddress: string,
    amount: number,
  ): Promise<string> {
    let signedTx: Uint8Array;
    let fromAddress: string;

    try {
      if (fromUserId === 'manager') {
        const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
        fromAddress = new Address(managerPublicKey).toString();
      } else {
        fromAddress = (await this.getUserInfo(fromUserId, vault_token)).public_address;
      }
    } catch (error) {
      throw new Error(`Failed to get from address for user ${fromUserId}: ${error.message}`);
    }

    Logger.debug(`Transferring ${amount} Algos from ${fromUserId} (${fromAddress}) to ${toAddress}`);
    // craft algorand pay transaction
    const payTx: Uint8Array = await this.chainService.craftPaymentTx(
      fromAddress,
      toAddress,
      amount,
      await this.chainService.getSuggestedParams(),
    );

    try {
      if (fromUserId === 'manager') {
        Logger.debug(`Signing transaction as manager: ${payTx.toString()}`);
        // sign as manager
        signedTx = await this.signTxAsManager(payTx, vault_token);
      } else {
        // sign as user
        signedTx = await this.signTxAsUser(fromUserId, payTx, vault_token);
      }

      // submit transaction
      return (await this.chainService.submitTransaction(signedTx)).txid;
    } catch (error) {
      throw new Error(`Failed to sign transaction as user ${fromUserId}: ${error.message}`);
    }
  }

  /**
   * Transfers an asset from the manager to a user.
   *
   * The function first checks if the user has opted in for the asset. If not, an opt-in transaction is created.
   * It then checks if the user has enough Algo balance to cover the minimum balance after the transactions.
   * If not, a payment transaction is created to cover the difference.
   * The function then crafts the necessary transactions, groups them, signs them, and submits them to the blockchain.
   *
   * @param assetId The ID of the asset to be transferred.
   * @param userId The ID of the user receiving the asset.
   * @param amount The amount of the asset to be transferred.
   * @param lease An optional 32 byte lease encoded as base64.
   * @param note An optional transaction note.
   * @param vault_token The token used to authenticate with the vault.
   * @returns The transaction ID of the submitted transaction.
   */
  async transferAsset(
    vault_token: string,
    assetId: bigint,
    userId: string,
    amount: number,
    lease?: string,
    note?: string,
  ) {
    const userPublicAddress: string = (await this.getUserInfo(userId, vault_token)).public_address;
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();

    const suggested_params = await this.chainService.getSuggestedParams();

    // check if user opted in for the asset

    let willOptInTx: boolean = false;
    const account_asset = await this.chainService.getAccountAsset(userPublicAddress, assetId);
    if (account_asset == null) {
      willOptInTx = true;
    }

    // check if user has enough algo balance to cover min balance after transactions

    let willPaymentTx: boolean = false;
    let userExtraAlgoNeed: number = 0;
    if (willOptInTx) {
      userExtraAlgoNeed += 100000; // opt-in min balance
      userExtraAlgoNeed += Number(suggested_params.minFee); // opt-in tx fee
    }
    // owned amount can be negative if user has no algo at all
    const userAccountDetail = await this.chainService.getAccountDetail(userPublicAddress);
    const userOwnedExtraAlgo: bigint = userAccountDetail.amount - userAccountDetail.minBalance;
    if (userOwnedExtraAlgo < userExtraAlgoNeed) {
      willPaymentTx = true;
      userExtraAlgoNeed -= Number(userOwnedExtraAlgo);
    }

    // build unsigned txs

    const unSignedTxs: Uint8Array[] = [];
    if (willPaymentTx) {
      unSignedTxs.push(
        await this.chainService.craftPaymentTx(
          managerPublicAddress,
          userPublicAddress,
          userExtraAlgoNeed,
          suggested_params,
        ),
      );
    }
    if (willOptInTx) {
      unSignedTxs.push(
        await this.chainService.craftAssetTransferTx(
          userPublicAddress,
          userPublicAddress,
          assetId,
          0,
          lease,
          undefined,
          suggested_params,
        ),
      );
    }
    unSignedTxs.push(
      await this.chainService.craftAssetTransferTx(
        managerPublicAddress,
        userPublicAddress,
        assetId,
        amount,
        lease,
        note,
        suggested_params,
      ),
    );

    // group them

    const unSignedGroupedTxns: Uint8Array<ArrayBufferLike>[] = this.chainService.setGroupID(unSignedTxs);

    // sign txs by sender

    const signedTxs: Uint8Array[] = [];
    for (const tx of unSignedGroupedTxns) {
      const isUserTx: boolean = decodeTransaction(tx).sender.toString() == userPublicAddress;
      const isManagerTx: boolean = decodeTransaction(tx).sender.toString() == managerPublicAddress;

      if (isUserTx) {
        signedTxs.push(await this.signTxAsUser(userId, tx, vault_token));
      } else if (isManagerTx) {
        signedTxs.push(await this.signTxAsManager(tx, vault_token));
      } else {
        throw new Error('Invalid sender');
      }
    }

    return (await this.chainService.submitTransaction(signedTxs)).txid;
  }

  /**
   * Claws back an asset from a user to the manager account.
   *
   * The function crafts the necessary transaction, signs it, and submits it to the blockchain.
   *
   * @param assetId The ID of the asset to be clawed back.
   * @param userId The ID of the user to claw back from.
   * @param amount The amount of the asset to be clawed back.
   * @param lease An optional 32 byte lease encoded as base64.
   * @param note An optional transaction note.
   * @param vault_token The token used to authenticate with the vault.
   *
   * @returns The transaction ID of the submitted transaction.
   */

  async clawbackAsset(
    vault_token: string,
    assetId: bigint,
    userId: string,
    amount: number,
    lease?: string,
    note?: string,
  ) {
    const userPublicAddress: string = (await this.getUserInfo(userId, vault_token)).public_address;
    const managerPublicKey: Buffer = await this.vaultService.getManagerPublicKey(vault_token);
    const managerPublicAddress: string = new Address(managerPublicKey).toString();

    const suggested_params = await this.chainService.getSuggestedParams();

    // build unsigned tx
    const tx: Uint8Array<ArrayBufferLike> = await this.chainService.craftAssetClawbackTx(
      managerPublicAddress,
      userPublicAddress,
      managerPublicAddress,
      assetId,
      amount,
      lease,
      note,
      suggested_params,
    );

    // sign tx by manager

    const signedTx: Uint8Array<ArrayBufferLike> = await this.signTxAsManager(tx, vault_token);
    const transactionId: string = (await this.chainService.submitTransaction(signedTx)).txid;

    return transactionId;
  }
}
