import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { Wallet } from './wallet.controller';
import { WalletService } from './wallet.service';
import { VaultModule } from '../vault/vault.module';
import { ChainModule } from '../chain/chain.module';
import { ConfigModule } from '@nestjs/config';
import { DidModule } from '../did/did.module';
import { VerificationModule } from '../link/verification/verification.module';

@Module({
  imports: [HttpModule, VaultModule, ChainModule, ConfigModule, DidModule, VerificationModule],
  controllers: [Wallet],
  providers: [WalletService],
})
export class WalletModule {}
