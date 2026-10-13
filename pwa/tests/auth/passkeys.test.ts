import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrolPasskey, forgetCredential, fromBase64url, toBase64url, unlockWithPasskey } from '../../src/auth/passkeys.js';
import { domError, fakeCredential, installCredentials, removeCredentials } from './fake-webauthn.js';

afterEach(() => {
  removeCredentials();
  vi.unstubAllGlobals();
});

const ID = toBase64url(new Uint8Array(16).fill(1));
const ID_2 = toBase64url(new Uint8Array(16).fill(2));
const OLD = toBase64url(new Uint8Array(16).fill(5));
const PRF = new Uint8Array(32).fill(7);
const SALT = toBase64url(new Uint8Array(32).fill(3));
const SALT_2 = toBase64url(new Uint8Array(32).fill(4));
const BEGIN = { salt: SALT, userHandle: toBase64url(new Uint8Array(16).fill(9)), excludeCredentials: [OLD] };

const bytes = (b: BufferSource) => Array.from(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

describe('base64url', () => {
  it('round-trips bytes with no padding, + or /', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const text = toBase64url(all);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(fromBase64url(text))).toEqual(Array.from(all));
    expect(toBase64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('enrolPasskey', () => {
  it('creates a discoverable, user-verified passkey and reads its PRF output for the salt', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'ok', credentialId: ID, prf: toBase64url(PRF) });
    const options = c.create.mock.calls[0]![0].publicKey;
    expect(options.rp).toEqual({ name: 'Doc Scanner' });
    expect(options.user.name).toBe('user@example.test');
    expect(options.user.displayName).toBe('user@example.test');
    expect(bytes(options.user.id)).toEqual(Array.from(new Uint8Array(16).fill(9)));
    expect(options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
    expect(bytes(options.extensions.prf.eval.first)).toEqual(Array.from(new Uint8Array(32).fill(3)));
    expect(options.excludeCredentials.map((d: PublicKeyCredentialDescriptor) => toBase64url(d.id))).toEqual([OLD]);
    expect(c.get).not.toHaveBeenCalled();
  });

  it('asks again with an assertion when creation gave no PRF result', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'ok', credentialId: ID, prf: toBase64url(PRF) });
    const options = c.get.mock.calls[0]![0].publicKey;
    expect(options.allowCredentials.map((d: PublicKeyCredentialDescriptor) => toBase64url(d.id))).toEqual([ID]);
    expect(options.userVerification).toBe('required');
    expect(bytes(options.extensions.prf.eval.first)).toEqual(Array.from(new Uint8Array(32).fill(3)));
  });

  it('offers Finish setup when the follow-up prompt is refused without a tap, and finishes on it', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockRejectedValueOnce(domError('NotAllowedError')).mockResolvedValueOnce(fakeCredential(ID, PRF));
    const first = await enrolPasskey(BEGIN, 'user@example.test');
    expect(first).toMatchObject({ kind: 'finish_setup', credentialId: ID });
    if (first.kind !== 'finish_setup') throw new Error('expected finish_setup');
    expect(await first.finish()).toEqual({ kind: 'ok', credentialId: ID, prf: toBase64url(PRF) });
  });

  it('says a passkey with no PRF support cannot unlock', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockResolvedValue(fakeCredential(ID, null));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'prf_unsupported', credentialId: ID });
  });

  it('maps a cancelled prompt, an already-added passkey, and passes other failures on', async () => {
    const c = installCredentials();
    c.create.mockRejectedValueOnce(domError('NotAllowedError'));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'cancelled' });
    c.create.mockRejectedValueOnce(domError('InvalidStateError'));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'already_added' });
    c.create.mockRejectedValueOnce(domError('SecurityError'));
    await expect(enrolPasskey(BEGIN, 'user@example.test')).rejects.toMatchObject({ name: 'SecurityError' });
  });
});

describe('unlockWithPasskey', () => {
  it('asks once, with a salt for each passkey keyed by its id, and returns the one used', async () => {
    const c = installCredentials();
    c.get.mockResolvedValue(fakeCredential(ID_2, PRF));
    const result = await unlockWithPasskey([
      { credentialId: ID, salt: SALT },
      { credentialId: ID_2, salt: SALT_2 },
    ]);
    expect(result).toEqual({ kind: 'ok', credentialId: ID_2, prf: toBase64url(PRF) });
    const options = c.get.mock.calls[0]![0].publicKey;
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials.map((d: PublicKeyCredentialDescriptor) => toBase64url(d.id))).toEqual([ID, ID_2]);
    expect(Object.keys(options.extensions.prf.evalByCredential)).toEqual([ID, ID_2]);
    expect(bytes(options.extensions.prf.evalByCredential[ID_2].first)).toEqual(Array.from(new Uint8Array(32).fill(4)));
  });

  it('maps a cancelled prompt, and a credential with no PRF result', async () => {
    const c = installCredentials();
    c.get.mockRejectedValueOnce(domError('NotAllowedError'));
    expect(await unlockWithPasskey([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'cancelled' });
    c.get.mockResolvedValueOnce(fakeCredential(ID, null));
    expect(await unlockWithPasskey([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'no_prf' });
  });
});

describe('forgetCredential', () => {
  it('signals an unknown credential where the browser can', async () => {
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await forgetCredential(ID)).toBe(true);
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('says so where it cannot', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(await forgetCredential(ID)).toBe(false);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential: vi.fn().mockRejectedValue(new Error('no')) });
    expect(await forgetCredential(ID)).toBe(false);
  });
});
