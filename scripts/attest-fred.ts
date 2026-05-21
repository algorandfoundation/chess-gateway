import 'dotenv/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { base58 } from '@scure/base';

/**
 * End-to-end smoke test for the device-attestation handshake **and**
 * the OID4VCI holder flow that mints the device-attestation SD-JWT VC.
 *
 * Drives the public attestation endpoints exactly the way a wallet
 * would — except the "wallet" is this script, using a hard-coded
 * ed25519 seed for a fictitious user "fred". Steps:
 *
 *   1. Derive fred's ed25519 keypair from a fixed 32-byte seed and
 *      compute the corresponding `did:key` (multicodec ed25519 +
 *      base58 multibase-z).
 *   2. `POST /v1/link/challenge` with fred's `did:key` and
 *      receive a single-use nonce.
 *   3. Sign the nonce bytes with fred's ed25519 private key.
 *   4. `POST /v1/link/response` with the signed nonce and an
 *      opaque device-attestation blob. On success the server mints a
 *      per-user `did:algo` controlled by fred's `did:key` and returns
 *      an OID4VCI credential-offer URI for the
 *      `device-attestation-credential`.
 *   5. Parse the credential-offer URI, fetch the issuer metadata,
 *      exchange the pre-authorized code for an access token + c_nonce
 *      at the OID4VCI token endpoint, build a holder proof JWT signed
 *      with fred's ed25519 key, and POST it to the credential
 *      endpoint to obtain the compact SD-JWT VC.
 *   6. Print all artifacts (`did:key`, `did:algo`, issuance session
 *      id, offer URI, **the SD-JWT VC itself**) and instructions for
 *      pasting the credential into the
 *      `X-Credential-Presentation` Swagger field on
 *      `POST /v1/did/create/transactions`.
 *
 * Env overrides (defaults in parentheses):
 *   API_BASE_URL                 (http://localhost:3000)
 *   FRED_ED25519_SEED_HEX        32-byte hex; defaults to a fixed test seed
 *   FRED_DEVICE_ATTESTATION      string ≥ 16 chars (defaults to a stub blob).
 *                                Set DEVICE_ATTESTATION=disabled on the server
 *                                to bypass the placeholder check.
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Fixed 32-byte seed — gives fred a stable did:key across runs. Do
// NOT use in production: this private key is in source control.
const DEFAULT_FRED_SEED_HEX = '5672656400000000000000000000000000000000000000000000000000000000';

// PKCS8 prefix that wraps a 32-byte ed25519 private-key seed so that
// node's `crypto.createPrivateKey` accepts it without a third-party
// library. Layout per RFC 8410 §7.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Multicodec prefix that identifies an ed25519 public key inside a
// `did:key:z...` identifier.
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

interface FredKeypair {
  seed: Buffer;
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
  // SPKI for ed25519 ends with the 32-byte raw public key.
  const publicKeyRaw = Buffer.from(spki.subarray(spki.length - 32));
  const multibasePayload = Buffer.concat([ED25519_MULTICODEC_PREFIX, publicKeyRaw]);
  const didKey = `did:key:z${base58.encode(multibasePayload)}`;
  return { seed, privateKey, publicKeyRaw, didKey };
}

async function issueChallenge(didKey: string): Promise<{ nonce: string; expiresAt: string }> {
  const url = `${API_BASE_URL}/v1/link/challenge`;
  const response = await axios.post(url, { didKey });
  if (!response.data?.nonce) {
    throw new Error(`attestation challenge did not return a nonce (status=${response.status})`);
  }
  return response.data;
}

async function redeem(input: {
  didKey: string;
  nonce: string;
  signature: string;
  deviceAttestation: string;
}): Promise<{
  didKey: string;
  issuanceSessionId: string;
  credentialOfferUri: string;
}> {
  const url = `${API_BASE_URL}/v1/link/response`;
  const response = await axios.post(url, input);
  if (!response.data?.credentialOfferUri) {
    throw new Error(`attestation redeem did not return a credentialOfferUri (status=${response.status})`);
  }
  return response.data;
}

/**
 * Decoded OID4VCI Credential Offer (Draft 13). Credo emits a URL of
 * the form `openid-credential-offer://?credential_offer_uri=<URL>` —
 * the `credential_offer_uri` is dereferenced to get this JSON.
 */
interface CredentialOfferPayload {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: {
      'pre-authorized_code': string;
      tx_code?: unknown;
    };
  };
}

