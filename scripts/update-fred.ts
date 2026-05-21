import 'dotenv/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { base58 } from '@scure/base';
import {
  decodeTransaction,
  encodeTransaction,
  encodeSignedTransaction,
  type SignedTransaction,
} from '@algorandfoundation/algokit-utils/transact';

/**
 * End-to-end smoke test for the wallet-owned per-user did:algo
 * lifecycle: contract create → document update.
 *
 * Usage:
 *
 *   yarn api:test:update-fred [<sd-jwt-vc>]
 *
 * If a device-attestation SD-JWT VC is passed as the first
 * positional argument, the script uses it verbatim. Otherwise the
 * script drives the full attestation + OID4VCI handshake itself to
 * obtain a fresh credential (same path as `attest-fred`).
 *
 * With the credential in hand the script then:
 *
 *   1. Calls `POST /v1/did/create/transactions` (credential-gated).
 *      The server returns a single 3-txn atomic group:
 *      `[manager-funder pay, manager pay → user, user appCreate]`,
 *      with `indexesToSign = [2]`. The script signs position 2 with
 *      fred's ed25519 key and POSTs the wallet-signed group to
 *      `POST /v1/did/create/submit`. On confirmation the server
 *      reads the new app id from the create-app confirmation,
 *      persists it to Vault KV, and returns `{ appId, did, ... }`.
 *      If the contract already exists (409 Conflict) the script
 *      skips this step.
 *   2. Builds fred's canonical wallet-owned DID document, appends a
 *      mock `service` entry, and POSTs it to `POST /v1/did/update/transactions`.
 *      The server returns a flat list of atomic groups in which
 *      every app-call is sender=fred and every `pay` is sender=manager.
 *      `indexesToSign` lists fred's positions.
 *   3. Signs each `indexesToSign` position by decoding the canonical
 *      txn bytes, ed25519-signing them with fred's key, wrapping in
 *      `SignedTransaction` and re-encoding. Posts the signed groups
 *      to `POST /v1/did/update/submit` together
 *      with the same `document` payload — the server rebuilds the
 *      canonical groups from the document and validates the signed
 *      bytes byte-for-byte before committing its own manager
 *      signatures.
 *
 * Env overrides (defaults in parentheses):
 *   API_BASE_URL                 (http://localhost:3000)
 *   FRED_ED25519_SEED_HEX        32-byte hex; defaults to the fixed
 *                                test seed used by `attest-fred`.
 *   FRED_DEVICE_ATTESTATION      opaque blob ≥ 16 chars (defaults to
 *                                a stub). Set DEVICE_ATTESTATION=disabled
 *                                on the server to bypass the placeholder
 *                                check.
 *   FRED_SERVICE_ID              service entry id (defaults to a
 *                                stable mock value).
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Same fixed test seed as `attest-fred` — keeps fred's did:key stable
// across runs. Do NOT use in production: this private key is in
// source control.
const DEFAULT_FRED_SEED_HEX = '5672656400000000000000000000000000000000000000000000000000000000';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);
const PRE_AUTH_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

interface FredKeypair {
  privateKey: crypto.KeyObject;
  publicKeyRaw: Buffer;
  didKey: string;
}

function loadFredKeypair(): FredKeypair {
  const hex = (process.env.FRED_ED25519_SEED_HEX || DEFAULT_FRED_SEED_HEX).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('FRED_ED25519_SEED_HEX must be 32 bytes hex-encoded (64 hex chars)');
  }
  const seed = Buffer.from(hex, 'hex');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKeyRaw = Buffer.from(spki.subarray(spki.length - 32));
  const multibasePayload = Buffer.concat([ED25519_MULTICODEC_PREFIX, publicKeyRaw]);
  const didKey = `did:key:z${base58.encode(multibasePayload)}`;
  return { privateKey, publicKeyRaw, didKey };
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function describeAxiosError(label: string, err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    const body = typeof data === 'object' ? JSON.stringify(data) : String(data ?? '');
    return `${label} failed (status=${status ?? 'n/a'}): ${err.message}${body ? ` body=${body}` : ''}`;
  }
  return `${label} failed: ${(err as Error)?.message ?? String(err)}`;
}

// ───────────────────────────── Attestation + OID4VCI ─────────────────────────────

interface CredentialOfferPayload {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: {
      'pre-authorized_code': string;
    };
  };
}

interface IssuerMetadata {
  credential_issuer: string;
  token_endpoint?: string;
  credential_endpoint: string;
  authorization_servers?: string[];
}

async function obtainCredential(fred: FredKeypair): Promise<string> {
  // 1. Challenge.
  const challenge = await axios
    .post<{ nonce: string; expiresAt: string }>(`${API_BASE_URL}/v1/link/challenge`, { didKey: fred.didKey })
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('Issue attestation challenge', err));
    });

  // 2. Sign nonce, redeem.
  const signature = crypto.sign(null, Buffer.from(challenge.nonce, 'utf8'), fred.privateKey).toString('base64');
  const redeemed = await axios
    .post<{ credentialOfferUri: string }>(`${API_BASE_URL}/v1/link/response`, {
      didKey: fred.didKey,
      nonce: challenge.nonce,
      signature,
      deviceAttestation: process.env.FRED_DEVICE_ATTESTATION || 'fred-stub-device-attestation-blob',
    })
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('Redeem attestation challenge', err));
    });

  // 3. OID4VCI pre-auth flow.
  const offer = await resolveCredentialOffer(redeemed.credentialOfferUri);
  const meta = await axios
    .get<IssuerMetadata>(`${offer.credential_issuer.replace(/\/$/, '')}/.well-known/openid-credential-issuer`)
    .then((r) => r.data);
  const tokenEndpoint =
    meta.token_endpoint ?? `${(meta.authorization_servers?.[0] ?? meta.credential_issuer).replace(/\/$/, '')}/token`;
  const preAuthCode = offer.grants[PRE_AUTH_GRANT]?.['pre-authorized_code'];
  if (!preAuthCode) throw new Error('credential-offer is missing the pre-authorized_code grant');

  const tokenBody = new URLSearchParams();
  tokenBody.set('grant_type', PRE_AUTH_GRANT);
  tokenBody.set('pre-authorized_code', preAuthCode);
  const token = await axios
    .post<{ access_token: string; c_nonce?: string }>(tokenEndpoint, tokenBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    })
    .then((r) => r.data);

  const proof = buildHolderProofJwt({
    didKey: fred.didKey,
    audience: offer.credential_issuer,
    nonce: token.c_nonce,
    privateKey: fred.privateKey,
  });
  const vct = offer.credential_configuration_ids[0];
  const credentialResp = await axios
    .post<{ credential?: string; credentials?: Array<string | { credential: string }> }>(
      meta.credential_endpoint,
      { format: 'vc+sd-jwt', vct, proof: { proof_type: 'jwt', jwt: proof } },
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    )
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('Obtain SD-JWT VC via OID4VCI', err));
    });

  let compact: string | undefined = credentialResp.credential;
  if (!compact && Array.isArray(credentialResp.credentials) && credentialResp.credentials.length > 0) {
    const first = credentialResp.credentials[0];
    compact = typeof first === 'string' ? first : first?.credential;
  }
  if (!compact) throw new Error('credential endpoint did not return a credential');
  return compact;
}

async function resolveCredentialOffer(offerUri: string): Promise<CredentialOfferPayload> {
  const queryIndex = offerUri.indexOf('?');
  if (queryIndex < 0) throw new Error(`credential-offer URI has no query string: ${offerUri}`);
  const params = new URLSearchParams(offerUri.slice(queryIndex + 1));
  const inline = params.get('credential_offer');
  if (inline) return JSON.parse(inline);
  const uri = params.get('credential_offer_uri');
  if (!uri) throw new Error(`credential-offer URI is missing both inline and uri forms`);
  return (await axios.get<CredentialOfferPayload>(uri)).data;
}

function buildHolderProofJwt(input: {
  didKey: string;
  audience: string;
  nonce: string | undefined;
  privateKey: crypto.KeyObject;
}): string {
  // For did:key, the verification-method id is the DID followed by
  // `#<method-specific-id>` — i.e. the multibase value right after
  // `did:key:`. Credo's `jwkResolver` rejects a bare DID with
  // `didUrl '...' does not contain a '#'`.
  const methodSpecific = input.didKey.replace(/^did:key:/, '');
  const kid = `${input.didKey}#${methodSpecific}`;
  const header = { alg: 'EdDSA', typ: 'openid4vci-proof+jwt', kid };
  const payload: Record<string, unknown> = {
    aud: input.audience,
    iat: Math.floor(Date.now() / 1000),
  };
  if (input.nonce) payload.nonce = input.nonce;
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), input.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

// ───────────────────────── DID create + update ────────────────────────────

interface UnsignedGroup {
  groupIdB64: string;
  txnGroup: string[];
  indexesToSign: number[];
  signers: ('manager' | 'user')[];
  kinds: string[];
}

interface UserContractCreatePlan {
  didKey: string;
  managerAddress: string;
  userAddress: string;
  group: UnsignedGroup;
}

interface UserDidUpdatePlan {
  did: string;
  didKey: string;
  appId: string;
  appAddress: string;
  managerAddress: string;
  userAddress: string;
  oldMbrMicroAlgos: string;
  newMbrMicroAlgos: string;
  groups: UnsignedGroup[];
  document: object;
}

/**
 * Sign every position listed in `indexesToSign` with fred's ed25519
 * key, returning the wallet-connect-style `(string | null)[]` array
 * (base64-encoded `SignedTransaction` at signed positions, `null`
 * elsewhere). Canonical ed25519 over the msgpack-encoded txn bytes
 * via `encodeTransaction`, exactly what algod expects.
 */
