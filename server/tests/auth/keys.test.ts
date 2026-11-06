import { describe, it, expect, vi } from 'vitest';
import * as openpgp from 'openpgp';
import { fetchAndDecryptUserKey, KeyDecryptError } from '../../src/auth/keys.js';
import type { ProtonApi, ProtonUser, ProtonAddress } from '../../src/auth/proton-api.js';

async function makeUserKey(passphrase: string) {
  const { privateKey: armoredKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ email: 'test@example.com' }],
    passphrase,
    format: 'armored',
  });
  return armoredKey;
}

async function makeAddressKeyWithToken(userKeyArmored: string, userPassphrase: string) {
  // Generate the address key with a fresh random passphrase.
  const tokenPassphrase = 'addr-key-token-passphrase-1234';
  const { privateKey: addrKeyArmored } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ email: 'test@example.com' }],
    passphrase: tokenPassphrase,
    format: 'armored',
  });
  // Encrypt the tokenPassphrase to the user key (sign-and-encrypt).
  const userKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: userKeyArmored }),
    passphrase: userPassphrase,
  });
  const Token = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: tokenPassphrase }),
    encryptionKeys: userKey.toPublic(),
    format: 'armored',
  });
  // As Proton does: a detached signature by the user key over the passphrase.
  const Signature = await openpgp.sign({
    message: await openpgp.createMessage({ text: tokenPassphrase }),
    signingKeys: userKey,
    detached: true,
    format: 'armored',
  });
  return { addrKeyArmored, Token: Token as string, Signature: Signature as string };
}

async function makeLegacyAddressKey(mailboxPassphrase: string) {
  const { privateKey: addrKeyArmored } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ email: 'test@example.com' }],
    passphrase: mailboxPassphrase,
    format: 'armored',
  });
  return addrKeyArmored;
}

