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
import { ServerError } from '@protontech/drive-sdk';
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
    name: 'Receipt',
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

  it('returns the de-duplicated name the Drive client actually used', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      nodeUid: 'node-2',
      driveUrl: 'https://drive.example/node-2',
      name: 'Receipt (1)',
    } satisfies UploadResult);
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).finalName).toBe('Receipt (1)');
  });

  // Both shapes the SDK's apiErrorFactory produces for a 401: a JSON body
  // (APICodeError, `code`) and no body (APIHTTPError, `statusCode`).
  it.each([
    ['body Code', { code: 401 }],
    ['HTTP status', { statusCode: 401 }],
  ])('returns 401 with reauth_required on an SDK 401 (%s)', async (_label, fields) => {
    const uploadFile = vi.fn().mockRejectedValue(Object.assign(new ServerError('Invalid access token'), fields));
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'reauth_required', reauth_required: true });
  });

  it('does not treat an error that merely mentions "auth" as a 401', async () => {
    // The ported route used to sniff messages for "auth"/"token", which also
    // matches crypto failures and would bounce the user to the login screen.
    const uploadFile = vi.fn().mockRejectedValue(new Error('authentication tag mismatch'));
    const { app, cookie } = setupAuthed({ uploadFile });
    const res = await app.request('/api/upload', { method: 'POST', body: uploadFd(), headers: { cookie } });
    expect(res.status).toBe(502);
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
