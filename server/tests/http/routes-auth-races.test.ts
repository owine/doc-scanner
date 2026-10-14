import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions, getLiveSession } from '../../src/auth/live-session.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { DriveClient, type DriveClientConfig } from '../../src/drive/client.js';
import type { EntitiesCache } from '../../src/drive/entities-cache.js';
import { SESSION, authApp, makeKeys, post, signIn, type AuthApp } from '../helpers/auth-app.js';

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
