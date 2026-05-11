import { Module } from '@nestjs/common';
import { VaultModule } from '../vault/vault.module';
import { JwtModule } from '@nestjs/jwt';
import { Auth } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthUserService } from './auth-user.service';
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
      useFactory: async (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          // Fail fast at startup with an actionable message instead of
          // letting `jsonwebtoken` throw the cryptic
          // `secretOrPrivateKey must have a value` on the first signing
          // call (e.g. POST /v1/auth/token). dotenv treats a leading
          // `#` in a `.env` value as a comment, so `JWT_SECRET=#foo`
          // ends up empty — set a real value.
          throw new Error(
            'JWT_SECRET is not set. Configure a non-empty JWT_SECRET in the gateway environment (note: dotenv treats a leading `#` as a comment).',
          );
        }
        return { secret };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [Auth],
  providers: [
    AuthService,
    AuthUserService,
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