interface IssuerMetadata {
  credential_issuer: string;
  token_endpoint?: string;
  credential_endpoint: string;
  authorization_servers?: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  c_nonce?: string;
  c_nonce_expires_in?: number;
}

interface CredentialResponse {
  credential?: string;
  credentials?: Array<string | { credential: string }>;
  c_nonce?: string;
  c_nonce_expires_in?: number;
}

const PRE_AUTH_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

/**
 * Resolves an OID4VCI credential-offer URI into its JSON payload.
 * Handles both `credential_offer=<json>` and
 * `credential_offer_uri=<https-url>` parameter shapes.
 */
async function resolveCredentialOffer(offerUri: string): Promise<CredentialOfferPayload> {
  // The URI scheme is wallet-specific (e.g. `openid-credential-offer://`),
  // so we cannot pass it to `new URL()` directly without a base. Pull
  // out the query string manually instead.
  const queryIndex = offerUri.indexOf('?');
  if (queryIndex < 0) {
    throw new Error(`credential-offer URI has no query string: ${offerUri}`);
  }
  const params = new URLSearchParams(offerUri.slice(queryIndex + 1));
  const inline = params.get('credential_offer');
  if (inline) {
    return JSON.parse(inline);
  }
  const uri = params.get('credential_offer_uri');
  if (!uri) {
    throw new Error(`credential-offer URI has neither credential_offer nor credential_offer_uri: ${offerUri}`);
  }
  const response = await axios.get<CredentialOfferPayload>(uri);
  return response.data;
}

async function fetchIssuerMetadata(issuerUrl: string): Promise<IssuerMetadata> {
  const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-credential-issuer`;
  const response = await axios.get<IssuerMetadata>(url);
  return response.data;
}

async function exchangePreAuthorizedCode(tokenEndpoint: string, preAuthCode: string): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set('grant_type', PRE_AUTH_GRANT);
  body.set('pre-authorized_code', preAuthCode);
  const response = await axios.post<TokenResponse>(tokenEndpoint, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });
  if (!response.data?.access_token) {
    throw new Error(`token endpoint did not return an access_token (status=${response.status})`);
  }
  return response.data;
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Builds and signs an OID4VCI holder proof JWT (RFC-flavoured: alg
 * EdDSA, typ `openid4vci-proof+jwt`). The `kid` MUST reference a
 * verification method inside the holder's DID document — for
 * `did:key`, the verification-method id is the DID followed by the
 * `#<multibase-key>` fragment (same multibase value as the method
 * specific id). Credo's `jwkResolver` rejects a bare `did:key` here
 * with "Unable to locate verification method ... in purposes
 * authentication, assertionMethod".
 */
function buildHolderProofJwt(input: {
  didKey: string;
  audience: string;
  nonce: string | undefined;
  privateKey: crypto.KeyObject;
}): string {
  const methodSpecificId = input.didKey.slice('did:key:'.length);
  const verificationMethodId = `${input.didKey}#${methodSpecificId}`;
  const header = {
    alg: 'EdDSA',
    typ: 'openid4vci-proof+jwt',
    kid: verificationMethodId,
  };
  const payload: Record<string, unknown> = {
    aud: input.audience,
    iat: Math.floor(Date.now() / 1000),
  };
  if (input.nonce) payload.nonce = input.nonce;
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), input.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

async function requestCredential(input: {
  credentialEndpoint: string;
  accessToken: string;
  proofJwt: string;
  vct: string;
}): Promise<CredentialResponse> {
  const response = await axios.post<CredentialResponse>(
    input.credentialEndpoint,
    {
      format: 'vc+sd-jwt',
      vct: input.vct,
      proof: { proof_type: 'jwt', jwt: input.proofJwt },
    },
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    },
  );
  return response.data;
}

/**
 * Drives the OID4VCI pre-authorized-code flow end-to-end and returns
 * the compact SD-JWT VC string. `vct` is the credential type the
 * server is expected to mint — defaults to the device-attestation
 * credential.
 */