function signGroupForUser(group: UnsignedGroup, fred: FredKeypair): (string | null)[] {
  const out: (string | null)[] = new Array(group.txnGroup.length).fill(null);
  for (const i of group.indexesToSign) {
    const unsigned = Buffer.from(group.txnGroup[i], 'base64');
    const txn = decodeTransaction(new Uint8Array(unsigned));
    const sig = new Uint8Array(crypto.sign(null, Buffer.from(encodeTransaction(txn)), fred.privateKey));
    const signed: SignedTransaction = { txn, sig };
    out[i] = Buffer.from(encodeSignedTransaction(signed)).toString('base64');
  }
  return out;
}

async function createContractIfNeeded(
  fred: FredKeypair,
  credential: string,
): Promise<{ appId: string; did: string; appAddress: string } | { skipped: true }> {
  let plan: UserContractCreatePlan;
  try {
    plan = (
      await axios.post<UserContractCreatePlan>(
        `${API_BASE_URL}/v1/did/create/transactions`,
        {},
        { headers: { 'X-Credential-Presentation': credential } },
      )
    ).data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      console.log('  contract already deployed for fred — skipping create.');
      return { skipped: true };
    }
    throw new Error(describeAxiosError('POST /v1/did/create/transactions', err));
  }
  console.log(`  build: indexesToSign=${JSON.stringify(plan.group.indexesToSign)} kinds=${JSON.stringify(plan.group.kinds)}`);

  const signedTxns = signGroupForUser(plan.group, fred);

  const submitted = await axios
    .post<{ appId: string; appAddress: string; did: string; txId: string }>(
      `${API_BASE_URL}/v1/did/create/submit`,
      { signedTxns },
      { headers: { 'X-Credential-Presentation': credential } },
    )
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('POST /v1/did/create/submit', err));
    });
  console.log(`  submit: txId=${submitted.txId} appId=${submitted.appId} did=${submitted.did}`);
  return submitted;
}

