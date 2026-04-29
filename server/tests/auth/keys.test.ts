import { describe, it, expect, vi } from 'vitest';
import * as openpgp from 'openpgp';
import { fetchAndDecryptUserKey, KeyDecryptError } from '../../src/auth/keys.js';
import type { ProtonApi, ProtonUser } from '../../src/auth/proton-api.js';

async function makeFixture(passphrase: string) {
  const { privateKey: armoredKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ email: 'test@example.com' }],
    passphrase,
    format: 'armored',
  });
  return armoredKey;
}

describe('fetchAndDecryptUserKey', () => {
  it('decrypts the primary user key with the correct mailbox password', async () => {
    const passphrase = 'test-mailbox-password-bytes';
    const armoredKey = await makeFixture(passphrase);

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 'test', Currency: 'USD', Email: 'test@example.com', DisplayName: 'Test',
      Keys: [{
        ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: armoredKey, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
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
    expect(result.primaryAddress.email).toBe('test@example.com');
  });

  it('throws KeyDecryptError on wrong mailbox password', async () => {
    const armoredKey = await makeFixture('correct-password');

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
      Keys: [{
        ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: armoredKey, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
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
      getKeySalts: vi.fn(),
      getAuthInfo: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('p'),
    })).rejects.toThrow(KeyDecryptError);
  });
});
