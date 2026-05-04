import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LinkVerification } from './entities/link-verification.entity';
import { VerificationService } from './verification.service';
import { VerificationController } from './verification.controller';

@Module({
  imports: [TypeOrmModule.forFeature([LinkVerification])],
  controllers: [VerificationController],
  providers: [VerificationService],
  exports: [VerificationService, TypeOrmModule],
})
export class VerificationModule {}
