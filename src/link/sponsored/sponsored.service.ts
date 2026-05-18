import { Injectable, BadRequestException } from '@nestjs/common';
import { VerificationService } from '../verification/verification.service';
import { VaultService } from '../../vault/vault.service';
import { ChainService } from '../../chain/chain.service';
import { ConfigService } from '@nestjs/config';
import { WalletService } from '../../wallet/wallet.service';
import { Address } from '@algorandfoundation/algokit-utils';

@Injectable()
export class SponsoredService {
  constructor(
    private readonly verificationService: VerificationService,
    private readonly vaultService: VaultService,
    private readonly chainService: ChainService,
    private readonly configService: ConfigService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Claims assets from the user's vault-managed key to their linked wallet address.
   * The sponsor (manager) covers all transaction fees via an atomic fee-bearing group.
   */
  async claimAsset(
    betterAuthUserId: string,
    assetId: bigint,
    amount: number,
    lease?: string,
    note?: string,
  ): Promise<string> {
    const verification = await this.verificationService.findByUserId(betterAuthUserId);
    if (!verification?.id || !verification.isVerified || !verification.walletAddress) {
      throw new BadRequestException('Linked and verified wallet address is required before claiming assets.');
    }

    const roleId = this.configService.get<string>('VAULT_ROLE_ID');
    const secretId = this.configService.get<string>('VAULT_SECRET_ID');
    const vaultToken = await this.vaultService.getTokenWithRole(roleId, secretId);

    const userPublicKey = await this.vaultService.getUserPublicKey(verification.id, vaultToken);
    const userAddress = new Address(userPublicKey).toString();

    const sponsorPublicKey = await this.vaultService.getManagerPublicKey(vaultToken);
    const sponsorAddress = new Address(sponsorPublicKey).toString();

    const suggestedParams = await this.chainService.getSuggestedParams();
    const sponsorFee = Number(suggestedParams.minFee) * 2;

    const sponsorFeeTx = await this.chainService.craftPaymentTx(
      sponsorAddress,
      sponsorAddress,
      0,
      suggestedParams,
      sponsorFee,
    );

    const userClaimTx = await this.chainService.craftAssetTransferTx(
      userAddress,
      verification.walletAddress,
      assetId,
      amount,
      lease,
      note,
      suggestedParams,
      0,
    );

    const groupedTxs = this.chainService.setGroupID([sponsorFeeTx, userClaimTx]);
    const signedSponsorTx = await this.walletService.signTxAsManager(groupedTxs[0], vaultToken);
    const signedUserTx = await this.walletService.signTxAsUser(verification.id, groupedTxs[1], vaultToken);

    return (await this.chainService.submitTransaction([signedSponsorTx, signedUserTx])).txid;
  }
}
