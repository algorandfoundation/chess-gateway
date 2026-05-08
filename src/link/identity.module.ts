import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { VerificationModule } from './verification/verification.module';

/**
 * Standalone module exposing {@link IdentityService} so any feature
 * module that needs to translate between a better-auth email and a
 * Vault player id can import it without pulling in the full
 * `LinkModule` (which transitively depends on `Oid4vcModule`).
 *
 * Imported by `LinkModule` and `Oid4vcModule`; both reuse the same
 * service instance.
 */
@Module({
  imports: [VerificationModule],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
