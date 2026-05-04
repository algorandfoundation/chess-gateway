import { Module } from '@nestjs/common';
import { WalletModule } from './wallet/wallet.module';
import { ConfigModule } from '@nestjs/config';
import { VaultModule } from './vault/vault.module';
import { ChainModule } from './chain/chain.module';
import { AuthModule } from './auth/auth.module';
import { LinkModule } from './link/link.module';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'database.sqlite',
      autoLoadEntities: true,
      synchronize: true, // Only for development
    }),
    AuthModule,
    LinkModule,
    WalletModule,
    VaultModule,
    ChainModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
