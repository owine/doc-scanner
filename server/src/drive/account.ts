import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { PrivateKey, PublicKey } from '@protontech/drive-sdk/dist/crypto/index.js';
import type { DecryptedUserKey } from '../auth/keys.js';

/**
 * Implements the SDK's ProtonDriveAccount interface from in-memory decrypted keys.
 * Constructed once per LiveSession; lifetime is the cookie lifetime.
 *
 * For Phase 2's narrow scope (own files, no sharing), the user's primary key is
 * the only one needed. `getPublicKeys` returns own public key for own email and
 * an empty array otherwise (sharing is out of scope).
 *
 * Note: the SDK's PrivateKey/PublicKey are structural interfaces with brand
 * properties (_idx, _keyContentHash, _dummyType). openpgp's PrivateKey class
 * instances satisfy them at runtime but TS can't see through the brand fields,
 * so we cast through unknown.
 */
export class DriveAccount implements ProtonDriveAccount {
  constructor(private readonly user: DecryptedUserKey) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    return this.toSDKAddress(
      this.user.primaryAddress.addressId,
      this.user.primaryAddress.email,
      this.user.primaryKey,
    );
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    return this.user.addresses.map((a) => this.toSDKAddress(a.addressId, a.email, a.key));
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const all = await this.getOwnAddresses();
    const match = all.find((a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId);
    if (!match) throw new Error(`No address matching ${emailOrAddressId}`);
    return match;
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return this.user.addresses.some((a) => a.email === email);
  }

  async getPublicKeys(email: string, _forceRefresh?: boolean): Promise<PublicKey[]> {
    const own = this.user.addresses.find((a) => a.email === email);
    if (!own) return [];
    return [own.key.toPublic() as unknown as PublicKey];
  }

  private toSDKAddress(addressId: string, email: string, key: unknown): ProtonDriveAccountAddress {
    return {
      email,
      addressId,
      primaryKeyIndex: 0,
      keys: [{ id: addressId, key: key as PrivateKey }],
    };
  }
}
