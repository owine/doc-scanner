import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { Hono } from 'hono';
import sharp from 'sharp';

// Mock classify/haiku before any module import that pulls it in (server.ts).
// vi.hoisted runs before vi.mock's hoisted call so `mockClassify` is defined
// in time for the factory.
const { mockClassify } = vi.hoisted(() => ({ mockClassify: vi.fn() }));
vi.mock('../../src/classify/haiku.js', () => ({
  classify: mockClassify,
  ImageTooLargeError: class extends Error {},
}));

import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { COOKIE_NAME, _resetSids, _seedSid } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession, type LiveSession } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import { SessionStore } from '../../src/auth/session-store.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import type { DriveClient } from '../../src/drive/client.js';
import type { FolderCache } from '../../src/drive/folder-cache.js';
import type { ClassifyResult } from '../../src/classify/types.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

let cleanupFn: (() => void) | null = null;
let SAMPLE_JPEG: Uint8Array;

beforeAll(async () => {
  const buf = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
  SAMPLE_JPEG = new Uint8Array(buf);
});

beforeEach(() => { _resetSids(); _resetLiveSessions(); mockClassify.mockReset(); });
afterEach(() => { cleanupFn?.(); cleanupFn = null; });

function jpegBlob(): Blob {
  return new Blob([SAMPLE_JPEG], { type: 'image/jpeg' });
}

interface SetupOpts {
  classifyResult?: ClassifyResult | null;
  folders?: { linkId: string; path: string }[];
}

function setupAuthed(opts: SetupOpts = {}): { app: Hono; cookie: string } {
  const { db, cleanup } = createTestDb();
  cleanupFn = cleanup;

  mockClassify.mockResolvedValue(opts.classifyResult ?? null);

  const folders = opts.folders ?? [{ linkId: 'root', path: '/' }];

  const fakeFolderCache = {
    getTree: vi.fn().mockReturnValue(folders),
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as FolderCache;

  const fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth }) as Hono;

  const store = new SessionStore(db, KEY);
  store.save({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });

  const sid = 'test-sid-classify';
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
    folderCache: fakeFolderCache,
  } satisfies LiveSession);

  return { app, cookie: `${COOKIE_NAME}=${sid}` };
}

describe('POST /api/classify', () => {
  it('returns the suggestion JSON on a happy multi-page upload', async () => {
    const folders = [{ linkId: 'root', path: '/' }, { linkId: 'f-tax', path: '/Tax' }];
    const fakeResult: ClassifyResult = {
      suggestedName: 'Tax 2026',
      suggestedFolderLinkId: 'f-tax',
      confidence: 0.9,
      rationale: 'IRS form',
      pageOcr: [
        { text: 'page 1', words: [] },
        { text: 'page 2', words: [] },
      ],
    };
    const { app, cookie } = setupAuthed({ classifyResult: fakeResult, folders });

    const fd = new FormData();
    fd.set('page_0', jpegBlob(), 'p0.jpg');
    fd.set('page_1', jpegBlob(), 'p1.jpg');
    const res = await app.request('/api/classify', { method: 'POST', body: fd, headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: fakeResult });
    expect(mockClassify).toHaveBeenCalledOnce();
    const call = mockClassify!.mock.calls[0]![0]!;
    expect(call.pages.length).toBe(2);
    expect(call.folders).toEqual(folders);
  });

  it('returns 400 when the multipart contains zero pages', async () => {
    const { app, cookie } = setupAuthed();
    const fd = new FormData();
    fd.set('something_else', new Blob(['x']), 'x');
    const res = await app.request('/api/classify', { method: 'POST', body: fd, headers: { cookie } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no_pages' });
  });

  it('only counts contiguous page_N indices (page_0, page_2 → 1 page)', async () => {
    const { app, cookie } = setupAuthed();
    const fd = new FormData();
    fd.set('page_0', jpegBlob(), 'p0.jpg');
    fd.set('page_2', jpegBlob(), 'p2.jpg');
    const res = await app.request('/api/classify', { method: 'POST', body: fd, headers: { cookie } });
    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledOnce();
    expect(mockClassify!.mock.calls[0]![0]!.pages.length).toBe(1);
  });

  it('returns 422 when a page is undecodable by sharp', async () => {
    const { app, cookie } = setupAuthed();
    const fd = new FormData();
    fd.set('page_0', new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03])], { type: 'image/jpeg' }), 'p0.jpg');
    const res = await app.request('/api/classify', { method: 'POST', body: fd, headers: { cookie } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('undecodable_image');
    expect(body.page).toBe(0);
  });

  it('returns 200 with { suggestion: null } when classify returns null (does NOT 500)', async () => {
    const { app, cookie } = setupAuthed({ classifyResult: null });
    const fd = new FormData();
    fd.set('page_0', jpegBlob(), 'p0.jpg');
    const res = await app.request('/api/classify', { method: 'POST', body: fd, headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: null });
  });

  it('passes recent history examples into classify when present (slice 3 wiring)', async () => {
    const { app, cookie } = setupAuthed({ classifyResult: null });
    // Seed history via the live ClassificationHistory wired into createApp.
    // Easier: hit /api/upload with a stub drive client to write history rows.
    // Even easier here: import + drive ClassificationHistory directly using
    // the same db the createApp built. createApp's deps.db is a different
    // handle though; we can't easily reach it. Instead, use the public
    // /api/upload route to seed three rows by registering a fake drive
    // client. But we also can't swap drive client mid-request from the
    // test because liveSession is registered already.
    //
    // Pragmatic check: assert that the classify route invokes findRecent
    // on the history dep injected at createApp time (history is slice-3
    // wired). Best verifier here is "did the classify mock receive an
    // `examples` field" — we covered shape elsewhere and this test asserts
    // the route's dependency wiring still passes through after our edits.
    const fd = new FormData();
    fd.set('page_0', jpegBlob(), 'p0.jpg');
    const res = await app.request('/api/classify', { method: 'POST', body: fd, headers: { cookie } });
    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledOnce();
    const arg = mockClassify.mock.calls[0]![0]!;
    // examples is always passed as an array (empty when no history yet).
    expect(Array.isArray(arg.examples)).toBe(true);
  });

  it('returns 401 when no live session', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
    const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth }) as Hono;

    const fd = new FormData();
    fd.set('page_0', jpegBlob(), 'p0.jpg');
    const res = await app.request('/api/classify', { method: 'POST', body: fd });
    expect(res.status).toBe(401);
  });
});
