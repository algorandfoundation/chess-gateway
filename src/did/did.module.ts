import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChainModule } from '../chain/chain.module';
import { VaultModule } from '../vault/vault.module';
import { VerificationModule } from '../link/verification/verification.module';
import { DidRecord } from './entities/did-record.entity';
import { Oid4vcUserDeviceManifest } from '../oid4vc/entities/oid4vc-user-device-manifest.entity';
import { Oid4vcUserDeviceManifestRevision } from '../oid4vc/entities/oid4vc-user-device-manifest-revision.entity';
import { DidService } from './did.service';
import { DidController } from './did.controller';

/**
 * Wires up DID-algo publication + local resolver capabilities.
 *
 * `DidService` depends on the existing `ChainService` (signature
 * assembly) and `VaultService` (manager key custody), so both modules
 * are imported here. Re-exporting `DidService` lets `WalletService`
 * trigger a DID publish whenever a new user is created.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DidRecord,
      Oid4vcUserDeviceManifest,
      Oid4vcUserDeviceManifestRevision,
    ]),
    ChainModule,
    VaultModule,
    VerificationModule,
    ConfigModule,
  ],
  controllers: [DidController],
  providers: [DidService],
  exports: [DidService, TypeOrmModule],
})
export class DidModule {}
