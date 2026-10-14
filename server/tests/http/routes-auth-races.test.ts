import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions, getLiveSession } from '../../src/auth/live-session.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { DriveClient, type DriveClientConfig } from '../../src/drive/client.js';
import type { EntitiesCache } from '../../src/drive/entities-cache.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { SETTING, readSetting } from '../../src/auth/app-settings.js';
import { SESSION, authApp, loginResult, makeKeys, post, seedPasskey, signIn, type AuthApp } from '../helpers/auth-app.js';

// Every DriveClient the routes build, with the config it was given: a test
// can then call a replaced client's callbacks after another login.
const built = vi.hoisted(() => [] as { client: unknown; cfg: DriveClientConfig }[]);
vi.mock('../../src/drive/client.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/drive/client.js')>();
  class RecordingDriveClient extends m.DriveClient {
    constructor(cfg: DriveClientConfig) {
      super(cfg);
      built.push({ client: this, cfg });
    }
  }
  return { ...m, DriveClient: RecordingDriveClient };
});

let keys: DecryptedUserKey;
let ctx: AuthApp | null = null;

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
  built.length = 0;
});
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  vi.restoreAllMocks();
});

function setup(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  ctx = authApp(opts);
  return ctx;
}

/** The client's own entities adapter, as the SDK holds it. */
const entitiesCacheOf = (client: unknown) => (client as { entitiesCache: EntitiesCache }).entitiesCache;
const entityRows = (c: AuthApp) => (c.db.prepare('SELECT COUNT(*) AS n FROM entities_cache').get() as { n: number }).n;

const refreshed = (accessToken: string) => ({ ...SESSION, accessToken, refreshToken: `${accessToken}-r` });

describe('a Drive client that is no longer the live one', () => {
  it('saves refreshed tokens while it is the live client', async () => {
    const c = setup();
    await signIn(c, keys);
    built[0]!.cfg.onSessionRefreshed!(refreshed('a2'));
    expect(c.store.load()?.accessToken).toBe('a2');
  });

  it('does not save its refreshed tokens over another account that signed in after it', async () => {
    const c = setup();
    await signIn(c, keys, { userId: 'user-A', session: { ...SESSION, accessToken: 'a' } });
    await signIn(c, keys, { userId: 'user-B', session: { ...SESSION, accessToken: 'b' } });
    const [a, b] = built;
    expect(getLiveSession('proxy')?.driveClient).toBe(b!.client);
    a!.cfg.onSessionRefreshed!(refreshed('a2'));
    expect(c.store.load()?.accessToken).toBe('b');
  });

  it('does not save its refreshed tokens over a newer login of the same account', async () => {
    const c = setup();
    await signIn(c, keys, { session: { ...SESSION, accessToken: 'first' } });
    await signIn(c, keys, { session: { ...SESSION, accessToken: 'second' } });
    built[0]!.cfg.onSessionRefreshed!(refreshed('first-2'));
    expect(c.store.load()?.accessToken).toBe('second');
  });

  it('stops writing to the shared entities cache once another account signed in', async () => {
    const c = setup();
    await signIn(c, keys, { userId: 'user-A' });
    await signIn(c, keys, { userId: 'user-B' });
    // As the worker would, mid-job with account A's client.
    await entitiesCacheOf(built[0]!.client).setEntity('volume-A~node', 'account A entity');
    expect(entityRows(c)).toBe(0);
    await entitiesCacheOf(built[1]!.client).setEntity('volume-B~node', 'account B entity');
    expect(entityRows(c)).toBe(1);
  });

  it('stops writing to the shared entities cache once a logout has begun clearing it', async () => {
    const c = setup();
    await signIn(c, keys);
    const old = entitiesCacheOf(built[0]!.client);
    const clearCaches = DriveClient.prototype.clearCaches;
    vi.spyOn(DriveClient.prototype, 'clearCaches').mockImplementation(async function (this: DriveClient) {
      await clearCaches.call(this);
      // The worker's write landing while logout is still in progress.
      await old.setEntity('volume-A~node', 'late entity');
    });
    expect((await post(c.app, '/api/auth/logout')).status).toBe(200);
    expect(entityRows(c)).toBe(0);
  });

  it('does not bring tokens back after a logout', async () => {
    const c = setup();
    await signIn(c, keys);
    expect((await post(c.app, '/api/auth/logout')).status).toBe(200);
    built[0]!.cfg.onSessionRefreshed!(refreshed('a2'));
    expect(c.store.load()).toBeNull();
  });
});

