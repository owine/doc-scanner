import * as openpgp from 'openpgp';
import type { ProtonApi, ProtonAddress, ProtonAddressKey } from './proton-api.js';

export interface DecryptedAddressKey {
  email: string;
  addressId: string;
  key: openpgp.PrivateKey;
}

export interface DecryptedUserKey {
  primaryAddress: { email: string; addressId: string };
  primaryKey: openpgp.PrivateKey;
  addresses: DecryptedAddressKey[];
}

export class KeyDecryptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'KeyDecryptError';
  }
}

export interface FetchAndDecryptParams {
  api: ProtonApi;
  uid: string;
  accessToken: string;
  mailboxPasswordBytes: Uint8Array;
}

/**
 * Fetches the user's profile + addresses from Proton and decrypts the user's
 * primary user key (with the mailbox password) plus each address's primary
 * key. Address keys come in two flavours:
 *
 *   1. Migrated (modern): `Token` field is an armored PGP message encrypted
 *      with the user key. Decrypting it yields the passphrase (utf-8 string)
 *      that unlocks the address `PrivateKey`.
 *   2. Legacy: no `Token`; address `PrivateKey` is encrypted directly with
 *      the mailbox password.
 *
 * The returned `addresses[]` carry real Proton AddressIDs (from the
 * `/core/v4/addresses` response, NOT user-key IDs). The Drive SDK's
 * `SharesManager.createVolume` validates these against Proton's address
 * table, so they must be authentic.
 */
export async function fetchAndDecryptUserKey(params: FetchAndDecryptParams): Promise<DecryptedUserKey> {
  const { api, uid, accessToken, mailboxPasswordBytes } = params;

  const { User } = await api.getUser(uid, accessToken);
  if (!User.Keys || User.Keys.length === 0) {
    throw new KeyDecryptError('User has no keys');
  }

  const passphrase = new TextDecoder().decode(mailboxPasswordBytes);

  // Decrypt all user keys. We need at least the primary one (used as the
  // root for decrypting address-key Tokens) but we keep the rest in case a
  // Token was encrypted with a non-primary user key.
  const decryptedUserKeys: { id: string; primary: number; key: openpgp.PrivateKey }[] = [];
  for (const k of User.Keys) {
    if (!k.Active) continue;
    try {
      const armored = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
      const key = await openpgp.decryptKey({ privateKey: armored, passphrase });
      decryptedUserKeys.push({ id: k.ID, primary: k.Primary, key });
    } catch (e) {
      throw new KeyDecryptError(`Failed to decrypt user key ${k.ID}`, e);
    }
  }
  if (decryptedUserKeys.length === 0) throw new KeyDecryptError('No decryptable user keys');

  const primaryUserKey =
    decryptedUserKeys.find((k) => k.primary === 1) ?? decryptedUserKeys[0]!;

  // Fetch addresses to get real Address IDs and address-level keys.
  const { Addresses } = await api.getAddresses(uid, accessToken);
  const enabled = (Addresses ?? []).filter((a) => a.Status === 1 && a.Receive === 1);
  if (enabled.length === 0) throw new KeyDecryptError('User has no enabled addresses');

  const addressUserKeys = decryptedUserKeys.map((k) => k.key);

  const decryptedAddresses: DecryptedAddressKey[] = [];
  for (const addr of enabled) {
    const primaryKeyEntry = pickPrimaryAddressKey(addr);
    if (!primaryKeyEntry) continue;
    try {
      const addrPriv = await decryptAddressKey({
        addressKey: primaryKeyEntry,
        userKeys: addressUserKeys,
        mailboxPassphrase: passphrase,
      });
      decryptedAddresses.push({ email: addr.Email, addressId: addr.ID, key: addrPriv });
    } catch (e) {
      throw new KeyDecryptError(`Failed to decrypt address key for ${addr.Email}`, e);
    }
  }

  if (decryptedAddresses.length === 0) {
    throw new KeyDecryptError('No decryptable address keys');
  }

  // Pick the primary address (lowest Order, or first as fallback).
  const orderedAddresses = [...enabled].sort((a, b) => a.Order - b.Order);
  const primaryAddr = orderedAddresses[0]!;
  const primaryEntry =
    decryptedAddresses.find((d) => d.addressId === primaryAddr.ID) ??
    decryptedAddresses[0]!;

  return {
    primaryAddress: { email: primaryEntry.email, addressId: primaryEntry.addressId },
    primaryKey: primaryUserKey.key,
    addresses: decryptedAddresses,
  };
}

function pickPrimaryAddressKey(addr: ProtonAddress): ProtonAddressKey | undefined {
  const active = (addr.Keys ?? []).filter((k) => k.Active === 1 && k.PrivateKey);
  return active.find((k) => k.Primary === 1) ?? active[0];
}

interface DecryptAddressKeyArgs {
  addressKey: ProtonAddressKey;
  userKeys: openpgp.PrivateKey[];
  mailboxPassphrase: string;
}

async function decryptAddressKey(args: DecryptAddressKeyArgs): Promise<openpgp.PrivateKey> {
  const { addressKey, userKeys, mailboxPassphrase } = args;
  const armoredKey = addressKey.PrivateKey;
  if (!armoredKey) throw new Error('Address key is missing PrivateKey');
  const armored = await openpgp.readPrivateKey({ armoredKey });

  // Modern (migrated) address key: Token holds the passphrase encrypted to
  // the user key. Decrypt it to retrieve the passphrase.
  if (addressKey.Token) {
    const message = await openpgp.readMessage({ armoredMessage: addressKey.Token });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: userKeys,
      format: 'utf8',
    });
    const tokenPassphrase = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
    return openpgp.decryptKey({ privateKey: armored, passphrase: tokenPassphrase });
  }

  // Legacy: address key is encrypted directly with the mailbox password.
  return openpgp.decryptKey({ privateKey: armored, passphrase: mailboxPassphrase });
}
