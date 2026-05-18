import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainModule } from '../../chain/chain.module';
import { VaultModule } from '../../vault/vault.module';
import { VerificationModule } from '../verification/verification.module';
import { SponsoredController } from './sponsored.controller';
import { SponsoredService } from './sponsored.service';
import { WalletModule } from '../../wallet/wallet.module';

@Module({
  imports: [WalletModule, VerificationModule, VaultModule, ChainModule, ConfigModule],
  controllers: [SponsoredController],
  providers: [SponsoredService],
})
export class SponsoredModule {}
