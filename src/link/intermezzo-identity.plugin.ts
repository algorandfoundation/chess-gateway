/**
 * Intermezzo Identity (deprecated)
 * --------------------------------
 * Historically this file owned a custom better-auth plugin with its own
 * `intermezzo_identity` table that mapped `email ↔ vault userId`. That
 * design has been retired: the equivalent mapping already lives in the
 * NestJS-side `link_verification` TypeORM entity (see
 * `link/verification/entities/link-verification.entity.ts`), and
 * provisioning new vault users now happens at NestJS application
 * bootstrap via {@link IntermezzoProvisionerService}.
 *
 * This file is kept as an empty stub for one more revision so that any
 * lingering imports fail loudly with a clear deprecation message
 * instead of silently breaking. Remove on next pass.
 */
export const INTERMEZZO_IDENTITY_DEPRECATED =
  'intermezzoIdentity plugin removed; use IntermezzoProvisionerService + LinkVerification (TypeORM) instead';
