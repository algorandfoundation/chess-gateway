import { Logger } from '@nestjs/common';
import type { AgentContext } from '@credo-ts/core';
import { DidDocument as CredoDidDocument, VerificationMethod as CredoVerificationMethod } from '@credo-ts/core';
import type { DidResolutionResult, DidResolver, ParsedDid } from '@credo-ts/core';

import { DidService } from '../../did/did.service';
import { buildDidDocument, encodePublicKeyMultibase } from '../../did/did-document';

/**
 * Regex describing the canonical `did:algo` identifier shape used by this
 * platform: `did:algo:<network>:app:<app-id>:<hex-pubkey>`. The DID is
 * self-describing — the public key is encoded directly in the identifier —
 * which lets the resolver rebuild the verification material without a
 * round-trip to chain. The chain box is only consulted when the caller
 * passes `useOnChain: true` so that resolution stays cheap during JWT
 * verification on the verifier side.
 */
const DID_ALGO_PATTERN = /^did:algo:([^:]+):app:(\d+):([0-9a-f]{64})$/i;

/**
 * Credo `DidResolver` for the `did:algo` method that the platform uses for
 * its on-chain user DIDs.
 *
 * The resolver does **not** sign or mutate any state; it only translates the
 * identifier into a `DidDocument` Credo can use to look up verification
 * methods (e.g. when verifying a credential / JWT issued by a `did:algo`
 * subject).
 *
 * Resolution strategy:
 *   1. **Local cache** — if {@link DidService.resolveLocal} returns a row,
 *      we trust the cached document (fast path; consistent with the rest of
 *      the codebase, where the local row is the authoritative read source
 *      for users we have published).
 *   2. **Self-described identifier** — otherwise, the public key is
 *      extracted from the DID itself and the W3C document is rebuilt with
 *      {@link buildDidDocument}. This is sufficient for verifiers that just
 *      need the verification key.
 */
export class AlgoDidResolver implements DidResolver {
  private readonly logger = new Logger(AlgoDidResolver.name);
  readonly supportedMethods = ['algo'];
  readonly allowsCaching = true;
  readonly allowsLocalDidRecord = true;

  constructor(private readonly didService: DidService) {}

  async resolve(_agentContext: AgentContext, did: string, _parsed: ParsedDid): Promise<DidResolutionResult> {
    try {
      const match = DID_ALGO_PATTERN.exec(did);
      if (!match) {
        return this.failure(`Unable to parse did:algo identifier: ${did}`, 'invalidDid');
      }
      const [, , , hex] = match;
      const publicKey = Uint8Array.from(Buffer.from(hex, 'hex'));

      // Prefer a locally cached document so we honour any updates (linked
      // wallets, services) that may have been added since the bare DID was
      // first published. We look up by DID rather than user_id so unknown
      // (e.g. cross-tenant) identifiers still resolve via the self-described
      // fallback below.
      const records = await this.didService.listRecords();
      const localRecord = records.find((r) => r.did === did);
      if (localRecord?.document) {
        try {
          const parsed = JSON.parse(localRecord.document) as Record<string, unknown>;
          return this.success(toCredoDocument(parsed, did));
        } catch (err) {
          this.logger.warn(
            `Local did:algo record for ${did} has malformed document, falling back to self-described resolution: ${
              (err as Error).message
            }`,
          );
        }
      }

      const fallback = buildDidDocument({ did, publicKey });
      return this.success(toCredoDocument(fallback as unknown as Record<string, unknown>, did));
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Failed to resolve ${did}: ${message}`);
      return this.failure(message, 'notFound');
    }
  }

  private success(didDocument: CredoDidDocument): DidResolutionResult {
    return {
      didResolutionMetadata: { contentType: 'application/did+ld+json' },
      didDocument,
      didDocumentMetadata: {},
    };
  }

  private failure(
    message: string,
    error: 'invalidDid' | 'notFound' | 'representationNotSupported',
  ): DidResolutionResult {
    return {
      didResolutionMetadata: { error, message },
      didDocument: null,
      didDocumentMetadata: {},
    };
  }
}

/**
 * Convert the project's plain-object DID document representation to a
 * Credo `DidDocument` instance. Unknown verification-material fields are
 * dropped silently — the resolver only promises to surface the canonical
 * ed25519 verification methods that we publish.
 */
function toCredoDocument(raw: Record<string, unknown>, did: string): CredoDidDocument {
  const verificationMethod = (raw.verificationMethod as Array<Record<string, unknown>> | undefined)?.map((vm) => {
    return new CredoVerificationMethod({
      id: vm.id as string,
      type: (vm.type as string) ?? 'Ed25519VerificationKey2020',
      controller: (vm.controller as string) ?? did,
      publicKeyMultibase: vm.publicKeyMultibase as string | undefined,
      publicKeyBase58: vm.publicKeyBase58 as string | undefined,
      publicKeyJwk: vm.publicKeyJwk as never,
      publicKeyHex: vm.publicKeyHex as string | undefined,
    });
  });

  return new CredoDidDocument({
    context: (raw['@context'] as string | string[]) ?? ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod,
    authentication: (raw.authentication as Array<string>) ?? undefined,
    assertionMethod: (raw.assertionMethod as Array<string>) ?? undefined,
    alsoKnownAs: raw.alsoKnownAs as string[] | undefined,
  });
}

/**
 * Helper used by the registrar / issuer bootstrap to build a freshly
 * constructed Credo `DidDocument` from raw key material without touching
 * the resolver's caching path. Re-exported so tests can pin the document
 * shape independently from the on-chain state.
 */
export function buildCredoDidDocumentFromKey(did: string, publicKey: Uint8Array): CredoDidDocument {
  const keyId = `${did}#keys-1`;
  const verificationMethod = new CredoVerificationMethod({
    id: keyId,
    type: 'Ed25519VerificationKey2020',
    controller: did,
    publicKeyMultibase: encodePublicKeyMultibase(publicKey),
  });
  return new CredoDidDocument({
    context: ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: did,
    verificationMethod: [verificationMethod],
    authentication: [keyId],
    assertionMethod: [keyId],
  });
}

export { DID_ALGO_PATTERN };