describe('fetchAndDecryptUserKey', () => {
  it('decrypts the primary user key and the address key via Token (modern)', async () => {
    const passphrase = 'test-mailbox-password-bytes';
    const userKeyArmored = await makeUserKey(passphrase);
    const { addrKeyArmored, Token, Signature } = await makeAddressKeyWithToken(userKeyArmored, passphrase);

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 'test', Currency: 'USD', Email: 'test@example.com', DisplayName: 'Test',
      Keys: [{
        ID: 'user-key-id-1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: userKeyArmored, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };
    const fakeAddress: ProtonAddress = {
      ID: 'real-address-id-AAA', Email: 'test@example.com',
      Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
      Keys: [{
        ID: 'addr-key-id-1', Version: 3, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: addrKeyArmored, Token, Signature, Fingerprint: 'fp2',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [fakeAddress] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    const { decryptedKeys: result } = await fetchAndDecryptUserKey({
      api: fakeApi,
      uid: 'uid-x',
      accessToken: 'at-x',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    expect(result.primaryKey).toBeDefined();
    expect(result.addresses).toHaveLength(1);
    expect(result.addresses[0]!.email).toBe('test@example.com');
    // Real Address ID, not user-key ID and not address-key ID.
    expect(result.addresses[0]!.addressId).toBe('real-address-id-AAA');
    expect(result.primaryAddress.addressId).toBe('real-address-id-AAA');
    expect(result.primaryAddress.email).toBe('test@example.com');
    // The address *key* ID is carried separately from the address ID: the SDK
    // sends it to the API as AddressKeyID when creating volumes and shares.
    expect(result.addresses[0]!.keys).toHaveLength(1);
    expect(result.addresses[0]!.keys[0]!.id).toBe('addr-key-id-1');
    expect(result.addresses[0]!.primaryKeyIndex).toBe(0);
  });

  it('decrypts every active address key and indexes the primary one', async () => {
    const passphrase = 'multi-key-mailbox-password';
    const userKeyArmored = await makeUserKey(passphrase);
    const rotatedOut = await makeAddressKeyWithToken(userKeyArmored, passphrase);
    const current = await makeAddressKeyWithToken(userKeyArmored, passphrase);

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 'test', Currency: 'USD', Email: 'test@example.com', DisplayName: 'Test',
      Keys: [{
        ID: 'user-key-id-1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: userKeyArmored, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };
    const fakeAddress: ProtonAddress = {
      ID: 'real-address-id-MULTI', Email: 'test@example.com',
      Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
      Keys: [
        {
          ID: 'addr-key-old', Version: 3, Primary: 0, Active: 1, Flags: 3,
          PrivateKey: rotatedOut.addrKeyArmored, Token: rotatedOut.Token,
          Signature: rotatedOut.Signature, Fingerprint: 'fp-old',
        },
        {
          ID: 'addr-key-current', Version: 3, Primary: 1, Active: 1, Flags: 3,
          PrivateKey: current.addrKeyArmored, Token: current.Token,
          Signature: current.Signature, Fingerprint: 'fp-current',
        },
        // Inactive keys stay out: the SDK would try to verify against them.
        {
          ID: 'addr-key-inactive', Version: 3, Primary: 0, Active: 0, Flags: 3,
          PrivateKey: current.addrKeyArmored, Token: current.Token,
          Signature: current.Signature, Fingerprint: 'fp-inactive',
        },
      ],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [fakeAddress] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    const { decryptedKeys: result } = await fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    const address = result.addresses[0]!;
    expect(address.keys.map((k) => k.id)).toEqual(['addr-key-old', 'addr-key-current']);
    expect(address.primaryKeyIndex).toBe(1);
  });

  it('decrypts a legacy address key (no Token) using mailbox password', async () => {
    const passphrase = 'legacy-mailbox-password';
    const userKeyArmored = await makeUserKey(passphrase);
    const addrKeyArmored = await makeLegacyAddressKey(passphrase);

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 'test', Currency: 'USD', Email: 'test@example.com', DisplayName: 'Test',
      Keys: [{
        ID: 'user-key-id-1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: userKeyArmored, Fingerprint: 'fp',
      }],
    };
    const fakeAddress: ProtonAddress = {
      ID: 'real-address-id-LEGACY', Email: 'test@example.com',
      Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
      Keys: [{
        ID: 'addr-key-legacy-1', Version: 3, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: addrKeyArmored, Fingerprint: 'fp2',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [fakeAddress] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    const { decryptedKeys: result } = await fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    expect(result.addresses[0]!.addressId).toBe('real-address-id-LEGACY');
  });

  it('returns the Proton user id with the keys', async () => {
    const passphrase = 'ids-mailbox-password';
    const userKeyArmored = await makeUserKey(passphrase);
    const { addrKeyArmored, Token, Signature } = await makeAddressKeyWithToken(userKeyArmored, passphrase);
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'user-123', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'uk-primary', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn().mockResolvedValue({
        Addresses: [{
          ID: 'addr-1', Email: 'test@example.com', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
          Keys: [{ ID: 'ak-1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: addrKeyArmored, Token, Signature, Fingerprint: 'fp2' }],
        }],
      }),
    } as unknown as ProtonApi;

    const result = await fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    expect(result).toEqual({ decryptedKeys: expect.any(Object), userId: 'user-123' });
    expect(result.decryptedKeys.addresses[0]!.addressId).toBe('addr-1');
  });

  it('says no_keys, not user_key, when every user key is inactive', async () => {
    const userKeyArmored = await makeUserKey('pw');
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'k1', Version: 4, Primary: 1, Active: 0, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'no_keys' });
  });

  it('says key_unreadable, not user_key, when a user key will not parse', async () => {
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: 'not an armored key', Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('pw'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'key_unreadable' });
  });

  it('says address_key when no key of an address opens', async () => {
    const passphrase = 'pw';
    const userKeyArmored = await makeUserKey(passphrase);
    // A legacy key under another passphrase: neither the token path nor the mailbox password opens it.
    const otherKey = await makeLegacyAddressKey('a-different-passphrase');
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn().mockResolvedValue({
        Addresses: [{
          ID: 'addr-1', Email: 'test@example.com', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
          Keys: [{ ID: 'ak-1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: otherKey, Fingerprint: 'fp2' }],
        }],
      }),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'address_key' });
  });

  it('throws KeyDecryptError on wrong mailbox password', async () => {
    const userKeyArmored = await makeUserKey('correct-password');

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
      Keys: [{
        ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: userKeyArmored, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'user_key' });
    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toBeInstanceOf(KeyDecryptError);
  });

  it('throws KeyDecryptError when user has no active keys', async () => {
    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
      Keys: [],
    };
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('p'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'no_keys' });
  });

  it('throws KeyDecryptError when user has no enabled addresses', async () => {
    const passphrase = 'pw';
    const userKeyArmored = await makeUserKey(passphrase);

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
      Keys: [{
        ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: userKeyArmored, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'no_addresses' });
  });
  describe('address-key token signatures', () => {
    const passphrase = 'signature-mailbox-password';

    /** A key whose Token anyone holding the public user key could make: encrypted to it, signed (or not) by someone else. */
    async function injectedKey(userKeyArmored: string, signer: openpgp.PrivateKey | null) {
      const tokenPassphrase = 'injected-token-passphrase';
      const { privateKey: addrKeyArmored } = await openpgp.generateKey({
        type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'test@example.com' }], passphrase: tokenPassphrase, format: 'armored',
      });
      const userPublic = (await openpgp.readPrivateKey({ armoredKey: userKeyArmored })).toPublic();
      const text = await openpgp.createMessage({ text: tokenPassphrase });
      const Token = (await openpgp.encrypt({ message: text, encryptionKeys: userPublic, format: 'armored' })) as string;
      const Signature = signer
        ? ((await openpgp.sign({ message: text, signingKeys: signer, detached: true, format: 'armored' })) as string)
        : null;
      return { addrKeyArmored, Token, Signature };
    }

    function apiWith(userKeyArmored: string, keys: ProtonAddress['Keys']): ProtonApi {
      return {
        getUser: vi.fn().mockResolvedValue({
          User: {
            ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
            Keys: [{ ID: 'uk1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
          },
        }),
        getAddresses: vi.fn().mockResolvedValue({
          Addresses: [{ ID: 'addr-1', Email: 'test@example.com', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1, Keys: keys }],
        }),
      } as unknown as ProtonApi;
    }

    const unlock = (api: ProtonApi) =>
      fetchAndDecryptUserKey({ api, uid: 'u', accessToken: 'a', mailboxPasswordBytes: new TextEncoder().encode(passphrase) });

    it.each([
      ['unsigned', false],
      ['signed by a key that is not one of the user keys', true],
    ])('leaves out a key whose token is %s, so it can never become primary', async (_label, signedByStranger) => {
      const userKeyArmored = await makeUserKey(passphrase);
      const own = await makeAddressKeyWithToken(userKeyArmored, passphrase);
      const stranger = signedByStranger
        ? (await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'x@example.com' }], format: 'object' })).privateKey
        : null;
      const injected = await injectedKey(userKeyArmored, stranger);
      const { decryptedKeys } = await unlock(apiWith(userKeyArmored, [
        { ID: 'ak-injected', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: injected.addrKeyArmored, Token: injected.Token, Signature: injected.Signature, Fingerprint: 'f1' },
        { ID: 'ak-own', Version: 3, Primary: 0, Active: 1, Flags: 3, PrivateKey: own.addrKeyArmored, Token: own.Token, Signature: own.Signature, Fingerprint: 'f2' },
      ]));
      const address = decryptedKeys.addresses[0]!;
      expect(address.keys.map((k) => k.id)).toEqual(['ak-own']);
      expect(address.keys[address.primaryKeyIndex]!.id).toBe('ak-own');
    });

    it('says address_key when the only key of an address has an unsigned token', async () => {
      const userKeyArmored = await makeUserKey(passphrase);
      const injected = await injectedKey(userKeyArmored, null);
      await expect(unlock(apiWith(userKeyArmored, [
        { ID: 'ak-injected', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: injected.addrKeyArmored, Token: injected.Token, Signature: null, Fingerprint: 'f1' },
      ]))).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'address_key' });
    });

    it("leaves out a key whose signature is over another key's token", async () => {
      const userKeyArmored = await makeUserKey(passphrase);
      const own = await makeAddressKeyWithToken(userKeyArmored, passphrase);
      const injected = await injectedKey(userKeyArmored, null);
      // A real signature from the user key, replayed onto a token it never signed.
      const { decryptedKeys } = await unlock(apiWith(userKeyArmored, [
        { ID: 'ak-injected', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: injected.addrKeyArmored, Token: injected.Token, Signature: own.Signature, Fingerprint: 'f1' },
        { ID: 'ak-own', Version: 3, Primary: 0, Active: 1, Flags: 3, PrivateKey: own.addrKeyArmored, Token: own.Token, Signature: own.Signature, Fingerprint: 'f2' },
      ]));
      expect(decryptedKeys.addresses[0]!.keys.map((k) => k.id)).toEqual(['ak-own']);
    });
  });
});
