# OID4VC — Wallet Device Manifest (Discovery)

This document captures the design we converged on for leveraging the
self-custody wallet's `did:key` document on the OID4VC backend. It is the
companion to `README.md`, which documents what is *built* today; this
file documents what we are *building toward*.

## Context

The chess-passport wallet generates a `did:key` per primary identity
(see `chess-passport/extensions/identities/did-document.ts`). That
document is far richer than a minimal `did:key`:

* a primary `Ed25519VerificationKey2020` (the `did:key`'s own key)
* additional verification methods for HD-derived account keys
  (`hd-derived-ed25519`) and P-256 keys (`hd-derived-p256`,
  `xhd-derived-p256`), each carrying derivation-path metadata
  (`context`, `account`, `index`, `derivation`, `origin`, `userHandle`,
  `counter`, `type`)
* a `PasskeyService` listing per-passkey `{ id, keyId, origin,
  userHandle, count }`
* a `WebRTCICECredentials` service entry

Because the device is attested via App Attest / Play Integrity during
the link-account flow, the backend can treat this document as a trusted
"keystore manifest" for that user — not as an anonymous `did:key`.

The strict "no `did:key` issuer" rule still stands. This work is about
the *holder* side only.

## Goal

Mirror the wallet's `did:key` document on the backend as a per-user
**device manifest**, kept in sync via a signed full-document push, and
use it as the source of truth for:

1. holder binding (per-device, per-subkey, per-passkey)
2. richer credential subjects (derivation provenance, passkey metadata)
3. soft revocation of credentials when the user rotates a key on device

## Storage model

Two tables, append-only on revisions:

```
oid4vc_user_device_manifest
  id                    uuid pk
  user_id               text       (Better Auth user id)
  did_key               text uniq  (the wallet's primary did:key)
  current_revision_id   uuid fk -> revision (nullable while bootstrapping)
  trusted_at            timestamp  (when link-attestation accepted this did:key)
  revoked_at            timestamp null
  created_at, updated_at

oid4vc_user_device_manifest_revision
  id            uuid pk
  manifest_id   uuid fk
  version       int
  document      simple-json     (the full DID Document as the wallet sent it)
  signature     text (base64)   (Ed25519 over JCS(canonical payload))
  signed_at     timestamp        (wall-clock from the wallet)
  received_at   timestamp        (server clock)
  unique (manifest_id, version)
```

A revision is **never** mutated. The `current_revision_id` pointer is
the only thing that moves.

## Wire format

Wallet POSTs the full manifest; the backend never trusts the
transport, only the signature.

```
POST /v1/oid4vc/devices/manifest
Body:
{
  "didKey":      "did:key:z6Mk...",
  "version":      7,
  "signedAt":    "2026-05-06T18:30:00Z",
  "didDocument": { ... full DIDDocument ... },
  "signature":   "<base64 ed25519 sig>"
}
```

The signature is computed over the JCS canonicalisation
(RFC 8785-style: recursive sort by key, no whitespace) of:

```
{ didKey, version, signedAt, didDocument }
```

…using the **primary verification method** of `didDocument` (the one
whose id matches the `did:key` itself, i.e. the Ed25519 multibase key
the `did:key` is derived from).

## Backend acceptance rules

On every upload the service:

1. Resolves the primary verification method from the supplied
   `didDocument` (the one with `id === didKey` or
   `id === didKey + '#…'` and a multibase Ed25519 key).
2. Re-derives the expected `did:key` from that public key and confirms
   it matches the supplied `didKey` (anti-confused-deputy).
3. Canonicalises the payload and verifies the Ed25519 signature using
   Node's native `crypto.verify('ed25519', …)`.
4. Looks up the manifest by `(userId, didKey)`. If absent, creates one
   *only* if the call comes from the link-attestation seed path
   (otherwise rejects: an unattested device cannot create its own
   manifest).
5. Enforces monotonicity: `version > currentRevision.version`.
   Equal versions are no-ops; lower versions return `409 Conflict`
   carrying the current version so the wallet can re-sign.
6. Inserts a new revision, updates `current_revision_id`, returns the
   new revision id + version.

## Sync model

* **Tier 1 (implemented in this iteration)** — full signed manifest
  push on any structural change in the wallet (verification methods or
  passkeys added/removed/replaced). The wallet's
  `processUpdates` callback in `extensions/identities-keystore/extension.ts`
  is the natural client-side hook.
* **Tier 2 (deferred)** — passkey-counter delta PATCHes. Counters are
  not load-bearing for OID4VC binding; revisit when a credential type
  needs counter freshness as a claim.
* **Tier 3 (deferred — see TODO)** — pre-issuance freshness check.
  Wallet attaches the current manifest signature in the credential
  request; issuer rejects if stale or differs from the stored
  revision. This is the natural sync point and removes the need for
  any background sync timer. **Not built yet.**
* **Periodic safety-net** — wallet does a `GET /v1/oid4vc/devices/manifest/:didKey`,
  compares the returned `version`, and re-pushes if out of sync. Cheap
  to implement on the wallet side once the GET endpoint exists.

## First-attestation seeding

The link-account flow (`POST /v1/link/response`) is extended to accept
an optional `didDocument` + `manifestSignature` + `manifestSignedAt` +
`manifestVersion` + `didKey` payload. When supplied and integrity
verification has passed, `LinkService` calls
`DeviceManifestService.upsertManifest({ trustedSeed: true, … })` so
the manifest is created in the same call that attests the device. This
is the *only* code path that may create a manifest row; subsequent
updates require the manifest to already exist (i.e. the device has
been attested).

## Trust gating on OID4VC flows (later)

Once manifests are persisted:

* `Oid4vcIssuerService.buildCredentialMapper` will accept holder
  bindings whose `kid` resolves to a verification method of a
  *currently-trusted, non-revoked* manifest for the offer's `userId`,
  in addition to the existing `did:algo:<userId>#keys-2` rule.
* The mapping `(credential_id → manifest_id, revision_id_at_issue,
  subkey_id)` is persisted on the issuance session so the verifier can
  later answer "is the binding key still in the user's current
  manifest?" — a soft-revocation surface.

## Hybrid `did:algo` integration

The manifest table is the source of truth for *metadata* (derivation
paths, passkey origins, `userHandle`, counters, ICE config) — none of
which belongs on chain. But every accepted revision is **anchored** on
the user's `did:algo` document so the backend can never silently drift
from the wallet's truth, and every wallet-managed *public key* is
**promoted** to a first-class on-chain verification method so credential
binding and verification can rely solely on `did:algo` resolution.

Concretely, after `DeviceManifestService.upsertManifest` commits a new
revision (and only when a new revision is actually appended — idempotent
re-uploads do not re-publish) it calls
`DidService.republishForManifest(userId, vaultToken, { manifestAnchor,
promotedKeys })`. The chain write is best-effort: if it fails (algod
unreachable, AppRole revoked, etc.) the revision still stands and the
warning is logged; the next push will re-attempt.

* **Manifest anchor.** Service entry on the on-chain DID document:

  ```
  {
    id: "did:algo:<USER>#manifest",
    type: "DeviceManifestAnchor",
    serviceEndpoint: { hash: "sha256:<hex>", version: <int> }
  }
  ```

  `hash` is the SHA-256 of `canonicaliseJson({ didKey, version, signedAt,
  didDocument })` — i.e. the same canonical payload the wallet's
  Ed25519 signature already covers. Verifiers re-canonicalise the
  manifest copy they're given off chain and compare against this hash.

* **Promoted keys.** Every additional verification method in the
  wallet's `did:key` document (anything except `#keys-1`) is added to
  the on-chain DID document as its own `verificationMethod`,
  `authentication` and `assertionMethod` entry. Ed25519 keys land as
  `Ed25519VerificationKey2020` (multibase `0xed01…`); P-256 keys land
  as `JsonWebKey2020` (multibase `0x8024…` per the multicodec table).
  The fragment id from the wallet (`#account-0`, `#passkey-…`, etc.)
  is preserved so holder bindings stay stable across re-publications.

* **What stays off chain.** Per-key metadata (`account`, `index`,
  `derivation`, `origin`, `userHandle`, `counter`, `type`), the
  `WebRTCICECredentials` service, and the entire revision history. The
  promoted on-chain entries carry only `{ id, type, controller,
  publicKeyMultibase }` — pure crypto, no provenance leak.

When the OID4VC AppRole is not configured (`OID4VC_VAULT_ROLE_ID` /
`OID4VC_VAULT_SECRET_ID` unset), the anchor publish is a logged no-op.
The manifest revision is still accepted; it simply isn't reflected on
chain until the AppRole is wired up.

## Wallet-side OID4VCI (chess-passport `extensions/credentials`)

The wallet does not run a Credo holder agent (see `bifold-wallet/`
discussion in chat history — adopting `@bifold/core` would force
Askar React Native + Indy VDR + AnonCreds into the wallet alongside our
existing keystore, and bifold's per-credential `did:key`/`did:jwk`
binding model conflicts with our strict `#keys-2` rule). Instead the
wallet ships a hand-rolled OID4VCI client in
`chess-passport/extensions/credentials/oid4vci.ts` that:

* parses `openid-credential-offer://` URIs and resolves the issuer
  metadata document (display + endpoints in one call),
* runs the pre-authorized-code grant against the issuer's token
  endpoint,
* builds an OpenID4VCI **proof JWT** (`typ: openid4vci-proof+jwt`,
  `alg: EdDSA`, `kid: did:algo:<address>#keys-2`) signed by the
  device's primary HD-derived ed25519 key (`provider.key.store.sign`),
  and includes it in the credential request — satisfying the
  backend mapper's strict `#keys-2` holder-binding rule,
* decodes the returned credential via `@sd-jwt/decode` for SD-JWT VCs
  (the same library bifold uses, transitively, through Credo) and a
  bare base64url read for JWT VCs,
* persists the issuer's display metadata (`name`, `logoUri`, `domain`)
  on the credential record so the credentials list renders without
  refetching `.well-known/openid-credential-issuer`.

When the wallet has no provisioned identity yet (`identities[0]` is
absent), the proof JWT is **omitted** and the credential request goes
out unbound — issuers that enforce `#keys-2` (i.e. ours) will reject
it; the demo flow logs the failure rather than silently downgrading.

## TODOs

* **Tier 3 — pre-issuance freshness check**: require the wallet to
  attach a fresh signed manifest in the OID4VCI credential request and
  reject mismatches. Right now the issuer is decoupled from the
  manifest; this is the natural place to wire them together. With the
  hybrid anchor in place, the issuer can additionally verify the
  attached manifest's hash against the on-chain
  `DeviceManifestAnchor` service entry. The wallet's OID4VCI client
  already has the proof-JWT plumbing in place; adding `manifest_signature`
  + `manifest_version` fields to the credential request body is the
  remaining work.
* **Subkey-level binding in mapper**: extend the mapper to honour
  `kid` values pointing at promoted verification methods on the
  on-chain document (passkeys included). Needs ES256 support in the
  issuer's signature verification path.
* **Soft revocation on verification**: when a credential is presented,
  resolve its issuance-time `(manifest_id, subkey_id)` and reject if
  the subkey is no longer in the *current* revision (and therefore no
  longer present as a verification method on the resolved `did:algo`
  document).
* **`alsoKnownAs` injection**: on link-attestation success,
  `DidService.publishUserDid` should add `did:key:<wallet>` to
  `alsoKnownAs` on the on-chain `did:algo` document so external
  resolvers see the device DID directly.
* **Counter sync (Tier 2)**: revisit only if a credential needs
  counter freshness.
* **Conflict UX**: when the wallet receives `409 Conflict`, document
  the expected merge behaviour (re-sign with `version =
  max(local, remote) + 1`).
* **Anchor retry queue**: today an anchor failure is logged and the
  next manifest push is the recovery path. For users whose wallets
  rarely push, a periodic reconciler that re-runs `republishForManifest`
  for manifests whose `currentRevision.version` does not match the
  on-chain anchor would close the gap.
