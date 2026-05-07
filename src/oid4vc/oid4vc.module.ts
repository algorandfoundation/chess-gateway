import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Oid4vcConfig } from './oid4vc.config';
import { Oid4vcAgentProvider } from './agent/oid4vc-agent.provider';
import { Oid4vcIssuerService } from './issuer/oid4vc-issuer.service';
import { Oid4vcIssuerController } from './issuer/oid4vc-issuer.controller';
import { Oid4vcVerifierService } from './verifier/oid4vc-verifier.service';
import { Oid4vcVerifierController } from './verifier/oid4vc-verifier.controller';
import { Oid4vcIssuanceSession } from './entities/oid4vc-issuance-session.entity';
import { Oid4vcVerificationSession } from './entities/oid4vc-verification-session.entity';
import { Oid4vcVaultKeyBinding } from './entities/oid4vc-vault-key-binding.entity';
import { Oid4vcUserDeviceManifest } from './entities/oid4vc-user-device-manifest.entity';
import { Oid4vcUserDeviceManifestRevision } from './entities/oid4vc-user-device-manifest-revision.entity';
import { DidModule } from '../did/did.module';
import { VaultModule } from '../vault/vault.module';
import { AuthModule } from '../auth/auth.module';
import { AlgoVaultTokenProvider } from './algo/algo-vault-token.provider';
import { DeviceManifestService } from './devices/device-manifest.service';
import { DeviceManifestController } from './devices/device-manifest.controller';

/**
 * Standalone Nest module exposing OID4VCI (issuance) and OID4VP (verification)
 * capabilities backed by a Credo (`@credo-ts/openid4vc`) agent.
 *
 * Wiring requirements:
 * - `TypeOrmModule.forRoot` must already be configured by the host app.
 * - The Credo Express routers exposed by `Oid4vcAgentProvider` must be mounted
 *   on the global Express adapter from `main.ts`. Example:
 *
 *     const provider = app.get(Oid4vcAgentProvider);
 *     const cfg = app.get(Oid4vcConfig);
 *     app.use(cfg.issuerPath, provider.issuerRouter);
 *     app.use(cfg.verifierPath, provider.verifierRouter);
 *
 *   This must happen *before* `app.listen` and *outside* the global `/v1`
 *   prefix so wallets reach the protocol endpoints at the URLs declared in
 *   the issuer/verifier metadata.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Oid4vcIssuanceSession,
      Oid4vcVerificationSession,
      Oid4vcVaultKeyBinding,
      Oid4vcUserDeviceManifest,
      Oid4vcUserDeviceManifestRevision,
    ]),
    // DidModule + VaultModule give the AlgoDidRegistrar/AlgoDidResolver the
    // existing on-chain DID publication path and Vault access. Importing
    // them keeps the OID4VC subsystem decoupled from `app.module.ts`'s
    // assembly order: Nest will wire the same DidService instance whether
    // the host imports DidModule directly or transitively through here.
    DidModule,
    VaultModule,
    // AuthModule provides AuthService so the issuer controller can map a
    // Better-Auth session (`session.user.email`) to the vault player id
    // under which the on-chain DID is keyed.
    AuthModule,
  ],
  controllers: [Oid4vcIssuerController, Oid4vcVerifierController, DeviceManifestController],
  providers: [
    Oid4vcConfig,
    AlgoVaultTokenProvider,
    Oid4vcAgentProvider,
    Oid4vcIssuerService,
    Oid4vcVerifierService,
    DeviceManifestService,
  ],
  exports: [
    Oid4vcConfig,
    Oid4vcAgentProvider,
    Oid4vcIssuerService,
    Oid4vcVerifierService,
    DeviceManifestService,
  ],
})
export class Oid4vcModule {}
