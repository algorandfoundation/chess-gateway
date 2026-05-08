import { Module } from '@nestjs/common';
import { VaultModule } from '../vault/vault.module';
import { JwtModule } from '@nestjs/jwt';
import { Auth } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthUserService } from './auth-user.service';
import { AuthUserProvisioningService } from './auth-user-provisioning.service';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WalletModule } from '../wallet/wallet.module';
import { VerificationModule } from '../link/verification/verification.module';

@Module({
  imports: [
    VaultModule,
    ConfigModule,
    // Provisioning new Intermezzo users requires both vault key
    // creation (WalletModule) and the LinkVerification mapping
    // (VerificationModule); both are pulled in here so the
    // `POST/PUT /auth/user` endpoints are self-contained.
    WalletModule,
    VerificationModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      global: true,
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [Auth],
  providers: [
    AuthService,
    AuthUserService,
    // Eagerly instantiated so its `onModuleInit` registers the
    // Better-Auth `user.create.after` hook before any request
    // (including OTP / social sign-up) can land.
    AuthUserProvisioningService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  // Export AuthService so other modules (Oid4vcModule, WalletModule,
  // LinkModule) can resolve the email → vault player id mapping
  // without re-implementing the Better-Auth + LinkVerification lookup.
  exports: [AuthService],
})
export class AuthModule {}
