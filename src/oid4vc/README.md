# OID4VC Module

Standalone Nest module that exposes [OpenID for Verifiable Credentials
Issuance](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html)
(OID4VCI) and
[OpenID for Verifiable Presentations](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html)
(OID4VP) on top of the
[`@credo-ts/openid4vc`](https://credo.js.org/guides/getting-started/set-up/openid4vc)
agent.

It supersedes the WIP work on `feat/oidc4vc`, which inlined a Credo agent in
`main.ts`. The module is integrated with the platform's existing
`did:algo` registry: the manager-controlled `DidService` is plugged into
Credo as a first-class `DidRegistrar`/`DidResolver`, and **`did:algo` is
the only DID method registered with the agent** — every credential is
signed by, and bound to, an on-chain Algorand-anchored identifier. There
is no `did:key` fallback (see *"Why no `did:key`?"* below).

## Layout

```
src/oid4vc/
├── agent/oid4vc-agent.provider.ts   Owns the Credo agent + Express routers
├── algo/                            did:algo registrar/resolver, Vault token provider,
│                                    Vault-backed Askar wallet + signing registry
├── issuer/                          OID4VCI: offer creation + credential mapper
├── verifier/                        OID4VP: presentation request + result lookup
├── entities/                        TypeORM session tracking (app-level)
├── dto/                             Validated request/response DTOs
├── oid4vc.config.ts                 Env-driven configuration
└── oid4vc.module.ts                 Wires everything for Nest
```

## Endpoints

The Nest module exposes app-level orchestration endpoints:

| Method | Path                                        | Purpose                                       |
|--------|---------------------------------------------|-----------------------------------------------|
| GET    | `/v1/oid4vc/issuer/credential-configurations` | List supported credential configurations    |
| POST   | `/v1/oid4vc/issuer/offers`                  | Create a credential offer (returns QR URI)    |
| GET    | `/v1/oid4vc/issuer/sessions/:id`            | Inspect an issuance session                   |
| POST   | `/v1/oid4vc/verifier/requests`              | Create a presentation request (returns QR URI) |
| GET    | `/v1/oid4vc/verifier/sessions/:id`          | Inspect a verification session + claims       |

The OID4VCI/OID4VP **protocol endpoints** themselves (token, credential,
authorization, authorization-request, etc.) are mounted by Credo on its own
Express routers under `OID4VC_ISSUER_PATH` (`/oid4vci`) and
`OID4VC_VERIFIER_PATH` (`/oid4vp`). They are mounted in `src/main.ts` *before*
`app.setGlobalPrefix('v1')` so they live at the absolute URLs that the issuer
metadata advertises.

## Credential formats

Two configurations are advertised by default (see
`Oid4vcIssuerService.DEFAULT_CREDENTIAL_CONFIGURATIONS`):

* `credential-sd-jwt` — IETF SD-JWT VC (HAIP-recommended)
* `credential-jwt-vc` — W3C JWT VC

mdoc (ISO 18013-5) was previously advertised but has been removed for
now; both remaining formats are DID-bound, which lets the mapper apply
uniform `#keys-2` holder binding (see below).

The credential mapper (`Oid4vcIssuerService#buildCredentialMapper`) selects the
right `OpenId4VciSignCredential` shape based on the format requested by the
wallet, populating it with the claim payload that was attached to the offer
via `issuanceMetadata`.

## DID methods

The Credo agent registers exactly **one** DID method:

* **`did:algo`** — the platform's on-chain method. Provided by
  `AlgoDidRegistrar` and `AlgoDidResolver` (`src/oid4vc/algo/`), both of
  which delegate to the existing `DidService` in `src/did`. The registrar
  publishes the document via the manager Vault key (`uploadDIDDocument` /
  `deleteDIDDocument` on `DidAlgoStorage`), and the resolver returns the
  locally cached document when one exists, otherwise rebuilds it from the
  self-described identifier.

`did:key` is intentionally **not** registered. Every actor on the
platform — manager, issuer, end-user — already has an on-chain
`did:algo` provisioned by the manager when the account is created, and
binding credentials to anything else would defeat the purpose of having
a shared on-chain root of trust. See *"Why no `did:key`?"* below.

### Issuer DID selection

**The issuer DID is the manager's `did:algo`** — the manager is the
platform's root of trust, so anchoring the issuer to it gives verifiers
a single well-known DID to allowlist and reuses the manager's existing
Vault transit key as the credential signer (no separate "issuer key"
sprawl). `Oid4vcAgentProvider#ensureIssuerDid` chooses the issuer DID at
first use and caches it for the rest of the agent's lifetime:

1. Reuse any pre-existing `did:algo` from the Credo wallet. The
   `publicKeyBase58 → Vault binding` row was persisted next to the
   `DidRecord` when the registrar first ran, so reuse needs no rebind.
2. Otherwise, ask the registrar to publish the manager's `did:algo`
   under `OID4VC_MANAGER_USER_ID` (default: `VAULT_MANAGER_KEY`,
   default `manager`). The registrar uses the existing Vault transit
   key for that name (creating one on the fly if it does not yet
   exist) and binds it for credential signing — see *"Vault-held
   credential signing"* below.

There is **no fallback** — production and local deployments alike must
run against a working Algorand network and have the AppRole provisioned.

### Holder binding (strict `#keys-2`)

Every user's `did:algo` document carries two verification methods:

* `#keys-1` — the platform-custodied Vault key (used by the issuer).
* `#keys-2` — the user's self-custody wallet key, attested via the
  `link-account` flow (App Attest / Play Integrity, derivation paths
  backed up by the recovery service). The private half lives only on
  the device.

The credential mapper enforces strict `#keys-2` binding for every
DID-bound credential (SD-JWT VC, JWT VC):

1. The offer must carry a `userId` (the Nest DTO enforces this); the
   mapper resolves the user's full DID document and refuses to continue
   if the user has no published `did:algo`.
2. The user must have completed device link/attestation so that
   `<userDid>#keys-2` exists on chain. Unlinked users cannot be issued
   credentials.
3. The wallet must prove possession of exactly `<userDid>#keys-2` —
   `#keys-1` (the platform's key) is rejected, as is any other DID URL
   or `jwk` binding.

The issued credential's `cnf` is the `#keys-2` reference; the device
that holds the matching private half is then the only thing that can
later sign Key-Binding JWTs (SD-JWT VC) or VP proofs (OID4VP).


### Why no `did:key`?

`did:key` is the natural "zero-infrastructure" DID method and many OID4VC
examples advertise it. We deliberately do **not** support it here:

* **Single root of trust.** The whole platform anchors identity on
  Algorand. Verifiers (and our own services) already resolve `did:algo`
  documents on chain; accepting a `did:key` would create a parallel,
  unverifiable identifier with no link back to the user account that was
  rewarded.
* **No revocation surface.** `did:key` documents are immutable by
  construction — you cannot rotate keys, deactivate the DID, or add a
  second verification method (e.g. the user's self-custody wallet key).
  `did:algo` lets the manager re-publish the document so the same
  identifier can outlive a key rotation.
* **No correlation with platform users.** A credential bound to a fresh
  `did:key` minted by the wallet has no on-chain link to the platform
  user it was issued to, which makes audit, revocation list lookup, and
  later presentation re-binding impossible.
* **Avoids accidental issuer downgrade.** With `did:key` available as a
  fallback, a misconfigured environment (missing AppRole, broken Algod)
  would silently issue real credentials under a throwaway issuer DID.
  Failing closed is safer than failing soft.

### Vault AppRole (dedicated `oid4vc-issuer`)

The registrar/resolver need an ambient Vault token (no HTTP request is in
flight when the agent boots). `AlgoVaultTokenProvider` performs an
AppRole login on first use and caches the resulting token, transparently
relogging in when Vault rejects the cached value.

The OID4VC subsystem uses a **dedicated AppRole**, separate from the
manager AppRole, even though their policies overlap:

* **Blast radius / rotation** — rotating the manager AppRole (offboarding,
  lost laptop) doesn't take the OID4VC issuer offline and vice versa.
* **Auditability** — every credential signature is attributed to the
  OID4VC service entity in Vault audit logs, not to a human admin.
* **Least privilege** — the policy below is the minimum the service
  needs (read user pubkeys, lazy-create user keys, sign with user keys,
  sign with the manager key). Crucially it grants **no** `keys/*`
  capability on the manager transit path — only `sign/*` — so the
  service can never rotate or destroy the manager key.
* **Process boundary** — when the issuer is one day split into its own
  deployable, it already has its own credentials.

The role is provisioned by `vault/development-init.ts` as
`pawn_oid4vc_issuer_approle` bound to `pawn_oid4vc_issuer_policy`. After
running the bootstrap script the role/secret pair is written to
`oid4vc-role-and-secrets.json` and mirrored into `.env`:

```
OID4VC_VAULT_ROLE_ID=...
OID4VC_VAULT_SECRET_ID=...
```

Production deployments should treat these as service credentials with
periodic rotation (Vault `secret_id_ttl` + AppRole renewal) independent
of the human/manager rotation cadence.

### Vault-held credential signing

Ed25519 private keys for `did:algo` identifiers live in HashiCorp Vault
(transit engine, `VAULT_TRANSIT_USERS_PATH`, e.g. `pawn/users`). The same
key that anchors the on-chain DID document is the key that signs every
credential JWS / SD-JWT / OID4VP authorization request.
Nothing in this module ever sees the private bytes.

Wiring:

* `VaultAskarWallet` (`src/oid4vc/algo/vault-askar-wallet.ts`) is a
  subclass of `@credo-ts/askar`'s `AskarWallet` that overrides `sign()`
  for Ed25519 keys whose `publicKeyBase58` is registered in
  `vaultSigningRegistry`. The override calls `VaultService.sign` (Vault's
  `transit/sign/<keyName>` endpoint), parses the `vault:v1:<base64>`
  response into the raw 64-byte signature, and **verifies the signature
  locally** against the requested public key before returning. Verify
  failures here catch Vault key rotation / binding drift before the
  credential leaves the agent.
* `Oid4vcAskarModule` (`src/oid4vc/algo/oid4vc-askar.module.ts`) is a
  drop-in replacement for `AskarModule` that registers the subclass at
  `InjectionSymbols.Wallet`. We use it instead of `AskarModule` because
  the upstream module unconditionally registers `AskarWallet` and throws
  on a second wallet binding, which would forbid subclass override.
* `vaultSigningRegistry` (`src/oid4vc/algo/vault-signing-registry.ts`)
  is a process-singleton bridge between Credo's wallet (constructed by
  Credo's tsyringe container, so unreachable by Nest DI) and the rest
  of the Nest world. It exposes `bind` / `getBinding` / `unbind` over
  the `publicKeyBase58 → { vaultKeyName, transitPath }` mapping plus a
  `setSigner` / `setRepository` pair the agent provider wires at boot.
  Mappings are **persisted to TypeORM** in the
  `oid4vc_vault_key_binding` table (`Oid4vcVaultKeyBinding` entity) and
  cached in-process for the hot path. Cache misses fall back to a
  single indexed DB lookup and warm the cache.
* `AlgoDidRegistrar.create` no longer generates a key in Askar. It pulls
  the user's existing Vault transit ed25519 key (creating one on demand
  when the user is being provisioned for the first time), persists the
  binding via `vaultSigningRegistry.bind` (write-through to the
  `oid4vc_vault_key_binding` table), then delegates to
  `DidService.publishUserDid` so the on-chain document is anchored
  against the same public key.
* The previous boot-time `rehydrateVaultBindings` loop is gone:
  bindings now survive restarts because they live in the database
  alongside the `DidRecord` they describe.

Why a wallet subclass and not a Credo `SigningProvider`:

* `SigningProvider`s are only consulted for key types Askar does **not**
  natively support. Ed25519 is native, so a `SigningProvider` for it is
  silently bypassed.
* `SigningProvider.sign` requires `privateKeyBase58`, which Vault never
  releases — the abstraction is fundamentally a poor fit for an external
  KMS.

Keys still managed by Askar:

* Public-key references for non-Vault flows (none today, but the door is
  open for holder-side keys or test fixtures — calls to `wallet.sign`
  fall through to the parent `AskarWallet` when no Vault binding is
  registered).
* All non-key data: `DidRecord`, `OpenId4VcIssuerRecord`,
  `OpenId4VcIssuanceSessionRecord`, `OpenId4VcVerificationSessionRecord`,
  SD-JWT disclosure frames. Credo 0.5.x hard-requires Askar as its
  storage backend; this is a Credo constraint, not a design choice.

## Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Public base URL of this service. Shared with Better Auth. |
| `OID4VC_ISSUER_PATH` | `/oid4vci` | Path for OID4VCI protocol endpoints |
| `OID4VC_VERIFIER_PATH` | `/oid4vp` | Path for OID4VP protocol endpoints |
| `OID4VC_LABEL` | `pawn-oid4vc` | Credo agent label |
| `OID4VC_WALLET_ID` | `pawn-oid4vc` | Askar wallet id |
| `OID4VC_WALLET_KEY` | `pawn-oid4vc-key` | Askar wallet master key (**override in prod**) |
| `OID4VC_ISSUER_DISPLAY_NAME` | `Algorand Foundation Rewards` | Issuer display name |
| `OID4VC_AUTO_INIT` | `true` | Initialise the Credo agent on bootstrap |
| `OID4VC_VAULT_ROLE_ID` | _(unset)_ | Vault AppRole id for the dedicated `pawn_oid4vc_issuer_approle`. Required for the `did:algo` issuer path; populated automatically by `vault/development-init.ts`. |
| `OID4VC_VAULT_SECRET_ID` | _(unset)_ | Vault AppRole secret id matching `OID4VC_VAULT_ROLE_ID`. |
| `OID4VC_MANAGER_USER_ID` | `VAULT_MANAGER_KEY` (default `manager`) | Vault transit key name for the manager identity. The OID4VC issuer DID is the manager's `did:algo`, so this is also the userId we publish/look up under `DidService`. Override when issuing under a sub-tenant manager key. |

## Storage

Credo persists its own records (issuer, verifier, issuance sessions,
verification sessions, public-key references) inside the **Askar** wallet —
that is required by Credo 0.5.x and cannot be replaced with TypeORM. As of
the Vault-signing change above, **no ed25519 private material is stored in
Askar**: Askar holds public-key handles only and Vault is the sole
custodian of signing keys.

We additionally persist app-level mappings in TypeORM:

* `oid4vc_issuance_session` / `oid4vc_verification_session` — correlate
  Credo session records with Better Auth user ids without having to read
  Credo internals.
* `oid4vc_vault_key_binding` — `publicKeyBase58 → { vaultKeyName, transitPath }`
  used by `VaultAskarWallet` at sign time. Cached in process for the hot
  path, written through on every `vaultSigningRegistry.bind`. Replaces
  the previous in-memory-only map and the boot-time rehydration loop.

## Follow-ups

* Subscribe to Credo `OpenId4VcIssuerEvents`/`OpenId4VcVerifierEvents` and
  mirror the canonical state into the TypeORM session entities (currently
  `state` is captured at offer/request creation time only).
* Enforce auth guards (`AuthGuard`) on the `oid4vc/issuer/*` and
  `oid4vc/verifier/*` controllers once the rewards UX is wired up.
* Re-introduce mdoc (ISO 18013-5) issuance once we wire `#keys-2` into
  the MSO `deviceKeyInfo.deviceKey`. The previous mdoc configuration was
  removed because it advertised `cose_key` binding without that wiring,
  which would have skipped the strict holder binding the SD-JWT VC and
  JWT VC paths now enforce.
* Manager DID rotation tooling: when the manager Vault key is rotated,
  republish the manager `did:algo` document with the new public key and
  invalidate the old `oid4vc_vault_key_binding` row. Ad-hoc today, would
  benefit from a CLI/admin endpoint.
* OID4VP key-binding verification: `Oid4vcVerifierService` accepts
  presentations but does not yet explicitly assert that the SD-JWT
  KB-JWT signature was produced by `<userDid>#keys-2`
  on the resolved DID document. Credo's `SdJwtVcService` honours `cnf`
  during verification, but a defence-in-depth check at the service layer
  is worth adding.
