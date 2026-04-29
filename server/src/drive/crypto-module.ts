import * as openpgp from 'openpgp';
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';
import type {
  PrivateKey,
  PublicKey,
  SessionKey,
  VERIFICATION_STATUS as SDK_VERIFICATION_STATUS,
} from '@protontech/drive-sdk/dist/crypto/interface.js';
import { installCryptoImpl } from '../auth/crypto-impl.js';

/**
 * Adapter that satisfies the SDK's `OpenPGPCryptoProxy` interface (the same
 * shape as `@proton/crypto`'s CryptoProxy in the WebClients monorepo) by
 * delegating to the `openpgp` npm package.
 *
 * Upstream Proton wraps OpenPGP.js calls inside web workers and sprinkles on
 * client-side reference tracking. We are a single-process Node server, so we
 * call `openpgp.*` directly and let the library hold the references.
 *
 * The SDK's `OpenPGPCryptoWithCryptoProxy` wraps this adapter into the higher
 * level `OpenPGPCrypto` API the rest of the SDK consumes. The mapping here
 * mirrors `clients/packages/crypto/lib/proxy/proxy.ts` in WebClients.
 */

// Cast helper: openpgp returns plain Uint8Array; SDK types are
// `Uint8Array<ArrayBuffer>`. The runtime values are identical, so we cast
// rather than copy.
const asArrayBufferBacked = (u: Uint8Array): Uint8Array<ArrayBuffer> =>
  u as Uint8Array<ArrayBuffer>;

// Map openpgp's verification status numbers (0/1/2) to the SDK's enum values
// (which use the same numbers; the cast is just for the type system).
const VS_NOT_SIGNED = 0 as SDK_VERIFICATION_STATUS;
const VS_SIGNED_AND_VALID = 1 as SDK_VERIFICATION_STATUS;
const VS_SIGNED_AND_INVALID = 2 as SDK_VERIFICATION_STATUS;

