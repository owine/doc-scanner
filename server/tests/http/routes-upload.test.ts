import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { COOKIE_NAME, _resetSids, _seedSid } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession, type LiveSession } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import { SessionStore } from '../../src/auth/session-store.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import type { DriveClient, UploadResult } from '../../src/drive/client.js';
import { UploadCollisionExhausted } from '../../src/drive/client.js';
import type { FolderCache } from '../../src/drive/folder-cache.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const FOLDERS = [
  { linkId: 'root', path: '/' },
  { linkId: 'f-tax', path: '/Tax' },
];

let cleanupFn: (() => void) | null = null;
let dbHandle: ReturnType<typeof createTestDb>['db'] | null = null;
let lastUploadFile: ReturnType<typeof vi.fn> | null = null;

beforeEach(() => { _resetSids(); _resetLiveSessions(); });
afterEach(() => { cleanupFn?.(); cleanupFn = null; dbHandle = null; lastUploadFile = null; vi.restoreAllMocks(); });

interface SetupOpts {
  uploadFile?: ReturnType<typeof vi.fn>;
}

function setupAuthed(opts: SetupOpts = {}): { app: Hono; cookie: string } {
  const { db, cleanup } = createTestDb();
  cleanupFn = cleanup;
  dbHandle = db;

  const fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth }) as Hono;

  const store = new SessionStore(db, KEY);
  store.save({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });

  const uploadFile = opts.uploadFile ?? vi.fn().mockResolvedValue({
    nodeUid: 'node-1',
    driveUrl: 'https://drive.example/node-1',
    finalName: 'Receipt',
  } satisfies UploadResult);
  lastUploadFile = uploadFile;

  const fakeFolderCache = {
    getTree: vi.fn().mockReturnValue(FOLDERS),
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as FolderCache;

  const fakeDriveClient = { uploadFile } as unknown as DriveClient;

  const sid = 'test-sid-upload';
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
    driveClient: fakeDriveClient,
    folderCache: fakeFolderCache,
  } satisfies LiveSession);

  return { app, cookie: `${COOKIE_NAME}=${sid}` };
}

function uploadFd(opts: { name?: string; folderLinkId?: string; pdf?: Blob; ocrText?: string } = {}): FormData {
  const fd = new FormData();
  fd.set('pdf', opts.pdf ?? new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }));
  if (opts.name !== undefined) fd.set('name', opts.name);
  else fd.set('name', 'Receipt');
  if (opts.folderLinkId !== undefined) fd.set('folderLinkId', opts.folderLinkId);
  else fd.set('folderLinkId', 'f-tax');
  fd.set('ocrText', opts.ocrText ?? 'sample ocr text');
  return fd;
}

describe('POST /api/upload', () => {
  it('happy path: uploads, writes audit row, returns finalName + driveNodeUid + driveWebUrl', async () => {
    const { app, cookie } = setupAuthed();
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      driveNodeUid: 'node-1',
      driveWebUrl: 'https://drive.example/node-1',
      finalName: 'Receipt',
    });
    expect(lastUploadFile).toHaveBeenCalledOnce();
    const [name, , mime, opts] = lastUploadFile!.mock.calls[0]!;
    expect(name).toBe('Receipt');
    expect(mime).toBe('application/pdf');
    expect(opts).toEqual({ parentFolderUid: 'f-tax' });

    const auditRows = dbHandle!.prepare(`SELECT event, detail FROM audit_log`).all() as Array<{ event: string; detail: string }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.event).toBe('drive_upload');
    const detail = JSON.parse(auditRows[0]!.detail);
    expect(detail).toMatchObject({ scanFinalName: 'Receipt', folderLinkId: 'f-tax', folderPath: '/Tax', driveNodeUid: 'node-1' });
  });

  it('surfaces collision-suffixed finalName when wrapper returns " (2)"', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      nodeUid: 'node-2',
      driveUrl: 'https://drive.example/node-2',
      finalName: 'Receipt (2)',
    } satisfies UploadResult);
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).finalName).toBe('Receipt (2)');
  });

  it('returns 409 with collision_exhausted on UploadCollisionExhausted', async () => {
    const uploadFile = vi.fn().mockRejectedValue(new UploadCollisionExhausted('exhausted'));
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'collision_exhausted', collision_exhausted: true });
  });

  it('returns 401 with reauth_required on auth-style SDK error', async () => {
    const uploadFile = vi.fn().mockRejectedValue(new Error('401 unauthorized: token expired'));
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'reauth_required', reauth_required: true });
  });

  it('returns 502 on a generic SDK failure (network/quota etc.)', async () => {
    const uploadFile = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upload_failed');
  });

  it('returns 400 when name fails the regex (slash, accent, too long)', async () => {
    const { app, cookie } = setupAuthed();
    for (const bad of ['Tax/Receipt', 'café', 'a'.repeat(81)]) {
      const res = await app.request('/api/upload', {
        method: 'POST', body: uploadFd({ name: bad }), headers: { cookie },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_name');
    }
  });

  it('returns 400 when folderLinkId is not in the cached tree', async () => {
    const { app, cookie } = setupAuthed();
    const res = await app.request('/api/upload', {
      method: 'POST', body: uploadFd({ folderLinkId: 'f-nonexistent' }), headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown_folder');
  });

  it('returns 401 when no live session', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
    const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth }) as Hono;
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd() });
    expect(res.status).toBe(401);
  });
});
