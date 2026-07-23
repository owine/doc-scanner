import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { DriveAccount } from '../../src/drive/account.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';

async function makeKey(passphrase: string, email: string) {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy',
    userIDs: [{ email }], passphrase, format: 'object',
  });
  return openpgp.decryptKey({ privateKey, passphrase });
}

/**
 * Builds a single-address user whose *user* key is deliberately different from
 * its address key, so tests can prove the two never get swapped.
 */
async function singleAddressUser(email = 'me@example.com'): Promise<DecryptedUserKey> {
  const userKey = await makeKey('p', `user-${email}`);
  const addressKey = await makeKey('p', email);
  return {
    primaryAddress: { email, addressId: 'a1' },
    primaryKey: userKey,
    addresses: [
      { email, addressId: 'a1', keys: [{ id: 'k1', key: addressKey }], primaryKeyIndex: 0 },
    ],
  };
}

describe('DriveAccount', () => {
  it('returns the primary address with its address-key ID', async () => {
    const account = new DriveAccount(await singleAddressUser('test@example.com'));

    const addr = await account.getOwnPrimaryAddress();
    expect(addr.email).toBe('test@example.com');
    expect(addr.addressId).toBe('a1');
    // The SDK sends keys[].id to the API as AddressKeyID; it must be the
    // address *key* ID, never the address ID.
    expect(addr.keys[0]!.id).toBe('k1');
  });

  it('never exposes the user key as an address key', async () => {
    const user = await singleAddressUser();
    const account = new DriveAccount(user);

    const addr = await account.getOwnPrimaryAddress();
    const addressKey = user.addresses[0]!.keys[0]!.key;
    expect(addr.keys[0]!.key).toBe(addressKey);
    expect(addr.keys[0]!.key).not.toBe(user.primaryKey);
  });

  it('throws when the primary address has no decrypted keys', async () => {
    const user = await singleAddressUser();
    user.primaryAddress = { email: 'gone@example.com', addressId: 'missing' };
    const account = new DriveAccount(user);

    await expect(account.getOwnPrimaryAddress()).rejects.toThrow(/missing/);
  });

  it('exposes every active address key and honours primaryKeyIndex', async () => {
    const user = await singleAddressUser();
    const rotatedOut = await makeKey('p', 'me@example.com');
    // Put the primary second so the index has to be honoured, not assumed.
    user.addresses[0] = {
      email: 'me@example.com',
      addressId: 'a1',
      keys: [
        { id: 'k-old', key: rotatedOut },
        { id: 'k-primary', key: user.addresses[0]!.keys[0]!.key },
      ],
      primaryKeyIndex: 1,
    };
    const account = new DriveAccount(user);

    const addr = await account.getOwnPrimaryAddress();
    expect(addr.keys).toHaveLength(2);
    expect(addr.keys[addr.primaryKeyIndex]!.id).toBe('k-primary');

    // Signature verification needs the rotated-out key too.
    expect(await account.getPublicKeys('me@example.com')).toHaveLength(2);
  });

  it('hasProtonAccount returns true for own email, false otherwise', async () => {
    const account = new DriveAccount(await singleAddressUser());

    expect(await account.hasProtonAccount('me@example.com')).toBe(true);
    expect(await account.hasProtonAccount('other@example.com')).toBe(false);
  });

  it('getOwnAddress finds by email or addressId', async () => {
    const account = new DriveAccount(await singleAddressUser());

    const byEmail = await account.getOwnAddress('me@example.com');
    expect(byEmail.addressId).toBe('a1');

    const byId = await account.getOwnAddress('a1');
    expect(byId.email).toBe('me@example.com');
  });

  it('getPublicKeys returns own public keys for own email, empty otherwise', async () => {
    const account = new DriveAccount(await singleAddressUser());

    expect(await account.getPublicKeys('me@example.com')).toHaveLength(1);
    // Contract: unknown emails yield an empty array rather than throwing.
    expect(await account.getPublicKeys('other@example.com')).toHaveLength(0);
  });
});
