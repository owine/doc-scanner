import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { COOKIE_NAME, _resetSids, _seedSid } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession, type LiveSession } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import type { DriveClient } from '../../src/drive/client.js';
import type { FolderCache } from '../../src/drive/folder-cache.js';
import { SessionStore } from '../../src/auth/session-store.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

let cleanupFn: (() => void) | null = null;
beforeEach(() => { _resetSids(); _resetLiveSessions(); });
afterEach(() => { cleanupFn?.(); cleanupFn = null; vi.restoreAllMocks(); });

function fakeFolderCache(tree: { linkId: string; path: string }[] = []): {
  cache: FolderCache;
  refresh: ReturnType<typeof vi.fn>;
  getTree: ReturnType<typeof vi.fn>;
} {
  let current = tree;
  const refresh = vi.fn().mockImplementation(async () => {
    current = current.length === 0 ? [{ linkId: 'root', path: '/' }] : current;
  });
  const getTree = vi.fn().mockImplementation(() => current);
  return { cache: { refresh, getTree } as unknown as FolderCache, refresh, getTree };
}

function setupAuthed(folderCache: FolderCache): { app: Hono; cookie: string } {
  const { db, cleanup } = createTestDb();
  cleanupFn = cleanup;

  const fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth }) as Hono;

  // Persist a session and seed a live sid + LiveSession with our fake cache.
  const store = new SessionStore(db, KEY);
  store.save({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });

  // Bypass the login flow: directly add a sid to the live-sids set and the
  // live-session map. This is the smallest surface that satisfies
  // sessionMiddleware's checks.
  const sid = 'test-sid-folders';
  _seedSid(sid);

  registerLiveSession({
    sid,
    session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' },
    mailboxSecret: new MailboxSecret(new Uint8Array([0])),
    decryptedKeys: {
      primaryAddress: { email: 'e@x.test', addressId: 'a1' },
      primaryKey: {} as DecryptedUserKey['primaryKey'],
      addresses: [],
    },
    driveClient: {} as DriveClient,
    folderCache,
  } satisfies LiveSession);

  return { app, cookie: `${COOKIE_NAME}=${sid}` };
}

describe('GET /api/drive/folders', () => {
  it('returns the cached tree as JSON', async () => {
    const { cache, refresh } = fakeFolderCache([
      { linkId: 'root', path: '/' },
      { linkId: 'f1', path: '/Tax' },
    ]);
    const { app, cookie } = setupAuthed(cache);

    const res = await app.request('/api/drive/folders', {
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [
        { linkId: 'root', path: '/' },
        { linkId: 'f1', path: '/Tax' },
      ],
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('triggers a refresh when ?refresh=1 is set', async () => {
    const { cache, refresh } = fakeFolderCache([
      { linkId: 'root', path: '/' },
      { linkId: 'f1', path: '/Tax' },
    ]);
    const { app, cookie } = setupAuthed(cache);

    const res = await app.request('/api/drive/folders?refresh=1', {
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('auto-refreshes when the cache is empty (cold first read)', async () => {
    const { cache, refresh } = fakeFolderCache([]);
    const { app, cookie } = setupAuthed(cache);

    const res = await app.request('/api/drive/folders', {
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ folders: [{ linkId: 'root', path: '/' }] });
  });

  it('returns 401 when not authenticated', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
    const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth }) as Hono;

    const res = await app.request('/api/drive/folders');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_authenticated' });
  });
});
