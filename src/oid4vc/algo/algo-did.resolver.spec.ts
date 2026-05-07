import { AlgoDidResolver, buildCredoDidDocumentFromKey } from './algo-did.resolver';
import { DidService } from '../../did/did.service';

describe('AlgoDidResolver', () => {
  // 32-byte ed25519 public key (all zeros) embedded as hex into a canonical
  // did:algo identifier. Pinned so the multibase encoding is deterministic.
  const HEX = '0'.repeat(64);
  const DID = `did:algo:testnet:app:1234:${HEX}`;
  const publicKey = Uint8Array.from(Buffer.from(HEX, 'hex'));

  const didService = {
    listRecords: jest.fn(),
  } as unknown as DidService;

  let resolver: AlgoDidResolver;
  beforeEach(() => {
    jest.clearAllMocks();
    resolver = new AlgoDidResolver(didService);
  });

  it('rejects identifiers that do not match the did:algo shape', async () => {
    (didService.listRecords as jest.Mock).mockResolvedValue([]);
    const r = await resolver.resolve({} as never, 'did:algo:not-real', { method: 'algo' } as never);
    expect(r.didDocument).toBeNull();
    expect(r.didResolutionMetadata.error).toBe('invalidDid');
  });

  it('rebuilds the document from the self-described identifier when no local record exists', async () => {
    (didService.listRecords as jest.Mock).mockResolvedValue([]);
    const r = await resolver.resolve({} as never, DID, { method: 'algo' } as never);
    expect(r.didDocument?.id).toBe(DID);
    expect(r.didDocument?.verificationMethod?.[0]?.controller).toBe(DID);
    expect(r.didResolutionMetadata.contentType).toBe('application/did+ld+json');
  });

  it('prefers a locally cached document when present', async () => {
    const expected = buildCredoDidDocumentFromKey(DID, publicKey);
    (didService.listRecords as jest.Mock).mockResolvedValue([
      {
        did: DID,
        user_id: 'u1',
        document: JSON.stringify({
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: DID,
          verificationMethod: [
            {
              id: `${DID}#keys-1`,
              type: 'Ed25519VerificationKey2020',
              controller: DID,
              publicKeyMultibase: expected.verificationMethod![0].publicKeyMultibase,
            },
          ],
          authentication: [`${DID}#keys-1`],
        }),
      },
    ]);
    const r = await resolver.resolve({} as never, DID, { method: 'algo' } as never);
    expect(r.didDocument?.verificationMethod?.[0]?.id).toBe(`${DID}#keys-1`);
  });

  it('falls back to self-described resolution when the cached document is malformed', async () => {
    (didService.listRecords as jest.Mock).mockResolvedValue([
      { did: DID, user_id: 'u1', document: '{not-json' },
    ]);
    const r = await resolver.resolve({} as never, DID, { method: 'algo' } as never);
    expect(r.didDocument?.id).toBe(DID);
  });
});