async function updateDocument(fred: FredKeypair, credential: string): Promise<{ txIds: string[]; document: object }> {
  // First build with no document override to find out fred's current
  // canonical document + the canonical `did:algo` id, then augment
  // and re-build with the augmented payload.
  const probe = await axios
    .post<UserDidUpdatePlan>(
      `${API_BASE_URL}/v1/did/update/transactions`,
      {},
      { headers: { 'X-Credential-Presentation': credential } },
    )
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('POST /v1/did/update/transactions (probe)', err));
    });

  const baseDoc = probe.document as Record<string, unknown> & { service?: unknown[]; id: string };
  const serviceId = process.env.FRED_SERVICE_ID || `${baseDoc.id}#linked-domain-1`;
  const newDoc = {
    ...baseDoc,
    service: [
      ...(Array.isArray(baseDoc.service) ? baseDoc.service : []),
      {
        id: serviceId,
        type: 'LinkedDomains',
        serviceEndpoint: 'https://fred.example.test',
      },
    ],
  };

  const plan = await axios
    .post<UserDidUpdatePlan>(
      `${API_BASE_URL}/v1/did/update/transactions`,
      { document: newDoc },
      { headers: { 'X-Credential-Presentation': credential } },
    )
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('POST /v1/did/update/transactions', err));
    });
  console.log(
    `  build: did=${plan.did} appId=${plan.appId} groups=${plan.groups.length} ` +
      `oldMbr=${plan.oldMbrMicroAlgos}µAlgo newMbr=${plan.newMbrMicroAlgos}µAlgo`,
  );

  const signedGroups = plan.groups.map((g) => ({ signedTxns: signGroupForUser(g, fred) }));

  const submitted = await axios
    .post<{ txIds: string[] }>(
      `${API_BASE_URL}/v1/did/update/submit`,
      { document: newDoc, groups: signedGroups },
      { headers: { 'X-Credential-Presentation': credential } },
    )
    .then((r) => r.data)
    .catch((err) => {
      throw new Error(describeAxiosError('POST /v1/did/update/submit', err));
    });

  return { txIds: submitted.txIds, document: newDoc };
}

