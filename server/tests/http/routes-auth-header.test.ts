import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions, getLiveSession, onLiveSessionRegistered } from '../../src/auth/live-session.js';
import { SETTING, readSetting, writeSetting } from '../../src/auth/app-settings.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { DriveClient } from '../../src/drive/client.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { TREE } from '../documents/harness.js';
import { SESSION, authApp, get, loginResult, makeKeys, post, seedPasskey, signIn, type AuthApp } from '../helpers/auth-app.js';

let keys: DecryptedUserKey;
let ctx: AuthApp | null = null;
const offs: (() => void)[] = [];

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});

function setup(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  ctx = authApp(opts);
  return ctx;
}

describe('POST /api/auth/login in header mode', () => {
  it('needs the proxy user, so nothing starts a Proton session around Authelia', async () => {
    const { app, auth } = setup();
    const res = await post(app, '/api/auth/login', { email: 'e@x.test', password: 'p' }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_authenticated' });
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('registers the live session under the proxy sid, issues no cookie, and wakes the listeners', async () => {
    const { app, auth } = setup();
    const registered = vi.fn();
    offs.push(onLiveSessionRegistered(registered));
    auth.login.mockResolvedValue(loginResult(keys));
    const res = await post(app, '/api/auth/login', { email: 'e@x.test', password: 'p' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(getLiveSession('proxy')).toMatchObject({ userId: 'user-1', keySaltFingerprint: 'fp-1' });
    await vi.waitFor(() => expect(registered).toHaveBeenCalledWith(expect.objectContaining({ sid: 'proxy' })));
  });
});

describe('GET /api/auth/status', () => {
  it('says none, locked or live, with the passkey count and unlock available', async () => {
    const c = setup();
    const status = async () => (await get(c.app, '/api/auth/status', { 'Remote-User': 'owine', 'Remote-Email': 'me@example.test' })).json();
    expect(await status()).toEqual({ email: 'me@example.test', proton: 'none', passkeys: 0, unlockAvailable: true });
    c.store.save(SESSION);
    seedPasskey(c.passkeys);
    expect(await status()).toEqual({ email: 'e@x.test', proton: 'locked', passkeys: 1, unlockAvailable: true });
    await signIn(c, keys);
    expect(await status()).toEqual({ email: 'e@x.test', proton: 'live', passkeys: 1, unlockAvailable: true });
  });

  it('answers 401 without the proxy user', async () => {
    const { app } = setup();
    expect((await get(app, '/api/auth/status', {})).status).toBe(401);
  });
});

describe('POST /api/auth/logout in header mode', () => {
  it('needs the proxy user', async () => {
    const c = setup();
    await signIn(c, keys);
    expect((await post(c.app, '/api/auth/logout', undefined, {})).status).toBe(401);
    expect(c.store.load()).not.toBeNull();
    expect(getLiveSession('proxy')).toBeDefined();
  });

  it('forgets the Proton session and every passkey, with no cookie', async () => {
    const c = setup();
    await signIn(c, keys);
    seedPasskey(c.passkeys);
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-1');
    const res = await post(c.app, '/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(c.store.load()).toBeNull();
    expect(c.passkeys.count()).toBe(0);
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBeNull();
    expect(getLiveSession('proxy')).toBeUndefined();
    expect(await (await get(c.app, '/api/auth/status')).json()).toMatchObject({ proton: 'none', passkeys: 0 });
  });
});

describe('signing in again', () => {
  it('never logs out first: the stored session is replaced and the passkeys stay', async () => {
    const c = setup();
    const clear = vi.spyOn(SessionStore.prototype, 'clear');
    const clearCaches = vi.spyOn(DriveClient.prototype, 'clearCaches');
    await signIn(c, keys);
    seedPasskey(c.passkeys);
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-1');
    await signIn(c, keys, { session: { ...SESSION, accessToken: 'a2' } });
    expect(clear).not.toHaveBeenCalled();
    expect(clearCaches).not.toHaveBeenCalled();
    expect(c.store.load()?.accessToken).toBe('a2');
    expect(c.passkeys.count()).toBe(1);
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-1');
  });

  it('as a different Proton account, forgets the old session, then clears the caches, the folder cache and the passkeys', async () => {
    const c = setup({ pipeline: true });
    await signIn(c, keys, { userId: 'user-A' });
    c.pipeline!.folderCache.save(TREE, new Date());
    seedPasskey(c.passkeys);
    const seen: (string | undefined)[] = [];
    vi.spyOn(DriveClient.prototype, 'clearCaches').mockImplementation(async () => {
      seen.push(getLiveSession('proxy')?.userId);
    });
    await signIn(c, keys, { userId: 'user-B' });
    // Account A's session was gone before anything was cleared, and B's not yet registered.
    expect(seen).toEqual([undefined]);
    expect(getLiveSession('proxy')?.userId).toBe('user-B');
    expect(c.pipeline!.folderCache.load()).toBeNull();
    expect(c.passkeys.count()).toBe(0);
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-B');
  });

  it('leaves no live session, and the old account id, when switching accounts fails part-way', async () => {
    const c = setup({ pipeline: true });
    await signIn(c, keys, { userId: 'user-A' });
    vi.spyOn(DriveClient.prototype, 'clearCaches').mockRejectedValue(new Error('disk full'));
    const second = loginResult(keys, { userId: 'user-B', session: { ...SESSION, accessToken: 'b' } });
    c.auth.login.mockResolvedValueOnce(second);
    const res = await post(c.app, '/api/auth/login', { email: 'b@x.test', password: 'p' });
    expect(res.status).toBe(500);
    // Account A's keys went with its session; B's tokens are stored, locked.
    expect(getLiveSession('proxy')).toBeUndefined();
    expect(c.store.load()?.accessToken).toBe('b');
    // So the next login still sees a different account, and clears again.
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-A');
    await expect(second.mailboxSecret.use(() => 1)).rejects.toThrow('already disposed');
  });

  it('treats an email that differs only in case as the same account', async () => {
    const c = setup({ pipeline: true });
    await signIn(c, keys);
    c.pipeline!.folderCache.save(TREE, new Date());
    seedPasskey(c.passkeys);
    const clearCaches = vi.spyOn(DriveClient.prototype, 'clearCaches');
    await signIn(c, keys, {}, 'E@X.TEST');
    expect(clearCaches).not.toHaveBeenCalled();
    expect(c.pipeline!.folderCache.load()).not.toBeNull();
    expect(c.passkeys.count()).toBe(1);
  });

  it('clears nothing on the first login after this ships (no stored user id)', async () => {
    const c = setup();
    seedPasskey(c.passkeys);
    await signIn(c, keys);
    expect(c.passkeys.count()).toBe(1);
  });

  it('removes the passkeys when the key salt changed, and leaves Settings a notice', async () => {
    const c = setup();
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-old');
    seedPasskey(c.passkeys);
    await signIn(c, keys);
    expect(c.passkeys.count()).toBe(0);
    expect(readSetting(c.db, SETTING.removedNotice)).toBe('password_changed');
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBeNull();
  });

  it('leaves no notice when a changed key salt had no passkeys to remove', async () => {
    const c = setup();
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-old');
    await signIn(c, keys);
    expect(readSetting(c.db, SETTING.removedNotice)).toBeNull();
  });

  it('keeps the passkeys when the key salt is unchanged', async () => {
    const c = setup();
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-1');
    seedPasskey(c.passkeys);
    await signIn(c, keys);
    expect(c.passkeys.count()).toBe(1);
  });
});
