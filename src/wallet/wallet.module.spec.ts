import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletModule } from './wallet.module';
import { Wallet } from './wallet.controller';
import { WalletService } from './wallet.service';
import { DidRecord } from '../did/entities/did-record.entity';

// Optionally, if you need to mock dependencies from the Vault and Chain modules,
// you can create dummy modules or mocks. For this simple module test,
// we assume that the imported modules work correctly.

describe('WalletModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        // Importing ConfigModule with defaults to prevent errors due to missing env vars.
        ConfigModule.forRoot({ isGlobal: true }),
        // In-memory sqlite to satisfy `DidModule`'s `forFeature(DidRecord)` —
        // the wallet module transitively depends on it through the DID publisher.
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [DidRecord],
          synchronize: true,
        }),
        HttpModule,
        // Import the WalletModule, which already imports VaultModule and ChainModule.
        WalletModule,
      ],
    }).compile();
  });

  it('should be defined', () => {
    expect(moduleRef).toBeDefined();
  });

  it('should have Wallet controller defined', () => {
    const walletController = moduleRef.get<Wallet>(Wallet);
    expect(walletController).toBeDefined();
  });

  it('should have WalletService defined', () => {
    const walletService = moduleRef.get<WalletService>(WalletService);
    expect(walletService).toBeDefined();
  });
});
