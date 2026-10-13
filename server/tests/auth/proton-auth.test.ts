import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import { computeKeyPassword } from '../../src/vendor/proton-srp/keys.js';
import { ProtonApiError, type ProtonAddress, type ProtonApi, type ProtonUser } from '../../src/auth/proton-api.js';

// Skip the SRP maths (the integration test covers the real proof); the key
// steps after it are what these tests are about.
vi.mock('../../src/vendor/proton-srp/srp.js', () => ({
  getSrp: vi.fn().mockResolvedValue({ clientEphemeral: 'ce', clientProof: 'cp', expectedServerProof: 'sp' }),
}));

const { ProtonAuth, SessionEndedError, isTransientProtonError, keySaltFingerprint } = await import('../../src/auth/srp.js');

const PASSWORD = 'correct horse battery staple';
/** 16 bytes in base64: 24 characters, as Proton sends a KeySalt. */
const KEY_SALT = Buffer.alloc(16, 3).toString('base64');

let passphrase: string;
let user: ProtonUser;
let address: ProtonAddress;

beforeAll(async () => {
  passphrase = await computeKeyPassword(PASSWORD, KEY_SALT);
  const { privateKey: userKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase, format: 'armored',
  });
  const tokenPassphrase = 'address-token-passphrase';
  const { privateKey: addressKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: tokenPassphrase, format: 'armored',
  });
  const unlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: userKey }), passphrase });
  const Token = (await openpgp.encrypt({
    message: await openpgp.createMessage({ text: tokenPassphrase }),
    encryptionKeys: unlocked.toPublic(),
    format: 'armored',
  })) as string;
  user = {
    ID: 'user-123', Name: 'e', Currency: 'USD', Email: 'e@x.test', DisplayName: 'E',
    Keys: [{ ID: 'uk1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKey, Fingerprint: 'f1' }],
  };
  address = {
    ID: 'addr-1', Email: 'e@x.test', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
    Keys: [{ ID: 'ak1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: addressKey, Token, Signature: null, Fingerprint: 'f2' }],
  };
});

function fakeApi(overrides: Partial<Record<keyof ProtonApi, unknown>> = {}): ProtonApi {
  return {
    getAuthInfo: vi.fn().mockResolvedValue({ Version: 4, Modulus: 'm', ServerEphemeral: 'se', Salt: 's', SRPSession: 'srp' }),
    submitAuth: vi.fn().mockResolvedValue({ UID: 'uid-1', AccessToken: 'at-1', RefreshToken: 'rt-1' }),
    submit2FA: vi.fn(),
    getKeySalts: vi.fn().mockResolvedValue({ KeySalts: [{ ID: 'uk1', KeySalt: KEY_SALT }] }),
    getUser: vi.fn().mockResolvedValue({ User: user }),
    getAddresses: vi.fn().mockResolvedValue({ Addresses: [address] }),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ProtonApi;
}

describe('ProtonAuth.login', () => {
  it('returns the Proton user id and the key-salt fingerprint', async () => {
    const result = await new ProtonAuth(fakeApi()).login('e@x.test', PASSWORD);
    expect(result.userId).toBe('user-123');
    expect(result.keySaltFingerprint).toBe(createHash('sha256').update(KEY_SALT).digest('hex'));
    expect(keySaltFingerprint(KEY_SALT)).toBe(result.keySaltFingerprint);
    result.mailboxSecret.dispose();
  });
});

describe('ProtonAuth.resume', () => {
  const SESSION = { uid: 'uid-1', accessToken: 'at-1', refreshToken: 'rt-1', email: 'e@x.test' };
  const REFRESHED = { uid: 'uid-2', accessToken: 'at-2', refreshToken: 'rt-2', email: 'e@x.test' };
  const bytes = () => new TextEncoder().encode(passphrase);
  const expired = () => new ProtonApiError('Invalid access token', 401);
  const refreshed = () => vi.fn().mockResolvedValue({ UID: 'uid-2', AccessToken: 'at-2', RefreshToken: 'rt-2' });

  it('opens the keys with the stored tokens and the passphrase', async () => {
    const api = fakeApi();
    const onRefreshed = vi.fn();
    const result = await new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed });
    expect(result).toEqual({ session: SESSION, decryptedKeys: expect.any(Object), userId: 'user-123' });
    expect(result.decryptedKeys.primaryAddress.addressId).toBe('addr-1');
    expect(api.getUser).toHaveBeenCalledWith('uid-1', 'at-1');
    // The key salts aren't needed: the passkey's passphrase opened the keys, so the salt is unchanged.
    expect(api.getKeySalts).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token once and hands the new tokens over before the retry', async () => {
    const getUser = vi.fn().mockRejectedValueOnce(expired()).mockResolvedValue({ User: user });
    const api = fakeApi({ getUser, refresh: refreshed() });
    const onRefreshed = vi.fn();
    const result = await new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed });
    expect(api.refresh).toHaveBeenCalledWith('uid-1', 'rt-1');
    expect(onRefreshed).toHaveBeenCalledWith(REFRESHED);
    expect(onRefreshed.mock.invocationCallOrder[0]!).toBeLessThan(getUser.mock.invocationCallOrder[1]!);
    expect(getUser).toHaveBeenLastCalledWith('uid-2', 'at-2');
    expect(result.session).toEqual(REFRESHED);
  });

  it('has handed over the refreshed tokens when the retry then fails', async () => {
    const getUser = vi.fn().mockRejectedValueOnce(expired()).mockRejectedValueOnce(new ProtonApiError('HTTP 503', 503));
    const onRefreshed = vi.fn();
    await expect(new ProtonAuth(fakeApi({ getUser, refresh: refreshed() })).resume(SESSION, bytes(), { onRefreshed })).rejects.toMatchObject({
      status: 503,
    });
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  for (const status of [400, 401, 422]) {
    it(`says the session ended when Proton refuses the refresh with ${status}`, async () => {
      const api = fakeApi({
        getUser: vi.fn().mockRejectedValue(expired()),
        refresh: vi.fn().mockRejectedValue(new ProtonApiError('Invalid refresh token', status)),
      });
      const onRefreshed = vi.fn();
      await expect(new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed })).rejects.toBeInstanceOf(SessionEndedError);
      expect(onRefreshed).not.toHaveBeenCalled();
    });
  }

  it('passes a transient refresh failure through, as transient', async () => {
    const api = fakeApi({
      getUser: vi.fn().mockRejectedValue(expired()),
      refresh: vi.fn().mockRejectedValue(new ProtonApiError('HTTP 503', 503)),
    });
    const error = await new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed: vi.fn() }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SessionEndedError);
    expect(isTransientProtonError(error)).toBe(true);
  });

  it('reports a passphrase that no longer opens the user key as user_key', async () => {
    const api = fakeApi();
    await expect(
      new ProtonAuth(api).resume(SESSION, new TextEncoder().encode('an old passphrase'), { onRefreshed: vi.fn() }),
    ).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'user_key' });
    expect(api.refresh).not.toHaveBeenCalled();
  });
});

describe('isTransientProtonError', () => {
  it('is true for no answer, a timeout, rate limiting and server errors only', () => {
    expect(isTransientProtonError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientProtonError(Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') }))).toBe(true);
    expect(isTransientProtonError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(isTransientProtonError(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    // A bug, not the network: it must reach the error report.
    expect(isTransientProtonError(new TypeError('x'))).toBe(false);
    for (const status of [429, 500, 502, 503]) expect(isTransientProtonError(new ProtonApiError('x', status))).toBe(true);
    for (const status of [400, 401, 422]) expect(isTransientProtonError(new ProtonApiError('x', status))).toBe(false);
    expect(isTransientProtonError(new Error('other'))).toBe(false);
  });
});