describe('login and logout take turns', () => {
  /** The next login's Proton step, held until released. */
  function heldLogin(c: AuthApp, result: ReturnType<typeof loginResult>): () => void {
    let release!: () => void;
    c.auth.login.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(result))));
    return () => release();
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const login = (c: AuthApp, email = 'e@x.test') => post(c.app, '/api/auth/login', { email, password: 'p' });

  /** Locked, with a passkey: what a logout would remove. */
  function lockedWithPasskey(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
    const c = setup(opts);
    c.store.save(SESSION);
    seedPasskey(c.passkeys);
    return c;
  }

  it('applies a logout sent during a login after that login', async () => {
    const c = lockedWithPasskey();
    const release = heldLogin(c, loginResult(keys));
    const signingIn = login(c);
    await vi.waitFor(() => expect(c.auth.login).toHaveBeenCalledTimes(1));
    const loggingOut = post(c.app, '/api/auth/logout');
    await settle();
    release();
    expect((await signingIn).status).toBe(200);
    expect((await loggingOut).status).toBe(200);
    expect(getLiveSession('proxy')).toBeUndefined();
    expect(c.passkeys.count()).toBe(0);
    expect(c.store.load()).toBeNull();
  });

  it('applies a login queued behind a logout after that logout', async () => {
    const c = lockedWithPasskey();
    const events: string[] = [];
    const save = SessionStore.prototype.save;
    vi.spyOn(SessionStore.prototype, 'save').mockImplementation(function (this: SessionStore, s) {
      events.push(`save ${s.accessToken}`);
      return save.call(this, s);
    });
    const clear = SessionStore.prototype.clear;
    vi.spyOn(SessionStore.prototype, 'clear').mockImplementation(function (this: SessionStore) {
      events.push('clear');
      return clear.call(this);
    });
    const release = heldLogin(c, loginResult(keys, { session: { ...SESSION, accessToken: 'first' } }));
    const first = login(c);
    await vi.waitFor(() => expect(c.auth.login).toHaveBeenCalledTimes(1));
    const loggingOut = post(c.app, '/api/auth/logout');
    await settle();
    c.auth.login.mockResolvedValueOnce(loginResult(keys, { session: { ...SESSION, accessToken: 'second' } }));
    const second = login(c);
    await settle();
    release();
    expect([(await first).status, (await loggingOut).status, (await second).status]).toEqual([200, 200, 200]);
    expect(events).toEqual(['save first', 'clear', 'save second']);
    expect(getLiveSession('proxy')?.session.accessToken).toBe('second');
    expect(c.store.load()?.accessToken).toBe('second');
    expect(c.passkeys.count()).toBe(0);
  });

  it('lets the second of two overlapping logins see the first, and clear it as another account', async () => {
    const c = lockedWithPasskey({ pipeline: true });
    const a = loginResult(keys, { userId: 'user-A', session: { ...SESSION, accessToken: 'a' } });
    const release = heldLogin(c, a);
    const first = login(c);
    await vi.waitFor(() => expect(c.auth.login).toHaveBeenCalledTimes(1));
    c.auth.login.mockResolvedValueOnce(loginResult(keys, { userId: 'user-B', session: { ...SESSION, accessToken: 'b' } }));
    const second = login(c, 'b@x.test');
    await settle();
    release();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect(getLiveSession('proxy')?.userId).toBe('user-B');
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-B');
    expect(c.store.load()?.accessToken).toBe('b');
    // Cleared as a different account: A's passkey went with A.
    expect(c.passkeys.count()).toBe(0);
    await expect(a.mailboxSecret.use(() => 1)).rejects.toThrow('already disposed');
  });
});
