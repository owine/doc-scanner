/**
 * Minimal CryptoProxy interface shim.
 *
 * Upstream `@proton/crypto` (in WebClients) re-exports a runtime CryptoProxy
 * backed by OpenPGP.js. We avoid pulling OpenPGP.js (~16.5 MB unpacked) into
 * the vendor tree by exposing only the API surface the vendored SRP code
 * uses, and requiring the consumer to install a runtime implementation via
 * `CryptoProxy.setEndpoint(...)` before calling any vendored SRP function.
 *
 * Task 6 (server/src/auth/srp.ts) is responsible for wiring up an
 * implementation. For SHA-512 / MD5 (used by `passwords.ts`), Node's
 * built-in `node:crypto` is sufficient. For OpenPGP cleartext signature
 * verification of the SRP modulus (used by `utils/modulus.ts`), a real
 * OpenPGP implementation is needed -- the openpgp npm package or an
 * equivalent.
 *
 * The shape below is faithful to the @proton/crypto subset used by the
 * vendored SRP code at WebClients commit c324b82f. Adding fields here is a
 * breaking change to the consumer contract; update with care.
 */

// Opaque key handle. The runtime implementation chooses the concrete type.
export type PublicKeyReference = unknown;

export const VERIFICATION_STATUS = {
    NOT_SIGNED: 0,
    SIGNED_AND_VALID: 1,
    SIGNED_AND_INVALID: 2,
} as const;

export type VerificationStatus = (typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS];

export type HashAlgorithm = 'SHA512' | 'SHA256' | 'unsafeMD5';

export interface CryptoProxyEndpoint {
    computeHash(args: {
        algorithm: HashAlgorithm;
        data: Uint8Array<ArrayBuffer>;
    }): Promise<Uint8Array<ArrayBuffer>>;

    importPublicKey(args: { armoredKey: string }): Promise<PublicKeyReference>;

    exportPublicKey(args: {
        key: PublicKeyReference;
        format: 'binary' | 'armored';
    }): Promise<Uint8Array<ArrayBuffer> | string>;

    verifyCleartextMessage(args: {
        armoredCleartextMessage: string;
        verificationKeys: PublicKeyReference | PublicKeyReference[];
    }): Promise<{ data: string; verificationStatus?: VerificationStatus }>;
}

let endpoint: CryptoProxyEndpoint | undefined;

export const CryptoProxy = {
    setEndpoint(impl: CryptoProxyEndpoint) {
        endpoint = impl;
    },
    releaseEndpoint() {
        endpoint = undefined;
    },
    computeHash(args: { algorithm: HashAlgorithm; data: Uint8Array<ArrayBuffer> }) {
        if (!endpoint) throw new Error('CryptoProxy: endpoint not set');
        return endpoint.computeHash(args);
    },
    importPublicKey(args: { armoredKey: string }) {
        if (!endpoint) throw new Error('CryptoProxy: endpoint not set');
        return endpoint.importPublicKey(args);
    },
    exportPublicKey(args: { key: PublicKeyReference; format: 'binary' | 'armored' }) {
        if (!endpoint) throw new Error('CryptoProxy: endpoint not set');
        return endpoint.exportPublicKey(args);
    },
    verifyCleartextMessage(args: {
        armoredCleartextMessage: string;
        verificationKeys: PublicKeyReference | PublicKeyReference[];
    }) {
        if (!endpoint) throw new Error('CryptoProxy: endpoint not set');
        return endpoint.verifyCleartextMessage(args);
    },
};
