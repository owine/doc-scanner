import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { DriveAccount } from '../../src/drive/account.js';

async function makeKey(passphrase: string, email: string) {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy',
    userIDs: [{ email }], passphrase, format: 'object',
  });
  return openpgp.decryptKey({ privateKey, passphrase });
}

describe('DriveAccount', () => {
  it('returns the primary address from decrypted keys', async () => {
    const decrypted = await makeKey('p', 'test@example.com');

    const account = new DriveAccount({
      primaryAddress: { email: 'test@example.com', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'test@example.com', addressId: 'a1', key: decrypted }],
    });

    const addr = await account.getOwnPrimaryAddress();
    expect(addr.email).toBe('test@example.com');
    expect(addr.addressId).toBe('a1');
    expect(addr.keys[0]!.id).toBe('a1');
  });

  it('hasProtonAccount returns true for own email, false otherwise', async () => {
    const decrypted = await makeKey('p', 'me@example.com');
    const account = new DriveAccount({
      primaryAddress: { email: 'me@example.com', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'me@example.com', addressId: 'a1', key: decrypted }],
    });

    expect(await account.hasProtonAccount('me@example.com')).toBe(true);
    expect(await account.hasProtonAccount('other@example.com')).toBe(false);
  });

  it('getOwnAddress finds by email or addressId', async () => {
    const decrypted = await makeKey('p', 'me@example.com');
    const account = new DriveAccount({
      primaryAddress: { email: 'me@example.com', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'me@example.com', addressId: 'a1', key: decrypted }],
    });

    const byEmail = await account.getOwnAddress('me@example.com');
    expect(byEmail.addressId).toBe('a1');

    const byId = await account.getOwnAddress('a1');
    expect(byId.email).toBe('me@example.com');
  });

  it('getPublicKeys returns own public key for own email, empty otherwise', async () => {
    const decrypted = await makeKey('p', 'me@example.com');
    const account = new DriveAccount({
      primaryAddress: { email: 'me@example.com', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'me@example.com', addressId: 'a1', key: decrypted }],
    });

    const own = await account.getPublicKeys('me@example.com');
    expect(own).toHaveLength(1);

    const other = await account.getPublicKeys('other@example.com');
    expect(other).toHaveLength(0);
  });
});
