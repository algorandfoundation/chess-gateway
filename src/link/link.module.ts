import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LinkService } from './link.service';
import { LinkController } from './link.controller';
import { VaultModule } from '../vault/vault.module';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { auth } from './auth';
import { AuthService } from '../auth/auth.service';
import { VerificationModule } from './verification/verification.module';
@Module({
  imports: [
    BetterAuthModule.forRoot({ auth, disableGlobalAuthGuard: true }),
    VerificationModule,
    VaultModule,
    AuthModule,
    ConfigModule,
  ],
  controllers: [LinkController],
  providers: [AuthService, LinkService],
  exports: [LinkService],
})
export class LinkModule {}
