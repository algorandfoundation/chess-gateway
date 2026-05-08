import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WalletModule } from './wallet/wallet.module';
import { ConfigModule } from '@nestjs/config';
import { VaultModule } from './vault/vault.module';
import { ChainModule } from './chain/chain.module';
import { AuthModule } from './auth/auth.module';
import { LinkModule } from './link/link.module';
import { DidModule } from './did/did.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Oid4vcModule } from './oid4vc/oid4vc.module';
import { AppController } from './app.controller';
import { HealthService } from './health.service';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'database.sqlite',
      autoLoadEntities: true,
      synchronize: true, // Only for development
    }),
    // Health probes hit Vault and the Algorand node directly via axios.
    HttpModule,
    AuthModule,
    LinkModule,
    WalletModule,
    VaultModule,
    ChainModule,
    DidModule,
    Oid4vcModule,
  ],
  controllers: [AppController],
  providers: [HealthService],
})
export class AppModule {}