async function obtainCredential(input: {
  offerUri: string;
  privateKey: crypto.KeyObject;
  didKey: string;
}): Promise<{ compactSdJwtVc: string; vct: string; issuerMetadata: IssuerMetadata }> {
  const offer = await resolveCredentialOffer(input.offerUri);
  const preAuth = offer.grants[PRE_AUTH_GRANT];
  if (!preAuth?.['pre-authorized_code']) {
    throw new Error('credential-offer does not advertise the pre-authorized_code grant');
  }
  const metadata = await fetchIssuerMetadata(offer.credential_issuer);
  // Per OID4VCI Draft 13 the token endpoint may live on a separate
  // authorization server; Credo currently co-hosts both, but resolve
  // it defensively.
  const tokenEndpoint =
    metadata.token_endpoint ??
    `${(metadata.authorization_servers?.[0] ?? metadata.credential_issuer).replace(/\/$/, '')}/token`;
  const token = await exchangePreAuthorizedCode(tokenEndpoint, preAuth['pre-authorized_code']);
  const proofJwt = buildHolderProofJwt({
    didKey: input.didKey,
    audience: offer.credential_issuer,
    nonce: token.c_nonce,
    privateKey: input.privateKey,
  });
  const vct = offer.credential_configuration_ids[0];
  const credentialResponse = await requestCredential({
    credentialEndpoint: metadata.credential_endpoint,
    accessToken: token.access_token,
    proofJwt,
    vct,
  });
  let compact: string | undefined = credentialResponse.credential;
  if (!compact && Array.isArray(credentialResponse.credentials) && credentialResponse.credentials.length > 0) {
    const first = credentialResponse.credentials[0];
    compact = typeof first === 'string' ? first : first?.credential;
  }
  if (!compact) {
    throw new Error(`credential endpoint did not return a credential: ${JSON.stringify(credentialResponse)}`);
  }
  return { compactSdJwtVc: compact, vct, issuerMetadata: metadata };
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

async function main() {
  console.log(`Using API at ${API_BASE_URL}`);
  const fred = loadFredKeypair();
  console.log(`fred did:key: ${fred.didKey}`);
  console.log(`fred public-key (hex): ${fred.publicKeyRaw.toString('hex')}`);

  let challenge: { nonce: string; expiresAt: string };
  try {
    challenge = await issueChallenge(fred.didKey);
  } catch (err) {
    throw new Error(describeAxiosError('Issue attestation challenge', err));
  }
  console.log(`Received challenge nonce (expires ${challenge.expiresAt}): ${challenge.nonce}`);

  // The server verifies an EdDSA signature over the raw UTF-8 bytes
  // of the nonce string — see `LinkService.redeem`.
  const signature = crypto.sign(null, Buffer.from(challenge.nonce, 'utf8'), fred.privateKey);
  const signatureB64 = signature.toString('base64');

  const deviceAttestation =
    process.env.FRED_DEVICE_ATTESTATION ||
    // Opaque placeholder ≥ 16 chars to satisfy the development-mode
    // attestation check in `LinkService.verifyDeviceAttestation`.
    'fred-stub-device-attestation-blob';

  let redeemed: {
    didKey: string;
    issuanceSessionId: string;
    credentialOfferUri: string;
  };
  try {
    redeemed = await redeem({
      didKey: fred.didKey,
      nonce: challenge.nonce,
      signature: signatureB64,
      deviceAttestation,
    });
  } catch (err) {
    throw new Error(describeAxiosError('Redeem attestation challenge', err));
  }

  console.log('\n✔ Attestation redeem succeeded (no on-chain ops — the wallet creates its own contract via /did/create/*):');
  console.log(JSON.stringify(redeemed, null, 2));

  console.log('\nDriving OID4VCI pre-authorized-code flow against the credential-offer URI…');
  let credential: { compactSdJwtVc: string; vct: string; issuerMetadata: IssuerMetadata };
  try {
    credential = await obtainCredential({
      offerUri: redeemed.credentialOfferUri,
      privateKey: fred.privateKey,
      didKey: fred.didKey,
    });
  } catch (err) {
    throw new Error(describeAxiosError('Obtain SD-JWT VC via OID4VCI', err));
  }

  console.log(`\n✔ Issued ${credential.vct} (issuer ${credential.issuerMetadata.credential_issuer}):`);
  console.log(`\nSD-JWT VC (compact, paste into x-credential-presentation):\n`);
  console.log(credential.compactSdJwtVc);

  console.log('\nNext steps — exercise the credential-gated DID route in Swagger UI:');
  console.log(`  1. Open ${API_BASE_URL.replace(/\/$/, '')}/docs and locate "POST /v1/did/create/transactions".`);
  console.log(`  2. Click "Authorize", paste the SD-JWT VC above into the`);
  console.log(`     "x-credential-presentation" apiKey field, then invoke the route.`);
  console.log(`     The host will verify the credential, extract fred's did:key from cnf.kid,`);
  console.log(`     and build the unsigned (+ host-pre-signed MBR) transactions for fred to sign.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
