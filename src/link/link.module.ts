import { Module } from '@nestjs/common';
import { LinkService } from './link.service';
import { LinkController } from './link.controller';
import { IntermezzoProvisionerService } from './intermezzo-provisioner.service';
import { VaultModule } from '../vault/vault.module';
import { WalletModule } from '../wallet/wallet.module';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { auth } from './auth';
import { AuthService } from '../auth/auth.service';
import { VerificationModule } from './verification/verification.module';
import { DidModule } from '../did/did.module';
import { Oid4vcModule } from '../oid4vc/oid4vc.module';
import { IdentityModule } from './identity.module';
@Module({
  imports: [
    BetterAuthModule.forRoot({ auth, disableGlobalAuthGuard: true }),
    VerificationModule,
    VaultModule,
    WalletModule,
    AuthModule,
    DidModule,
    ConfigModule,
    // IdentityModule exposes the email ↔ vault userId binding lookup
    // (formerly methods on AuthService). LinkService uses it in
    // `linkResponse` and `autoAssociate` to resolve an email to its
    // player id without depending on AuthModule for that mapping.
    IdentityModule,
    // Oid4vcModule exports DeviceManifestService, which LinkService uses
    // to seed the wallet's did:key device manifest on first attestation.
    // See `src/oid4vc/DISCOVERY.md`.
    Oid4vcModule,
  ],
  controllers: [LinkController],
  providers: [AuthService, LinkService, IntermezzoProvisionerService],
  exports: [LinkService],
})
export class LinkModule {}
