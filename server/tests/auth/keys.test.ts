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
  return { addrKeyArmored, Token: Token as string };
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
    const { addrKeyArmored, Token } = await makeAddressKeyWithToken(userKeyArmored, passphrase);

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
        PrivateKey: addrKeyArmored, Token, Signature: null, Fingerprint: 'fp2',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAddresses: vi.fn().mockResolvedValue({ Addresses: [fakeAddress] }),
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    const result = await fetchAndDecryptUserKey({
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

    const result = await fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    expect(result.addresses[0]!.addressId).toBe('real-address-id-LEGACY');
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
    })).rejects.toThrow(KeyDecryptError);
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
    })).rejects.toThrow(KeyDecryptError);
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
    })).rejects.toThrow(KeyDecryptError);
  });
});
