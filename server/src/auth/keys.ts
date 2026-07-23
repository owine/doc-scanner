import * as openpgp from 'openpgp';
import type { ProtonApi, ProtonAddress, ProtonAddressKey } from './proton-api.js';

/**
 * One decrypted address key. `id` is the Proton *address key* ID
 * (`Addresses[].Keys[].ID`), which is a different identifier from the address
 * ID and is sent to the API as `AddressKeyID` during volume and share
 * creation. Getting these two confused makes those calls fail server-side.
 */
export interface DecryptedAddressKey {
  id: string;
  key: openpgp.PrivateKey;
}

export interface DecryptedAddress {
  email: string;
  addressId: string;
  /** All active keys of the address, newest-to-oldest as returned by Proton. */
  keys: DecryptedAddressKey[];
  /** Index into `keys` of the address's primary key. */
  primaryKeyIndex: number;
}

export interface DecryptedUserKey {
  primaryAddress: { email: string; addressId: string };
  /**
   * The primary *user* key. This is the root key that unlocks address-key
   * tokens — it is NOT an address key and must never be used to sign Drive
   * material. Use `addresses[].keys` for anything the SDK signs with.
   */
  primaryKey: openpgp.PrivateKey;
  addresses: DecryptedAddress[];
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
 * The returned `addresses[]` carry real Proton AddressIDs *and* real address
 * key IDs (both from the `/core/v4/addresses` response, NOT user-key IDs).
 * The Drive SDK's `SharesManager.createVolume` sends both to the API as
 * `AddressID` / `AddressKeyID`, so they must be authentic and distinct.
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

  const decryptedAddresses: DecryptedAddress[] = [];
  for (const addr of enabled) {
    const activeKeys = (addr.Keys ?? []).filter((k) => k.Active === 1 && k.PrivateKey);
    if (activeKeys.length === 0) continue;

    // Decrypt every active key, not just the primary one. The SDK verifies
    // node signatures against the union of all address keys
    // (internal/nodes/cryptoService.ts), so dropping rotated-out keys turns
    // older files into DegradedNodes. A single undecryptable key is not fatal
    // — it only costs us verification coverage for material signed with it.
    const keys: DecryptedAddressKey[] = [];
    let primaryKeyIndex = 0;
    for (const entry of activeKeys) {
      let addrPriv: openpgp.PrivateKey;
      try {
        addrPriv = await decryptAddressKey({
          addressKey: entry,
          userKeys: addressUserKeys,
          mailboxPassphrase: passphrase,
        });
      } catch {
        continue;
      }
      if (entry.Primary === 1) primaryKeyIndex = keys.length;
      keys.push({ id: entry.ID, key: addrPriv });
    }

    if (keys.length === 0) {
      throw new KeyDecryptError(`Failed to decrypt any address key for ${addr.Email}`);
    }
    decryptedAddresses.push({ email: addr.Email, addressId: addr.ID, keys, primaryKeyIndex });
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
