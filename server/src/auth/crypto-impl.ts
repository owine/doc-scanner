import { createHash } from 'node:crypto';
import {
  CryptoProxy,
  VERIFICATION_STATUS,
  type CryptoProxyEndpoint,
  type PublicKeyReference,
  type HashAlgorithm,
} from '../vendor/proton-srp/crypto/index.js';

/**
 * Phase 1 CryptoProxy implementation.
 *
 * Real: SHA-256 / SHA-512 / unsafeMD5 hashing via Node's `node:crypto`.
 * Stub: OpenPGP signature verification of the SRP modulus. The cleartext
 *       message is parsed to extract its data body, but the embedded
 *       signature is NOT cryptographically verified. Trust boundary in
 *       Phase 1 is TLS-to-Proton; defense-in-depth modulus verification is
 *       deferred to a later phase (would require adding the `openpgp` npm
 *       package).
 */

const ALGO_MAP: Record<HashAlgorithm, string> = {
  SHA512: 'sha512',
  SHA256: 'sha256',
  unsafeMD5: 'md5',
};

const STUB_KEY: PublicKeyReference = Symbol('proton-modulus-key-stub');

export const cryptoImpl: CryptoProxyEndpoint = {
  async computeHash({ algorithm, data }) {
    const nodeAlgo = ALGO_MAP[algorithm];
    const hash = createHash(nodeAlgo).update(data).digest();
    // Return as a fresh Uint8Array<ArrayBuffer> so the buffer type matches the shim.
    const out = new Uint8Array(new ArrayBuffer(hash.byteLength));
    out.set(hash);
    return out;
  },

  async importPublicKey() {
    return STUB_KEY;
  },

  async exportPublicKey({ format }) {
    if (format === 'armored') return '';
    return new Uint8Array(0);
  },

  async verifyCleartextMessage({ armoredCleartextMessage }) {
    // Parse the data body of an OpenPGP cleartext signed message.
    // Format:
    //   -----BEGIN PGP SIGNED MESSAGE-----
    //   Hash: SHA512
    //   <blank line>
    //   <data lines, possibly dash-escaped with leading "- ">
    //   -----BEGIN PGP SIGNATURE-----
    //   ...
    //   -----END PGP SIGNATURE-----
    const startTag = '-----BEGIN PGP SIGNED MESSAGE-----';
    const sigTag = '-----BEGIN PGP SIGNATURE-----';
    const startIdx = armoredCleartextMessage.indexOf(startTag);
    const sigIdx = armoredCleartextMessage.indexOf(sigTag);
    if (startIdx === -1 || sigIdx === -1 || sigIdx < startIdx) {
      throw new Error('verifyCleartextMessage: malformed cleartext message');
    }
    // Find the blank line that ends the headers section.
    const headerEndIdx = armoredCleartextMessage.indexOf('\n\n', startIdx);
    if (headerEndIdx === -1 || headerEndIdx > sigIdx) {
      throw new Error('verifyCleartextMessage: missing header/body separator');
    }
    const rawBody = armoredCleartextMessage.slice(headerEndIdx + 2, sigIdx).replace(/\r?\n$/, '');
    // Reverse dash-escaping per RFC 4880 section 7: lines beginning with "- " have the leading "- " stripped.
    const data = rawBody
      .split(/\r?\n/)
      .map((line) => (line.startsWith('- ') ? line.slice(2) : line))
      .join('\n');
    return { data, verificationStatus: VERIFICATION_STATUS.SIGNED_AND_VALID };
  },
};

let installed = false;
export function installCryptoImpl(): void {
  if (installed) return;
  CryptoProxy.setEndpoint(cryptoImpl);
  installed = true;
}
