import { buildDidDocument, encodePublicKeyMultibase } from './did-document';

describe('did-document', () => {
  const PUB_KEY = new Uint8Array(32).fill(0x42);
  const DID = 'did:algo:localnet:app:1234:' + Buffer.from(PUB_KEY).toString('hex');

  it('builds a W3C-compatible document with the public key as authentication & assertion method', () => {
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY });

    expect(doc.id).toBe(DID);
    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(doc['@context']).toContain('https://w3id.org/security/suites/ed25519-2020/v1');

    expect(doc.verificationMethod).toHaveLength(1);
    const [vm] = doc.verificationMethod;
    expect(vm.id).toBe(`${DID}#keys-1`);
    expect(vm.type).toBe('Ed25519VerificationKey2020');
    expect(vm.controller).toBe(DID);
    // multibase ed25519 keys are prefixed with 'z'
    expect(vm.publicKeyMultibase.startsWith('z')).toBe(true);

    expect(doc.authentication).toEqual([`${DID}#keys-1`]);
    expect(doc.assertionMethod).toEqual([`${DID}#keys-1`]);
    expect(doc.alsoKnownAs).toBeUndefined();
  });

  it('includes the linked wallet address in alsoKnownAs when provided', () => {
    const wallet = 'EKXHY5NSZLQAMWM5MVWSGRWQLIXXNVSZ6NFYIGEX2C2EBKIHFJO6NUFVSI';
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: wallet });
    expect(doc.alsoKnownAs).toEqual([`algorand:${wallet}`]);
  });

  it('publishes the linked Algorand account as a second ed25519 verification method', () => {
    const wallet = 'EKXHY5NSZLQAMWM5MVWSGRWQLIXXNVSZ6NFYIGEX2C2EBKIHFJO6NUFVSI';
    const doc = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: wallet });

    expect(doc.verificationMethod).toHaveLength(2);
    const [primary, linked] = doc.verificationMethod;
    expect(primary.id).toBe(`${DID}#keys-1`);
    expect(linked.id).toBe(`${DID}#keys-2`);
    expect(linked.type).toBe('Ed25519VerificationKey2020');
    expect(linked.controller).toBe(DID);
    expect(linked.publicKeyMultibase.startsWith('z')).toBe(true);
    // The linked key must differ from the user's vault key.
    expect(linked.publicKeyMultibase).not.toBe(primary.publicKeyMultibase);

    expect(doc.authentication).toEqual([`${DID}#keys-1`, `${DID}#keys-2`]);
    expect(doc.assertionMethod).toEqual([`${DID}#keys-1`, `${DID}#keys-2`]);
  });

  it('omits alsoKnownAs when linkedWalletAddress is null/empty', () => {
    const docNull = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: null });
    const docEmpty = buildDidDocument({ did: DID, publicKey: PUB_KEY, linkedWalletAddress: '' });
    expect(docNull.alsoKnownAs).toBeUndefined();
    expect(docEmpty.alsoKnownAs).toBeUndefined();
  });

  it('encodes ed25519 multibase deterministically (multicodec 0xed01 + base58btc)', () => {
    const a = encodePublicKeyMultibase(PUB_KEY);
    const b = encodePublicKeyMultibase(PUB_KEY);
    expect(a).toBe(b);
    // 32-byte key + 2-byte multicodec encoded as base58btc usually lands at 48 chars + the 'z' prefix.
    expect(a).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});
