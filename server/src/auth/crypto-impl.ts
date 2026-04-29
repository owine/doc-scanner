import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import {
  CryptoProxy,
  VERIFICATION_STATUS,
  type CryptoProxyEndpoint,
  type PublicKeyReference,
  type HashAlgorithm,
} from '../vendor/proton-srp/crypto/index.js';

/**
 * Phase 2 CryptoProxy implementation.
 *
 * Real SHA-256 / SHA-512 / unsafeMD5 hashing via Node's `node:crypto`, and
 * real OpenPGP key import/export plus cleartext signature verification via
 * the `openpgp` npm package. This replaces the Phase 1 stubs that parsed
 * cleartext bodies without verifying signatures.
 */

const ALGO_MAP: Record<HashAlgorithm, string> = {
  SHA512: 'sha512',
  SHA256: 'sha256',
  unsafeMD5: 'md5',
};

export const cryptoImpl: CryptoProxyEndpoint = {
  async computeHash({ algorithm, data }) {
    const nodeAlgo = ALGO_MAP[algorithm];
    const hash = createHash(nodeAlgo).update(data).digest();
    // Return as a fresh Uint8Array<ArrayBuffer> so the buffer type matches the shim.
    const out = new Uint8Array(new ArrayBuffer(hash.byteLength));
    out.set(hash);
    return out;
  },

  async importPublicKey({ armoredKey }): Promise<PublicKeyReference> {
    return openpgp.readKey({ armoredKey });
  },

  async exportPublicKey({ key, format }) {
    const k = key as openpgp.Key;
    if (format === 'armored') return k.armor();
    const binary = k.write();
    const out = new Uint8Array(new ArrayBuffer(binary.byteLength));
    out.set(binary);
    return out;
  },

  async verifyCleartextMessage({ armoredCleartextMessage, verificationKeys }) {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: armoredCleartextMessage });
    const keys = Array.isArray(verificationKeys) ? verificationKeys : [verificationKeys];
    const result = await openpgp.verify({
      message,
      verificationKeys: keys as openpgp.Key[],
      format: 'utf8',
    });

    let verificationStatus: (typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS] =
      VERIFICATION_STATUS.NOT_SIGNED;
    if (result.signatures.length > 0) {
      try {
        await result.signatures[0]!.verified;
        verificationStatus = VERIFICATION_STATUS.SIGNED_AND_VALID;
      } catch {
        verificationStatus = VERIFICATION_STATUS.SIGNED_AND_INVALID;
      }
    }

    return { data: result.data as string, verificationStatus };
  },
};

let installed = false;
export function installCryptoImpl(): void {
  if (installed) return;
  CryptoProxy.setEndpoint(cryptoImpl);
  installed = true;
}