async function evaluateSignatures(
  signatures: ReadonlyArray<{ verified: Promise<boolean> }>,
): Promise<{ status: SDK_VERIFICATION_STATUS; errors?: Error[] }> {
  if (signatures.length === 0) return { status: VS_NOT_SIGNED };
  const errors: Error[] = [];
  let anyValid = false;
  for (const sig of signatures) {
    try {
      await sig.verified;
      anyValid = true;
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (anyValid && errors.length === 0) return { status: VS_SIGNED_AND_VALID };
  if (anyValid) return { status: VS_SIGNED_AND_VALID, errors };
  return { status: VS_SIGNED_AND_INVALID, errors };
}

const proxyImpl = {
  generateKey: async (options: {
    userIDs: { name: string }[];
    type: 'ecc';
    curve: 'ed25519Legacy';
    config?: { aeadProtect: boolean };
  }): Promise<PrivateKey> => {
    const { privateKey } = (await (
      openpgp.generateKey as unknown as (o: unknown) => Promise<{ privateKey: unknown }>
    )({
      userIDs: options.userIDs,
      type: 'ecc',
      curve: options.curve,
      format: 'object',
      config: options.config ? { aeadProtect: options.config.aeadProtect } : undefined,
    }));
    return privateKey as PrivateKey;
  },

  exportPrivateKey: async (options: {
    privateKey: PrivateKey;
    passphrase: string | null;
  }): Promise<string> => {
    const key = options.privateKey as unknown as openpgp.PrivateKey;
    const locked =
      options.passphrase === null
        ? key
        : await openpgp.encryptKey({ privateKey: key, passphrase: options.passphrase });
    return locked.armor();
  },

  importPrivateKey: async (options: {
    armoredKey: string;
    passphrase: string | null;
  }): Promise<PrivateKey> => {
    const key = await openpgp.readPrivateKey({ armoredKey: options.armoredKey });
    const decrypted =
      options.passphrase === null
        ? key
        : await openpgp.decryptKey({ privateKey: key, passphrase: options.passphrase });
    return decrypted as unknown as PrivateKey;
  },

  generateSessionKey: async (options: {
    recipientKeys: PublicKey[];
    config?: { ignoreSEIPDv2FeatureFlag: boolean };
  }): Promise<SessionKey> => {
    const sk = await (
      openpgp.generateSessionKey as unknown as (o: unknown) => Promise<{
        data: Uint8Array;
        algorithm?: string | null;
        aeadAlgorithm?: string | null;
      }>
    )({
      encryptionKeys: options.recipientKeys,
      config: options.config,
    });
    return {
      data: asArrayBufferBacked(sk.data),
      algorithm: sk.algorithm ?? null,
      aeadAlgorithm: sk.aeadAlgorithm ?? null,
    };
  },

  encryptSessionKey: async (
    options: SessionKey & {
      format: 'binary';
      encryptionKeys?: PublicKey | PublicKey[];
      passwords?: string[];
    },
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const { data, algorithm, aeadAlgorithm, encryptionKeys, passwords } = options;
    const out = await (openpgp.encryptSessionKey as unknown as (o: unknown) => Promise<unknown>)({
      data,
      algorithm: algorithm ?? undefined,
      aeadAlgorithm: aeadAlgorithm ?? undefined,
      format: 'binary',
      encryptionKeys,
      passwords,
    });
    return asArrayBufferBacked(out as Uint8Array);
  },

  decryptSessionKey: async (options: {
    armoredMessage?: string;
    binaryMessage?: Uint8Array<ArrayBuffer>;
    decryptionKeys: PrivateKey | PrivateKey[];
  }): Promise<SessionKey | undefined> => {
    const message = options.armoredMessage
      ? await openpgp.readMessage({ armoredMessage: options.armoredMessage })
      : await openpgp.readMessage({ binaryMessage: options.binaryMessage! });
    const sks = await openpgp.decryptSessionKeys({
      message,
      decryptionKeys: options.decryptionKeys as unknown as openpgp.PrivateKey | openpgp.PrivateKey[],
    });
    if (sks.length === 0) return undefined;
    const sk = sks[0] as unknown as {
      data: Uint8Array;
      algorithm?: string | null;
      aeadAlgorithm?: string | null;
    };
    return {
      data: asArrayBufferBacked(sk.data),
      algorithm: sk.algorithm ?? null,
      aeadAlgorithm: sk.aeadAlgorithm ?? null,
    };
  },

  encryptMessage: async (options: {
    format?: 'armored' | 'binary';
    binaryData: Uint8Array<ArrayBuffer>;
    sessionKey?: SessionKey;
    encryptionKeys: PublicKey[];
    signingKeys?: PrivateKey;
    detached?: boolean;
    compress?: boolean;
    config?: { ignoreSEIPDv2FeatureFlag: boolean };
  }): Promise<unknown> => {
    const message = await openpgp.createMessage({ binary: options.binaryData });
    const format = options.format ?? 'armored';
    const sessionKey = options.sessionKey
      ? {
          data: options.sessionKey.data,
          algorithm: options.sessionKey.algorithm ?? undefined,
          aeadAlgorithm: options.sessionKey.aeadAlgorithm ?? undefined,
        }
      : undefined;
    // openpgp's `compress` is a config flag (preferredCompressionAlgorithm),
    // not a top-level option. We pass `config` through and let callers ask
    // for compression via that path; for our usage `compress` is rarely set.
    const config = options.config;
    const baseOpts = {
      message,
      format,
      sessionKey,
      encryptionKeys: options.encryptionKeys,
      signingKeys: options.signingKeys,
      config,
    };
    if (options.detached) {
      const result = await (openpgp.encrypt as unknown as (o: unknown) => Promise<unknown>)({
        ...baseOpts,
        detached: true,
      });
      const r = result as { data: string | Uint8Array; signature: string | Uint8Array };
      return {
        message: typeof r.data === 'string' ? r.data : asArrayBufferBacked(r.data),
        signature:
          typeof r.signature === 'string' ? r.signature : asArrayBufferBacked(r.signature),
      };
    }
    const result = await (openpgp.encrypt as unknown as (o: unknown) => Promise<unknown>)(baseOpts);
    return {
      message: typeof result === 'string' ? result : asArrayBufferBacked(result as Uint8Array),
    };
  },

  decryptMessage: async (options: {
    format: 'utf8' | 'binary';
    armoredMessage?: string;
    binaryMessage?: Uint8Array<ArrayBuffer>;
    armoredSignature?: string;
    binarySignature?: Uint8Array<ArrayBuffer>;
    sessionKeys?: SessionKey;
    passwords?: string[];
    decryptionKeys?: PrivateKey | PrivateKey[];
    verificationKeys?: PublicKey | PublicKey[];
  }): Promise<{
    data: Uint8Array<ArrayBuffer> | string;
    verificationStatus: SDK_VERIFICATION_STATUS;
    verificationErrors?: Error[];
  }> => {
    const message = options.armoredMessage
      ? await openpgp.readMessage({ armoredMessage: options.armoredMessage })
      : await openpgp.readMessage({ binaryMessage: options.binaryMessage! });
    const signature = options.armoredSignature
      ? await openpgp.readSignature({ armoredSignature: options.armoredSignature })
      : options.binarySignature
        ? await openpgp.readSignature({ binarySignature: options.binarySignature })
        : undefined;
    const sessionKeys = options.sessionKeys
      ? {
          data: options.sessionKeys.data,
          algorithm: options.sessionKeys.algorithm ?? undefined,
          aeadAlgorithm: options.sessionKeys.aeadAlgorithm ?? undefined,
        }
      : undefined;
    const result = await (openpgp.decrypt as unknown as (o: unknown) => Promise<unknown>)({
      message,
      format: options.format,
      signature,
      sessionKeys,
      passwords: options.passwords,
      decryptionKeys: options.decryptionKeys,
      verificationKeys: options.verificationKeys,
    });
    const r = result as {
      data: string | Uint8Array;
      signatures?: ReadonlyArray<{ verified: Promise<boolean> }>;
    };
    const verifiedSigs = r.signatures ?? [];
    const verification = options.verificationKeys
      ? await evaluateSignatures(verifiedSigs)
      : { status: VS_NOT_SIGNED };
    const data =
      options.format === 'binary'
        ? asArrayBufferBacked(r.data as Uint8Array)
        : (r.data as string);
    return {
      data,
      verificationStatus: verification.status,
      ...(verification.errors ? { verificationErrors: verification.errors } : {}),
    } as {
      data: Uint8Array<ArrayBuffer> | string;
      verificationStatus: SDK_VERIFICATION_STATUS;
      verificationErrors?: Error[];
    };
  },

  signMessage: async (options: {
    format: 'binary' | 'armored';
    binaryData: Uint8Array<ArrayBuffer>;
    signingKeys: PrivateKey | PrivateKey[];
    detached: boolean;
    signatureContext?: { critical: boolean; value: string };
  }): Promise<string | Uint8Array<ArrayBuffer>> => {
    const message = await openpgp.createMessage({ binary: options.binaryData });
    const result = await (openpgp.sign as unknown as (o: unknown) => Promise<unknown>)({
      message,
      format: options.format,
      signingKeys: options.signingKeys,
      detached: options.detached,
    });
    return typeof result === 'string' ? result : asArrayBufferBacked(result as Uint8Array);
  },

  verifyMessage: async (options: {
    binaryData: Uint8Array<ArrayBuffer>;
    armoredSignature?: string;
    binarySignature?: Uint8Array<ArrayBuffer>;
    verificationKeys: PublicKey | PublicKey[];
    signatureContext?: { required: boolean; value: string };
  }): Promise<{ verificationStatus: SDK_VERIFICATION_STATUS; errors?: Error[] }> => {
    const message = await openpgp.createMessage({ binary: options.binaryData });
    const signature = options.armoredSignature
      ? await openpgp.readSignature({ armoredSignature: options.armoredSignature })
      : await openpgp.readSignature({ binarySignature: options.binarySignature! });
    const result = await (openpgp.verify as unknown as (o: unknown) => Promise<unknown>)({
      message,
      signature,
      verificationKeys: options.verificationKeys,
    });
    const verification = await evaluateSignatures(
      (result as { signatures: ReadonlyArray<{ verified: Promise<boolean> }> }).signatures,
    );
    return {
      verificationStatus: verification.status,
      ...(verification.errors ? { errors: verification.errors } : {}),
    };
  },
};

/**
 * Returns a fresh SDK `OpenPGPCryptoWithCryptoProxy` instance, ensuring our
 * minimal CryptoProxy endpoint is installed first (the vendored SRP code
 * needs it; the SDK crypto module is independent of the SRP shim but we
 * keep the install in one place).
 *
 * Per Task 1 findings: `OpenPGPCryptoWithCryptoProxy` is per-instance state,
 * not a singleton, so it is safe to call this multiple times per process.
 * `installCryptoImpl()` is idempotent.
 */
export function getOpenPGPModule(): OpenPGPCryptoWithCryptoProxy {
  installCryptoImpl();
  // The constructor takes the lower-level OpenPGPCryptoProxy (a CryptoProxy
  // shape from WebClients). We supply an `openpgp`-backed adapter.
  return new OpenPGPCryptoWithCryptoProxy(
    proxyImpl as unknown as ConstructorParameters<typeof OpenPGPCryptoWithCryptoProxy>[0],
  );
}
