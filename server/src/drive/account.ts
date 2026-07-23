import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { PrivateKey, PublicKey } from '@protontech/drive-sdk/dist/crypto/index.js';
import type { DecryptedAddress, DecryptedUserKey } from '../auth/keys.js';

/**
 * Implements the SDK's ProtonDriveAccount interface from in-memory decrypted keys.
 * Constructed once per LiveSession; lifetime is the cookie lifetime.
 *
 * Two contract details worth spelling out, because getting either wrong fails
 * server-side rather than locally:
 *
 *   - `keys[].id` is the Proton *address key* ID, not the address ID. The SDK
 *     forwards it as `AddressKeyID` when creating a volume or a share
 *     (`internal/shares/manager.ts`).
 *   - `getOwnPrimaryAddress()` must return the primary *address* and its
 *     address keys. It must never return the user key: that key unlocks
 *     address-key tokens but is not a valid Drive signing key.
 *
 * All active address keys are exposed, not just the primary. The SDK verifies
 * node signatures against the union of every address key
 * (`internal/nodes/cryptoService.ts`), so trimming the list to the primary key
 * turns files signed with a rotated-out key into DegradedNodes.
 *
 * Note: the SDK's PrivateKey/PublicKey are structural interfaces with brand
 * properties (_idx, _keyContentHash, _dummyType). openpgp's PrivateKey class
 * instances satisfy them at runtime but TS can't see through the brand fields,
 * so we cast through unknown.
 */
export class DriveAccount implements ProtonDriveAccount {
  constructor(private readonly user: DecryptedUserKey) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const primary = this.user.addresses.find(
      (a) => a.addressId === this.user.primaryAddress.addressId,
    );
    if (!primary) {
      throw new Error(
        `No decrypted keys for primary address ${this.user.primaryAddress.addressId}`,
      );
    }
    return toSDKAddress(primary);
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    return this.user.addresses.map(toSDKAddress);
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const match = this.user.addresses.find(
      (a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId,
    );
    if (!match) throw new Error(`No address matching ${emailOrAddressId}`);
    return toSDKAddress(match);
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return this.user.addresses.some((a) => a.email === email);
  }

  /**
   * Per the SDK contract this returns an empty array (rather than throwing)
   * when we hold no keys for the email. Sharing is out of scope, so only our
   * own addresses resolve; every key of the address is returned so signatures
   * made with a rotated-out key still verify.
   */
  async getPublicKeys(email: string, _forceRefresh?: boolean): Promise<PublicKey[]> {
    const own = this.user.addresses.find((a) => a.email === email);
    if (!own) return [];
    return own.keys.map(({ key }) => key.toPublic() as unknown as PublicKey);
  }
}

function toSDKAddress(address: DecryptedAddress): ProtonDriveAccountAddress {
  return {
    email: address.email,
    addressId: address.addressId,
    primaryKeyIndex: address.primaryKeyIndex,
    keys: address.keys.map(({ id, key }) => ({ id, key: key as unknown as PrivateKey })),
  };
}