async function main() {
  console.log(`Using API at ${API_BASE_URL}`);
  const fred = loadFredKeypair();
  console.log(`fred did:key: ${fred.didKey}`);

  // ── 1. Obtain credential (argv or full attestation flow) ─────────────
  const credentialArg = process.argv[2];
  let credential: string;
  if (credentialArg && credentialArg.split('.').length >= 3) {
    console.log('Using SD-JWT VC supplied via argv[1].');
    credential = credentialArg;
  } else {
    console.log('No credential argv — driving attestation + OID4VCI flow to mint one.');
    credential = await obtainCredential(fred);
    console.log('Obtained SD-JWT VC:');
    console.log(credential);
  }

  // ── 2. Deploy per-user contract (if not yet deployed) ────────────────
  console.log('\n── POST /v1/did/create/{transactions,submit} ──');
  const createResult = await createContractIfNeeded(fred, credential);
  if ('skipped' in createResult) {
    console.log('  (contract already exists — proceeding to update)');
  } else {
    console.log(`✔ contract deployed: did=${createResult.did} appId=${createResult.appId}`);
  }

  // ── 3. Update document with a mock service[] entry ───────────────────
  console.log('\n── POST /v1/did/update/{transactions,submit} ──');
  const { txIds, document } = await updateDocument(fred, credential);
  console.log(`✔ broadcast complete: txIds=${JSON.stringify(txIds)}`);
  console.log('\n✔ Updated DID document:');
  console.log(JSON.stringify(document, null, 2));
}

main().catch((err) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
