import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { WalletModule } from './wallet/wallet.module';
import { VaultModule } from './vault/vault.module';
import { ChainModule } from './chain/chain.module';
import { DidModule } from './did/did.module';
import { Oid4vcModule } from './oid4vc/oid4vc.module';
import { LinkModule } from './link/link.module';
import { AuthModule } from './auth/auth.module';
/**
 * Root Nest module.
 *
 * The service drops Better-Auth, the legacy `link/verifications` flow, per-user vault transits,
 * and device-manifest storage, but **keeps** the original
 * JWT-over-Vault-AppRole auth (`AuthModule`) that gates the manager RPC
 * surface. Vault roles remain the source of truth for manager
 * credentials; `/v1/auth/sign-in` exchanges a vault token for a signed
 * JWT and the global `AuthGuard` enforces it on every route that is
 * not explicitly `@Public()`.
 *
 * The former `V2Module` has been folded back into the single `/v1`
 * surface. There is no `/v2` prefix anymore.
 *
 *   - `AuthModule` — JWT + vault-role sign-in (global `AuthGuard`), and
 *     the did:key auth stack.
 *   - `VaultModule` / `ChainModule` — manager Vault key + Algorand client.
 *   - `WalletModule` — manager-side payment / asset primitives.
 *   - `DidModule` — manager `did:algo` cache and publish path.
 *   - `Oid4vcModule` — Credo agent + OID4VCI/OID4VP surface.
 *   - `LinkModule` — stateful did:key + device-attestation
 *     handshake that mints a per-user `did:algo` (controlled by the
 *     did:key) and issues a bound `device-attestation-credential`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    WalletModule,
    VaultModule,
    ChainModule,
    DidModule,
    Oid4vcModule,
    LinkModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
