/**
 * Builders for W3C-compatible DID documents that follow the
 * conventions used by the `did:algo` method specification.
 *
 * The document published for every user in the vault references
 * the user's ed25519 public key as an `Ed25519VerificationKey2020`
 * verification method and lists it under `authentication`.
 */
import { Address } from '@algorandfoundation/algokit-utils';

export interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

export interface DidDocument {
  '@context': (string | Record<string, unknown>)[];
  id: string;
  verificationMethod: DidVerificationMethod[];
  authentication: string[];
  assertionMethod?: string[];
  /**
   * Other identifiers this DID subject is known by. We use this to
   * surface a user's externally-linked Algorand wallet (added via the
   * link verification service) as a CAIP-10 account URI:
   * `algorand:<genesis-hash-prefix>:<address>` — but for simplicity we
   * publish it as `algorand:<address>` since the network segment is
   * already encoded in the DID itself.
   */
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Encode a 32-byte ed25519 public key as a multibase ed25519 multicodec
 * (base58btc, prefixed with `z`), as required by the
 * `Ed25519VerificationKey2020` data integrity suite.
 */
export function encodePublicKeyMultibase(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return 'z' + base58btcEncode(prefixed);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58btc encoder — no third-party dependency required. */
function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // big-endian to base58
  const input = Array.from(bytes);
  const encoded: number[] = [];
  let start = zeros;
  while (start < input.length) {
    let carry = 0;
    for (let i = start; i < input.length; i++) {
      const v = (input[i] & 0xff) + carry * 256;
      input[i] = Math.floor(v / 58);
      carry = v % 58;
    }
    encoded.push(carry);
    while (start < input.length && input[start] === 0) start++;
  }

  let out = '';
  for (let i = 0; i < zeros; i++) out += BASE58_ALPHABET[0];
  for (let i = encoded.length - 1; i >= 0; i--) out += BASE58_ALPHABET[encoded[i]];
  return out;
}

export interface BuildDocumentParams {
  did: string;
  publicKey: Uint8Array;
  /**
   * Optional Algorand address the user has externally linked via the
   * link verification service. When supplied, it is published in the
   * DID document under `alsoKnownAs` as `algorand:<address>` so
   * resolvers can correlate the DID with the user's on-chain wallet.
   */
  linkedWalletAddress?: string | null;
}

/**
 * Build a minimal DID document that uses the supplied ed25519 public key
 * as both an authentication and assertion method. When the user has a
 * linked Algorand wallet (from the link verification service), it is
 * surfaced in `alsoKnownAs` as a CAIP-style `algorand:<address>` URI.
 */
export function buildDidDocument({ did, publicKey, linkedWalletAddress }: BuildDocumentParams): DidDocument {
  const keyId = `${did}#keys-1`;
  const doc: DidDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: encodePublicKeyMultibase(publicKey),
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
  };
  if (linkedWalletAddress) {
    // The linked Algorand account is itself an ed25519 public key, so
    // expose it as a second verification method (and authentication /
    // assertion method) in addition to surfacing it via `alsoKnownAs`.
    const linkedKeyId = `${did}#keys-2`;
    const linkedPublicKey = Address.fromString(linkedWalletAddress).publicKey;
    doc.verificationMethod.push({
      id: linkedKeyId,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyMultibase: encodePublicKeyMultibase(linkedPublicKey),
    });
    doc.authentication.push(linkedKeyId);
    doc.assertionMethod = [...(doc.assertionMethod ?? []), linkedKeyId];
    doc.alsoKnownAs = [`algorand:${linkedWalletAddress}`];
  }
  return doc;
}
