import { describe, it, expect, beforeAll } from 'vitest';
import * as openpgp from 'openpgp';
import { getOpenPGPModule } from '../../src/drive/crypto-module.js';
import type { PrivateKey, PublicKey } from '@protontech/drive-sdk/dist/crypto/interface.js';

const VALID = 1;
const INVALID = 2;

const CONTEXT = 'drive.share-member.inviter';
const OTHER_CONTEXT = 'drive.share-member.member';

/**
 * Signature contexts are Proton's domain separation mechanism: an OpenPGP
 * notation (`context@proton.ch`) that the SDK marks critical when signing and
 * requires when verifying. These tests pin the behaviour our crypto adapter
 * has to reproduce on stock openpgp, since dropping the notation silently
 * produces signatures other Proton clients reject.
 */
describe('crypto module signature contexts', () => {
  const crypto = getOpenPGPModule();
  let privateKey: PrivateKey;
  let publicKey: PublicKey;
  const data = new TextEncoder().encode('payload') as Uint8Array<ArrayBuffer>;

  beforeAll(async () => {
    const { privateKey: generated } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ email: 'me@example.com' }],
      passphrase: 'p',
      format: 'object',
    });
    const decrypted = await openpgp.decryptKey({ privateKey: generated, passphrase: 'p' });
    privateKey = decrypted as unknown as PrivateKey;
    publicKey = decrypted.toPublic() as unknown as PublicKey;
  });

  async function signWithContext(context: string): Promise<string> {
    const { signature } = await crypto.sign(data, privateKey, context);
    const parsed = await openpgp.readSignature({ binarySignature: signature });
    return parsed.armor();
  }

  it('embeds the context notation when signing', async () => {
    const armored = await signWithContext(CONTEXT);
    const parsed = await openpgp.readSignature({ armoredSignature: armored });
    const notations = parsed.packets[0]!.rawNotations;

    const context = notations.find((n) => n.name === 'context@proton.ch');
    expect(context).toBeDefined();
    expect(new TextDecoder().decode(context!.value)).toBe(CONTEXT);
    expect(context!.critical).toBe(true);
  });

  it('verifies a signature carrying the expected context', async () => {
    const armored = await signWithContext(CONTEXT);
    const result = await crypto.verifyArmored(data, armored, publicKey, CONTEXT);
    expect(result.verified).toBe(VALID);
  });

  it('rejects a signature carrying a different context', async () => {
    const armored = await signWithContext(OTHER_CONTEXT);
    const result = await crypto.verifyArmored(data, armored, publicKey, CONTEXT);
    expect(result.verified).toBe(INVALID);
  });

  it('rejects a context-less signature when a context is required', async () => {
    const { signature } = await crypto.signArmored(data, privateKey);
    const result = await crypto.verifyArmored(data, signature, publicKey, CONTEXT);
    expect(result.verified).toBe(INVALID);
  });

  it('accepts a context-less signature when no context is expected', async () => {
    const { signature } = await crypto.signArmored(data, privateKey);
    const result = await crypto.verifyArmored(data, signature, publicKey);
    expect(result.verified).toBe(VALID);
  });

  it('can still verify a critical-notation signature without expecting a context', async () => {
    // A verifier that does not declare the notation as known would reject this
    // outright, which is exactly what the critical flag is for.
    const armored = await signWithContext(CONTEXT);
    const result = await crypto.verifyArmored(data, armored, publicKey);
    expect(result.verified).toBe(VALID);
  });
});
