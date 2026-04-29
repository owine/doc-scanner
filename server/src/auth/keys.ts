import * as openpgp from 'openpgp';
import type { ProtonApi, ProtonUser } from './proton-api.js';

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
 * Fetches the user's profile from Proton and decrypts their primary private key
 * using the supplied mailbox password bytes. Returns key handles suitable for
 * passing to the SDK's ProtonDriveAccount adapter.
 *
 * Stateless — call this once per login, then store the result in the
 * caller's LiveSession map (memory only).
 *
 * NOTE: caller is responsible for deriving mailboxPasswordBytes via the
 * vendored computeKeyPassword(plaintext, keySalt) where keySalt is fetched
 * via api.getKeySalts() and matched to the primary key's ID. This function
 * does NOT do the salt fetching; that lives at the call site (auth/srp.ts)
 * because it has the plaintext password in scope already.
 */
export async function fetchAndDecryptUserKey(params: FetchAndDecryptParams): Promise<DecryptedUserKey> {
  const { api, uid, accessToken, mailboxPasswordBytes } = params;

  const { User } = await api.getUser(uid, accessToken);
  if (!User.Keys || User.Keys.length === 0) {
    throw new KeyDecryptError('User has no keys');
  }

  const passphrase = new TextDecoder().decode(mailboxPasswordBytes);

  const decrypted: DecryptedAddressKey[] = [];
  for (const k of User.Keys) {
    if (!k.Active) continue;
    try {
      const armored = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
      const key = await openpgp.decryptKey({ privateKey: armored, passphrase });
      decrypted.push({
        email: k.Address ?? User.Email,
        addressId: k.ID,
        key,
      });
    } catch (e) {
      throw new KeyDecryptError(`Failed to decrypt key ${k.ID}`, e);
    }
  }

  if (decrypted.length === 0) throw new KeyDecryptError('No decryptable keys');

  const primary = User.Keys.find((k) => k.Primary === 1 && k.Active === 1);
  const primaryEntry = primary
    ? decrypted.find((d) => d.addressId === primary.ID)
    : decrypted[0];

  if (!primaryEntry) throw new KeyDecryptError('No primary key after decryption');

  return {
    primaryAddress: { email: primaryEntry.email, addressId: primaryEntry.addressId },
    primaryKey: primaryEntry.key,
    addresses: decrypted,
  };
}
