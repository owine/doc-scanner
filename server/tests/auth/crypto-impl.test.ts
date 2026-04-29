import { describe, it, expect, beforeAll } from 'vitest';
import * as openpgp from 'openpgp';
import { installCryptoImpl } from '../../src/auth/crypto-impl.js';
import { CryptoProxy, VERIFICATION_STATUS } from '../../src/vendor/proton-srp/crypto/index.js';

describe('cryptoImpl.verifyCleartextMessage', () => {
  let armoredKey: string;
  let signedMessage: string;
  let tamperedMessage: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ email: 'test@example.com' }],
      format: 'armored',
    });
    armoredKey = publicKey;
    const message = await openpgp.createCleartextMessage({ text: 'hello world' });
    signedMessage = (await openpgp.sign({
      message,
      signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
      format: 'armored',
    })) as string;
    tamperedMessage = signedMessage.replace('hello world', 'hello WORLD');

    installCryptoImpl();
  });

  it('returns SIGNED_AND_VALID for a good signature', async () => {
    const key = await CryptoProxy.importPublicKey({ armoredKey });
    const result = await CryptoProxy.verifyCleartextMessage({
      armoredCleartextMessage: signedMessage,
      verificationKeys: key,
    });
    expect(result.data).toBe('hello world');
    expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);
  });

  it('returns SIGNED_AND_INVALID for a tampered cleartext', async () => {
    const key = await CryptoProxy.importPublicKey({ armoredKey });
    const result = await CryptoProxy.verifyCleartextMessage({
      armoredCleartextMessage: tamperedMessage,
      verificationKeys: key,
    });
    expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
  });

  it('throws on malformed input', async () => {
    const key = await CryptoProxy.importPublicKey({ armoredKey });
    await expect(
      CryptoProxy.verifyCleartextMessage({
        armoredCleartextMessage: 'not a pgp message',
        verificationKeys: key,
      }),
    ).rejects.toThrow();
  });
});
