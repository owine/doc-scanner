import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { PDFDocument } from '@cantoo/pdf-lib';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession, type LiveSession } from '../../src/auth/live-session.js';
import type { DriveClient } from '../../src/drive/client.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { createPipeline, type Pipeline } from '../../src/documents/pipeline.js';
import { ANALYSIS, TREE, okOutcome, fakePrepare } from '../documents/harness.js';
import type { DocumentPatch } from '../../src/documents/types.js';
import { logger } from '../../src/logger.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
let keys: DecryptedUserKey;
let cleanups: (() => void)[] = [];

beforeAll(async () => {
  const { privateKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: 'p', format: 'object' });
  const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  keys = {
    primaryAddress: { email: 'e@x.test', addressId: 'a1' },
    primaryKey: decrypted,
    addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key: decrypted }], primaryKeyIndex: 0 }],
  };
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

async function setup(opts: { liveSession?: () => LiveSession | undefined } = {}) {
  const { db, cleanup } = createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'routes-docs-'));
  cleanups.push(cleanup, () => rmSync(dir, { recursive: true, force: true }));
  const analyze = vi.fn().mockResolvedValue(okOutcome());
  const pipeline: Pipeline = createPipeline({
    db,
    dataDir: dir,
    encryptionKey: KEY,
    defaults: { model: 'm', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
    analyzerFor: () => ({ analyze }),
    liveSession: opts.liveSession ?? (() => undefined),
    prepare: fakePrepare(),
  });
  const fakeAuth = {
    login: vi.fn().mockResolvedValue({
      session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' },
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
    }),
    refresh: vi.fn(),
  } as unknown as ProtonAuth;
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth, pipeline });
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return { app, pipeline, cookie, analyze, db };
}

function upload(app: Awaited<ReturnType<typeof setup>>['app'], cookie: string, text = 'statement') {
  const fd = new FormData();
  fd.append('file', new File([text], 'statement.txt', { type: 'text/plain' }));
  fd.append('source', 'picker');
  return app.request('/api/documents', { method: 'POST', body: fd, headers: { cookie } });
}

describe('document routes', () => {
  it('requires a login on every router', async () => {
    const { app } = await setup();
    const routes: [string, string][] = [
      ['GET', '/api/documents'],
      ['POST', '/api/documents'],
      ['GET', '/api/documents/some-id'],
      ['GET', '/api/documents/some-id/thumbnail'],
      ['POST', '/api/documents/some-id/approve'],
      ['POST', '/api/documents/some-id/discard'],
      ['POST', '/api/documents/some-id/restore'],
      ['POST', '/api/documents/some-id/retry'],
      ['POST', '/api/documents/combine'],
      ['POST', '/api/documents/some-id/reanalyze'],
      ['GET', '/api/folders'],
      ['POST', '/api/folders/refresh'],
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
    ];
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
    expect((await app.request('/api/health')).status).toBe(200); // guard is scoped
  });

  it('accepts an upload with 202 and returns the existing document for a duplicate', async () => {
    const { app, cookie, pipeline } = await setup();
    const first = await upload(app, cookie);
    expect(first.status).toBe(202);
    const { id } = (await first.json()) as { id: string };
    expect(pipeline.inbox.has(id, 'original')).toBe(true);
    const again = await upload(app, cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, duplicate: true });
  });

  it('rejects an empty file and an unknown source', async () => {
    const { app, cookie } = await setup();
    const empty = new FormData();
    empty.append('file', new File([], 'x.txt', { type: 'text/plain' }));
    empty.append('source', 'picker');
    expect((await app.request('/api/documents', { method: 'POST', body: empty, headers: { cookie } })).status).toBe(400);
    const bad = new FormData();
    bad.append('file', new File(['x'], 'x.txt'));
    bad.append('source', 'carrier-pigeon');
    expect((await app.request('/api/documents', { method: 'POST', body: bad, headers: { cookie } })).status).toBe(400);
  });

  it('lists changes since a cursor', async () => {
    const { app, cookie } = await setup();
    await upload(app, cookie, 'one');
    const res = await app.request('/api/documents?since=0', { headers: { cookie } });
    const body = (await res.json()) as { documents: { id: string }[]; cursor: number };
    expect(body.documents).toHaveLength(1);
    const later = await app.request(`/api/documents?since=${body.cursor}`, { headers: { cookie } });
    expect(((await later.json()) as { documents: unknown[] }).documents).toHaveLength(0);
  });

  it('approves a document in review, with the user edit recorded', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'z', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS });
    const res = await app.request(`/api/documents/${doc.id}/approve`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Northwind Energy September 2026' }),
    });
    expect(res.status).toBe(200);
    // The worker's first step runs synchronously inside wake(): with no live
    // session in this test, filing immediately parks the document.
    expect(pipeline.repo.get(doc.id)).toMatchObject({
      state: 'awaiting_login',
      userEdited: true,
      decision: { name: 'Northwind Energy September 2026', folder: ANALYSIS.folder },
    });
  });

  it('rejects approval into a folder it does not know', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'z', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS });
    const res = await app.request(`/api/documents/${doc.id}/approve`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ folder: { kind: 'existing', linkId: 'NOPE' } }),
    });
    expect(res.status).toBe(400);
  });

  it('discards, restores and retries', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'y', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS, preparedMime: 'application/pdf' });
    const post = (path: string) => app.request(`/api/documents/${doc.id}/${path}`, { method: 'POST', headers: { cookie } });
    expect((await post('discard')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)?.state).toBe('discarded');
    expect((await post('restore')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
    // As a failure while preparing leaves it: the stage clears preparedMime first.
    pipeline.repo.transition(doc.id, 'needs_review', 'failed', { error: 'x', preparedMime: null });
    pipeline.inbox.put(doc.id, 'original', new TextEncoder().encode('statement'));
    expect((await post('retry')).status).toBe(200);
    await pipeline.worker.wake(); // the prepare stage awaits its tools: let the drain finish
    // Retry resumes at `preparing` (the failure may have cost the text layer
    // or the thumbnail), so preparedMime is recorded; the worker then decides
    // at once, keeping the restore's recorded reason: review again.
    expect(pipeline.repo.get(doc.id)).toMatchObject({
      state: 'needs_review',
      preparedMime: 'application/pdf',
      reviewReason: 'restored after discard',
      error: null,
      attempts: 0,
    });
  });

  it('serves folders (minus never-file-here) and settings', async () => {
    const { app, cookie, pipeline } = await setup();
    expect((await app.request('/api/folders', { headers: { cookie } })).status).toBe(503);
    pipeline.folderCache.save(TREE, new Date());
    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ excludePaths: ['/Archive'] }),
    });
    expect(put.status).toBe(200);
    const folders = (await (await app.request('/api/folders', { headers: { cookie } })).json()) as { folders: { path: string }[] };
    expect(folders.folders.map((f) => f.path)).toEqual(['/', '/Bills']);
    // Unauthenticated refresh is refused by the guard; a logged-in one is
    // tested under 'folder refresh' with a fake walk.
    expect((await app.request('/api/folders/refresh', { method: 'POST' })).status).toBe(401);
    const bad = await app.request('/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoFileThreshold: 7 }),
    });
    expect(bad.status).toBe(400);
    const putThreshold = (autoFileThreshold: number) =>
      app.request('/api/settings', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ autoFileThreshold }),
      });
    expect((await putThreshold(0.3)).status).toBe(400);
    expect((await putThreshold(0.5)).status).toBe(200);
    expect((await putThreshold(1)).status).toBe(200);
  });
});

type App = Awaited<ReturnType<typeof setup>>['app'];

/** A document waiting in review with the harness's analysis. */
function inReview(pipeline: Pipeline, sha256 = 'r') {
  const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256, sourceContext: null });
  // Prepared, as every analysed document in review has been.
  pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS, preparedMime: 'application/pdf' });
  return doc;
}

function approve(app: App, cookie: string, id: string, body?: string) {
  return app.request(`/api/documents/${id}/approve`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
}

async function pdfPages(sizes: number[], opts: { encrypt?: boolean } = {}): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const s of sizes) d.addPage([s, s]);
  if (opts.encrypt) d.encrypt({ ownerPassword: 'o', userPassword: '' });
  return d.save();
}

/** A PDF in review with its original in the inbox (no prepared blob unless a test adds one). */
async function reviewPdf(pipeline: Pipeline, sha256: string, sizes: number[] = [100], over: DocumentPatch = {}, bytes?: Uint8Array) {
  const body = bytes ?? (await pdfPages(sizes));
  const doc = pipeline.repo.insert({ source: 'scanner', originalName: `${sha256}.pdf`, mime: 'application/pdf', size: body.length, sha256, sourceContext: null });
  pipeline.inbox.put(doc.id, 'original', body);
  pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS, preparedMime: 'application/pdf', ...over });
  return doc;
}

const widthsOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));

function combineReq(app: App, cookie: string, ids: unknown) {
  return app.request('/api/documents/combine', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
}

describe('approve', () => {
  it('404s an unknown document and 409s one not in review', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    expect((await approve(app, cookie, 'nope')).status).toBe(404);
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'q', sourceContext: null });
    expect((await approve(app, cookie, doc.id)).status).toBe(409);
  });

  it('503s while no folder tree has been walked', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = inReview(pipeline);
    expect((await approve(app, cookie, doc.id)).status).toBe(503);
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('approves as suggested with an empty body, without marking it edited', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = inReview(pipeline);
    expect((await approve(app, cookie, doc.id, '  ')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)).toMatchObject({ userEdited: false, decision: { name: ANALYSIS.name, folder: ANALYSIS.folder } });
  });

  it('rejects a malformed body instead of approving as suggested', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = inReview(pipeline);
    const res = await approve(app, cookie, doc.id, '{"name": "Northwind');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_input' });
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('files into a new folder under a known parent, and rejects an unknown parent', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = inReview(pipeline);
    const unknown = await approve(app, cookie, doc.id, JSON.stringify({ folder: { kind: 'new', parentLinkId: 'NOPE', name: 'Water' } }));
    expect(unknown.status).toBe(400);
    const res = await approve(app, cookie, doc.id, JSON.stringify({ folder: { kind: 'new', parentLinkId: 'BILLS', name: 'Water' } }));
    expect(res.status).toBe(200);
    expect(pipeline.repo.get(doc.id)).toMatchObject({
      userEdited: true,
      decision: { folder: { kind: 'new', parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water' } },
    });
  });

  it('uses the current path of a suggested folder that moved since the analysis', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(
      TREE.map((f) => (f.linkId === 'BILLS' ? { ...f, path: '/Household/Bills' } : f)),
      new Date(),
    );
    const doc = inReview(pipeline);
    expect((await approve(app, cookie, doc.id)).status).toBe(200);
    expect(pipeline.repo.get(doc.id)).toMatchObject({
      userEdited: false,
      decision: { folder: { kind: 'existing', linkId: 'BILLS', path: '/Household/Bills' } },
    });
  });

  it('rejects approving as suggested when the suggested folder is gone', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE.filter((f) => f.linkId !== 'BILLS'), new Date());
    const doc = inReview(pipeline);
    const res = await approve(app, cookie, doc.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_folder' });
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('rejects a new folder name that sanitises to nothing', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = inReview(pipeline);
    const res = await approve(app, cookie, doc.id, JSON.stringify({ folder: { kind: 'new', parentLinkId: 'BILLS', name: '...' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_folder_name' });
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('refuses an as-suggested approval into a folder now on the never-file-here list, but allows an explicit pick', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    pipeline.settings.update({ excludePaths: ['/Bills'] });
    const doc = inReview(pipeline);
    const res = await approve(app, cookie, doc.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'excluded_folder' });
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
    // The user chose it themselves: that overrides the list.
    expect((await approve(app, cookie, doc.id, JSON.stringify({ folder: { kind: 'existing', linkId: 'BILLS' } }))).status).toBe(200);
  });

  it('refuses an as-suggested new folder under a never-file-here folder', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    pipeline.settings.update({ excludePaths: ['/Bills'] });
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'x1', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', {
      analysis: { ...ANALYSIS, folder: { kind: 'new', parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water' } },
    });
    const res = await approve(app, cookie, doc.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'excluded_folder' });
    // A new folder whose own path is excluded is refused too.
    pipeline.settings.update({ excludePaths: ['/Bills/Water'] });
    expect(await (await approve(app, cookie, doc.id)).json()).toEqual({ error: 'excluded_folder' });
    pipeline.settings.update({ excludePaths: ['/Archive'] });
    expect((await approve(app, cookie, doc.id)).status).toBe(200);
  });

  it('checks a suggested new folder against the current tree too', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE.filter((f) => f.linkId !== 'BILLS'), new Date());
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'n', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', {
      analysis: { ...ANALYSIS, folder: { kind: 'new', parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water' } },
    });
    expect((await approve(app, cookie, doc.id)).status).toBe(400);
    pipeline.folderCache.save(TREE.map((f) => (f.linkId === 'BILLS' ? { ...f, path: '/Household/Bills' } : f)), new Date());
    expect((await approve(app, cookie, doc.id)).status).toBe(200);
    expect(pipeline.repo.get(doc.id)?.decision?.folder).toEqual({ kind: 'new', parentLinkId: 'BILLS', parentPath: '/Household/Bills', name: 'Water' });
  });
});

/** A live session whose only Drive call is the folder walk. */
function walking(walkFolderTree: () => Promise<typeof TREE>): () => LiveSession {
  return () => ({ driveClient: { walkFolderTree } }) as unknown as LiveSession;
}

describe('errors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers a failed folder refresh with 502 and logs only the error type', async () => {
    const secret = '/Private/Northwind Energy';
    const { app, cookie, pipeline } = await setup({ liveSession: walking(async () => Promise.reject(new TypeError(secret))) });
    const log = vi.spyOn(logger, 'error');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request('/api/folders/refresh', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'refresh_failed' });
    expect(pipeline.folderCache.load()).toBeNull();
    expect(log).toHaveBeenCalledWith({ errName: 'TypeError' }, expect.any(String));
    expect(JSON.stringify([log.mock.calls, consoleError.mock.calls])).not.toContain('Northwind');
  });

  it('answers an unhandled route error with a bare 500 and logs only its type', async () => {
    const { app, cookie, pipeline } = await setup();
    vi.spyOn(pipeline.settings, 'get').mockImplementation(() => {
      throw new RangeError('/Private/Northwind Energy');
    });
    const log = vi.spyOn(logger, 'error');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request('/api/settings', { headers: { cookie } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalledWith({ errName: 'RangeError', method: 'GET', route: '/api/settings' }, expect.any(String));
    expect(consoleError).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('Northwind');
  });
});

describe('intake', () => {
  function send(app: App, cookie: string, file: File, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('source', 'picker');
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return app.request('/api/documents', { method: 'POST', body: fd, headers: { cookie } });
  }

  it('re-uploading a failed document resets and retries it, restoring a lost original', async () => {
    const { app, cookie, pipeline } = await setup();
    const { id } = (await (await upload(app, cookie)).json()) as { id: string };
    expect(pipeline.repo.transition(id, 'received', 'failed', { attempts: 3, error: 'boom' })).toBe(true);
    pipeline.inbox.deleteAll(id);
    const again = await upload(app, cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, duplicate: true });
    expect(pipeline.inbox.has(id, 'original')).toBe(true);
    expect(pipeline.inbox.get(id, 'original').toString()).toBe('statement');
    // No analysis yet, so it restarts at `received`; with no folder tree the
    // worker parks it there at once.
    expect(pipeline.repo.get(id)).toMatchObject({ state: 'received', attempts: 0, error: null });
  });

  it('re-uploading a failed, analysed document prepares it again', async () => {
    const { app, cookie, pipeline } = await setup();
    const { id } = (await (await upload(app, cookie)).json()) as { id: string };
    expect(pipeline.repo.transition(id, 'received', 'failed', { analysis: ANALYSIS, attempts: 3, error: 'boom' })).toBe(true);
    const again = await upload(app, cookie);
    expect(await again.json()).toEqual({ id, duplicate: true });
    await pipeline.worker.wake(); // let the drain finish
    // Restarted at `preparing`, which records preparedMime; then decided, and
    // with auto-filing off that means review.
    expect(pipeline.repo.get(id)).toMatchObject({
      state: 'needs_review',
      preparedMime: 'text/plain',
      reviewReason: 'auto-filing is off',
      attempts: 0,
      error: null,
    });
  });

  it('re-uploading a document with a pending discard keeps it', async () => {
    const { app, cookie, pipeline } = await setup();
    const { id } = (await (await upload(app, cookie)).json()) as { id: string };
    pipeline.repo.transition(id, 'received', 'analyzing');
    expect(pipeline.repo.requestDiscard(id)).toBe('requested');
    const again = await upload(app, cookie);
    expect(await again.json()).toEqual({ id, duplicate: true });
    expect(pipeline.repo.get(id)).toMatchObject({ state: 'analyzing', discardRequested: false });
  });

  it('strips control characters from arrival metadata and caps its length', async () => {
    const { app, cookie, pipeline } = await setup();
    const res = await send(app, cookie, new File(['Northwind'], 'x.txt', { type: 'text/plain' }), {
      originalName: `Northwind\r\nEnergy\u0000bill ${'a'.repeat(300)}.pdf`,
      sourceContext: `Forwarded by\tNorthwind\u2028${'b'.repeat(3000)}`,
    });
    const { id } = (await res.json()) as { id: string };
    const doc = pipeline.repo.get(id)!;
    // The stem is cut, not the extension.
    expect(doc.originalName).toMatch(/^Northwind Energy bill a+\.pdf$/);
    expect(doc.originalName).toHaveLength(255);
    expect(doc.sourceContext).toMatch(/^Forwarded by Northwind b+$/);
    expect(doc.sourceContext).toHaveLength(2000);
  });

  it('strips bidi controls but keeps emoji joined with ZWJ', async () => {
    const { app, cookie, pipeline } = await setup();
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const res = await send(app, cookie, new File(['Northwind'], 'x.txt', { type: 'text/plain' }), {
      originalName: `Northwind\u202Efdp.exe ${family}.pdf`,
      sourceContext: `\u2066Forwarded\u2069 by Northwind`,
    });
    const { id } = (await res.json()) as { id: string };
    expect(pipeline.repo.get(id)).toMatchObject({
      originalName: `Northwindfdp.exe ${family}.pdf`,
      sourceContext: 'Forwarded by Northwind',
    });
  });

  it('caps a name without a short extension by plain truncation', async () => {
    const { app, cookie, pipeline } = await setup();
    const res = await send(app, cookie, new File(['Northwind'], 'x.txt', { type: 'text/plain' }), {
      originalName: `Northwind.${'c'.repeat(300)}`,
    });
    const { id } = (await res.json()) as { id: string };
    const name = pipeline.repo.get(id)!.originalName!;
    expect(name).toHaveLength(255);
    expect(name.startsWith('Northwind.ccc')).toBe(true);
  });

  it('types a bare blob by the original name sent with it', async () => {
    const { app, cookie, pipeline } = await setup();
    const fd = new FormData();
    fd.append('file', new Blob(['Northwind'])); // arrives named "blob", with no type
    fd.append('source', 'share');
    fd.append('originalName', 'statement.docx');
    const res = await app.request('/api/documents', { method: 'POST', body: fd, headers: { cookie } });
    const { id } = (await res.json()) as { id: string };
    expect(pipeline.repo.get(id)).toMatchObject({
      originalName: 'statement.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('falls back to the file name when the given name is only control characters', async () => {
    const { app, cookie, pipeline } = await setup();
    const res = await send(app, cookie, new File(['Northwind'], 'Northwind bill.txt', { type: 'text/plain' }), { originalName: '\n\t', sourceContext: '\u0007' });
    const { id } = (await res.json()) as { id: string };
    expect(pipeline.repo.get(id)).toMatchObject({ originalName: 'Northwind bill.txt', sourceContext: null });
  });

  it('stores the bare, lowercased MIME type', async () => {
    const { app, cookie, pipeline } = await setup();
    const res = await send(app, cookie, new File(['Northwind'], 'note.txt', { type: 'text/plain;charset=utf-8' }));
    const { id } = (await res.json()) as { id: string };
    expect(pipeline.repo.get(id)?.mime).toBe('text/plain');
  });

  it('works out a missing MIME type from the file name', async () => {
    const { app, cookie, pipeline } = await setup();
    const res = await send(app, cookie, new File(['not really a pdf'], 'statement.pdf', { type: '' }));
    const { id } = (await res.json()) as { id: string };
    expect(pipeline.repo.get(id)?.mime).toBe('application/pdf');
  });
});

describe('restore and retry', () => {
  it('warns that a quarantined filing may be in Drive, and still retries it', async () => {
    const { app, pipeline, cookie, db } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'q', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'filing', {
      analysis: ANALYSIS,
      decision: { name: ANALYSIS.name, folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } },
      filingTarget: { folderLinkId: 'BILLS', name: 'x.pdf' },
    });
    // As after a key change: the sealed decision no longer opens.
    db.prepare('UPDATE documents SET decision = ? WHERE id = ?').run(new Uint8Array(40), doc.id);
    const view = (await (await app.request(`/api/documents/${doc.id}`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ state: 'failed', possiblyInDrive: true, decision: null });
    expect(view.error).toContain('check Drive before retrying');
    const retried = await app.request(`/api/documents/${doc.id}/retry`, { method: 'POST', headers: { cookie } });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ state: 'received', possiblyInDrive: true });
  });

  const post = (app: App, cookie: string, id: string, action: string) =>
    app.request(`/api/documents/${id}/${action}`, { method: 'POST', headers: { cookie } });

  it('404 an unknown document', async () => {
    const { app, cookie } = await setup();
    for (const action of ['restore', 'retry']) {
      const res = await post(app, cookie, 'nope', action);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('restores into review with a fresh slate', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = inReview(pipeline);
    pipeline.repo.transition(doc.id, 'needs_review', 'failed', { error: 'boom', attempts: 3 });
    expect((await post(app, cookie, doc.id, 'discard')).status).toBe(200);
    expect((await post(app, cookie, doc.id, 'restore')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'restored after discard', error: null, attempts: 0 });
  });

  it('prepares a document restored after a discard won during preparing, then sends it to review', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 9, sha256: 'p1', sourceContext: null });
    pipeline.inbox.put(doc.id, 'original', new TextEncoder().encode('%PDF- scan'));
    pipeline.repo.transition(doc.id, 'received', 'preparing', { analysis: ANALYSIS });
    expect(pipeline.repo.requestDiscard(doc.id)).toBe('requested');
    expect(pipeline.repo.applyRequestedDiscard(doc.id)).toBe(true); // the discard won: nothing prepared
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'discarded', preparedMime: null });
    const res = await post(app, cookie, doc.id, 'restore');
    expect(res.status).toBe(200);
    await pipeline.worker.wake(); // let the drain finish
    expect(pipeline.repo.get(doc.id)).toMatchObject({
      state: 'needs_review',
      preparedMime: 'application/pdf',
      reviewReason: 'restored after discard',
    });
  });

  it('restores a document that was already prepared straight into review', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = inReview(pipeline, 'p2');
    pipeline.repo.transition(doc.id, 'needs_review', 'needs_review', { preparedMime: 'application/pdf' });
    expect((await post(app, cookie, doc.id, 'discard')).status).toBe(200);
    const res = await post(app, cookie, doc.id, 'restore');
    expect(((await res.json()) as { state: string }).state).toBe('needs_review');
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'restored after discard', preparedMime: 'application/pdf' });
  });

  it('restores a document that may already be in Drive into review, as it is', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = inReview(pipeline, 'p3');
    const target = { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' };
    pipeline.repo.transition(doc.id, 'needs_review', 'failed', { filingTarget: target, preparedMime: null, error: 'boom', attempts: 3 });
    expect((await post(app, cookie, doc.id, 'discard')).status).toBe(200);
    expect((await post(app, cookie, doc.id, 'restore')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', preparedMime: null, filingTarget: target });
  });

  it('restores an unanalysed document without a review reason', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 's', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'failed', { error: 'boom', attempts: 3, reviewReason: 'stale' });
    expect((await post(app, cookie, doc.id, 'discard')).status).toBe(200);
    expect((await post(app, cookie, doc.id, 'restore')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'received', reviewReason: null, error: null, attempts: 0 });
  });
});

describe('folder refresh', () => {
  it('walks Drive, caches the tree and analyses what was waiting for it', async () => {
    const { app, cookie, pipeline, analyze } = await setup({ liveSession: walking(async () => TREE) });
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.txt', mime: 'text/plain', size: 9, sha256: 'w', sourceContext: null });
    pipeline.inbox.put(doc.id, 'original', new TextEncoder().encode('Northwind'));
    // Parked as the analyze stage parks it when no tree has been walked.
    pipeline.repo.transition(doc.id, 'received', 'received', { nextAttemptAt: new Date(Date.now() + 3600_000) });
    const res = await app.request('/api/folders/refresh', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(pipeline.folderCache.load()?.tree.map((f) => f.path)).toEqual(TREE.map((f) => f.path));
    expect(analyze).toHaveBeenCalledTimes(1);
    await pipeline.worker.wake(); // let the drain finish before the database closes
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'auto-filing is off' });
  });
});

describe('pipeline', () => {
  it('subscribes to logins once however often it is started', async () => {
    const { pipeline } = await setup();
    const onLogin = vi.spyOn(pipeline.worker, 'onLogin').mockResolvedValue();
    pipeline.start();
    pipeline.start();
    pipeline.stop();
    registerLiveSession({
      sid: 'later',
      session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' },
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
      driveClient: {} as DriveClient,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLogin).not.toHaveBeenCalled();
  });
});

describe('document route edges', () => {
  it('rejects a cursor that is not a whole, non-negative number', async () => {
    const { app, cookie } = await setup();
    for (const since of ['-1', 'abc', '1.5']) {
      const res = await app.request(`/api/documents?since=${since}`, { headers: { cookie } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    }
  });

  it('defers the discard of a working document to the worker, which applies it at once', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'd', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'analyzing');
    const res = await app.request(`/api/documents/${doc.id}/discard`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'requested' });
    expect(pipeline.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('refuses to discard a filed document', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'f', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'filed', { filedName: 'Northwind Energy Sep 2026.pdf', filedFolderPath: '/Bills', driveNodeUid: 'N1' });
    const res = await app.request(`/api/documents/${doc.id}/discard`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_allowed' });
    expect(pipeline.repo.get(doc.id)?.state).toBe('filed');
  });

  it('rejects settings that are not JSON', async () => {
    const { app, cookie, pipeline } = await setup();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{"autoFileEnabled": tr',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_input' });
    expect(pipeline.settings.get().autoFileEnabled).toBe(false);
  });

  it('refuses an upload over the size limit', async () => {
    const { app, cookie, pipeline } = await setup();
    const fd = new FormData();
    // The route's limit is 50 MiB for the whole body.
    fd.append('file', new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }));
    fd.append('source', 'picker');
    const res = await app.request('/api/documents', { method: 'POST', body: fd, headers: { cookie } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(pipeline.repo.listChangedSince(0).rows).toHaveLength(0);
  });
});

describe('thumbnail', () => {
  it('serves the thumbnail blob', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 't1', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', { hasThumbnail: true });
    pipeline.inbox.put(doc.id, 'thumbnail', new Uint8Array([0xff, 0xd8, 1, 2]));
    const res = await app.request(`/api/documents/${doc.id}/thumbnail`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xd8, 1, 2]);
  });

  it('is not found for an unknown id, no thumbnail, a filed document or a missing blob', async () => {
    const { app, cookie, pipeline } = await setup();
    const add = (sha256: string) =>
      pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256, sourceContext: null });
    const none = add('n1');
    const filed = add('n2');
    pipeline.repo.transition(filed.id, 'received', 'filed', { hasThumbnail: true });
    pipeline.inbox.put(filed.id, 'thumbnail', new Uint8Array([1]));
    const blobless = add('n3');
    pipeline.repo.transition(blobless.id, 'received', 'needs_review', { hasThumbnail: true });
    for (const id of ['nope', none.id, filed.id, blobless.id]) {
      const res = await app.request(`/api/documents/${id}/thumbnail`, { headers: { cookie } });
      expect([id, res.status]).toEqual([id, 404]);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });
});

describe('POST /api/documents/combine', () => {
  it('combines the parts in the order given and discards them into the new document', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ca', [100]);
    const b = await reviewPdf(pipeline, 'cb', [200, 210]);
    const res = await combineReq(app, cookie, [b.id, a.id]);
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string };
    expect(view).toMatchObject({ state: 'received', source: 'scanner', originalName: null, mime: 'application/pdf' });
    expect(await widthsOf(pipeline.inbox.get(view.id, 'original'))).toEqual([200, 210, 100]);
    expect(pipeline.repo.get(view.id)?.sourceContext).toBe('combined from 2 documents');
    for (const p of [a, b]) expect(pipeline.repo.get(p.id)).toMatchObject({ state: 'discarded', combinedInto: view.id });
    await pipeline.worker.wake();
  });

  it('uses a part\'s prepared PDF when it has one', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'pa', [100]);
    pipeline.inbox.put(a.id, 'prepared', await pdfPages([300]));
    const b = await reviewPdf(pipeline, 'pb', [150]);
    const res = await combineReq(app, cookie, [a.id, b.id]);
    const view = (await res.json()) as { id: string };
    expect(await widthsOf(pipeline.inbox.get(view.id, 'original'))).toEqual([300, 150]);
    await pipeline.worker.wake();
  });

  it('rejects bad input', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ia');
    for (const ids of [[a.id], [a.id, a.id], Array.from({ length: 11 }, (_, i) => `x${i}`), 'nope']) {
      const res = await combineReq(app, cookie, ids);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_input' });
    }
  });

  it('404s an unknown part and 409s one not in review', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'na');
    expect((await combineReq(app, cookie, [a.id, 'nope'])).status).toBe(404);
    const r = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 1, sha256: 'nr', sourceContext: null });
    const res = await combineReq(app, cookie, [a.id, r.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_in_review' });
  });

  it('refuses a part that may already be in Drive', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'da');
    const b = await reviewPdf(pipeline, 'db', [100], { filingTarget: { folderLinkId: 'BILLS', name: 'x.pdf' } });
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'possibly_in_drive' });
  });

  it('names a part that cannot be combined', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ea');
    const b = await reviewPdf(pipeline, 'eb', [], {}, await pdfPages([100], { encrypt: true }));
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'cannot_combine', documentId: b.id, reason: 'encrypted' });
    expect(pipeline.repo.get(a.id)?.state).toBe('needs_review');
  });

  it('names a part whose blob is gone', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ma');
    const b = await reviewPdf(pipeline, 'mb');
    pipeline.inbox.deleteAll(b.id);
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'cannot_combine', documentId: b.id, reason: 'unreadable' });
    expect(pipeline.repo.get(a.id)?.state).toBe('needs_review');
    expect(pipeline.repo.get(b.id)?.state).toBe('needs_review');
  });

  it('refuses parts too large together before reading them', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'la');
    const big = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 50 * 1024 * 1024, sha256: 'lb', sourceContext: null });
    pipeline.repo.transition(big.id, 'received', 'needs_review', { analysis: ANALYSIS });
    const get = vi.spyOn(pipeline.inbox, 'get');
    const res = await combineReq(app, cookie, [a.id, big.id]);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'cannot_combine', reason: 'too_large' });
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves no blob behind when a part moved on meanwhile', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ra');
    const b = await reviewPdf(pipeline, 'rb');
    vi.spyOn(pipeline.repo, 'insertCombined').mockReturnValue(null);
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
    expect(pipeline.inbox.listIds().sort()).toEqual([a.id, b.id].sort());
  });

  it('409s a part with a discard pending, before building', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'pda');
    const b = await reviewPdf(pipeline, 'pdb', [100], { discardRequested: true });
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_in_review' });
  });

  it('removes the new blob and answers 500 when the insert throws', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'xa');
    const b = await reviewPdf(pipeline, 'xb');
    vi.spyOn(pipeline.repo, 'insertCombined').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(500);
    expect(pipeline.inbox.listIds().sort()).toEqual([a.id, b.id].sort());
  });

  it('restoring a part puts it back in review and forgets what it was combined into', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'sa');
    const b = await reviewPdf(pipeline, 'sb');
    await combineReq(app, cookie, [a.id, b.id]);
    const res = await app.request(`/api/documents/${a.id}/restore`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(pipeline.repo.get(a.id)).toMatchObject({ state: 'needs_review', combinedInto: null });
    await pipeline.worker.wake();
  });
});

function reanalyzeReq(app: App, cookie: string, id: string, body?: unknown) {
  return app.request(`/api/documents/${id}/reanalyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function filedLetter(pipeline: Pipeline) {
  const doc = pipeline.repo.insert({ source: 'scanner', originalName: 'letter.pdf', mime: 'application/pdf', size: 1, sha256: 'letter', sourceContext: null });
  pipeline.repo.transition(doc.id, 'received', 'filed', {
    analysis: ANALYSIS,
    filingTarget: { folderLinkId: 'BILLS', name: 'Certified letter to Northwind.pdf' },
    filedName: 'Certified letter to Northwind.pdf',
    filedFolderPath: '/Bills',
    driveNodeUid: 'N1',
  });
  return doc;
}

describe('POST /api/documents/:id/reanalyze', () => {
  it('analyses a document in review again from scratch, and reviews the result', async () => {
    const { app, cookie, pipeline, analyze } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = await reviewPdf(pipeline, 'plain', [100], {
      decision: { name: 'x', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } },
      userEdited: true,
      hasThumbnail: true,
      prepareNote: 'x',
      autoFiled: true,
    });
    const res = await reanalyzeReq(app, cookie, doc.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'received', analysis: null, decision: null, anchorName: null, hasThumbnail: false, prepareNote: null, autoFiled: false });
    await pipeline.worker.wake();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reanalyzed: true, reviewReason: 'requested from review', userEdited: false });
  });

  it('files a document with a filed one: same folder, paired name asked for', async () => {
    const { app, cookie, pipeline, analyze } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const letter = filedLetter(pipeline);
    const receipt = await reviewPdf(pipeline, 'receipt');
    analyze.mockResolvedValue(okOutcome({ ...ANALYSIS, name: 'Certified letter to Northwind - return receipt', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } }));
    const res = await reanalyzeReq(app, cookie, receipt.id, { anchorId: letter.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'received', anchorName: 'Certified letter to Northwind' });
    await pipeline.worker.wake();
    expect(analyze.mock.calls.at(-1)![0].anchor).toEqual({ name: 'Certified letter to Northwind', folderPath: '/Bills' });
    expect(pipeline.repo.get(receipt.id)).toMatchObject({
      state: 'needs_review',
      reviewReason: 'filed with another document',
      analysis: { name: 'Certified letter to Northwind - return receipt', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } },
    });
  });

  it('files a document with another in review, using its current proposal', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const letter = await reviewPdf(pipeline, 'rl');
    const receipt = await reviewPdf(pipeline, 'rr');
    const res = await reanalyzeReq(app, cookie, receipt.id, { anchorId: letter.id });
    expect(await res.json()).toMatchObject({ anchorName: ANALYSIS.name });
    expect(pipeline.repo.get(receipt.id)?.anchor).toEqual({ documentId: letter.id, name: ANALYSIS.name, folder: ANALYSIS.folder });
    await pipeline.worker.wake();
    expect(pipeline.repo.get(receipt.id)).toMatchObject({ reviewReason: 'filed with another document', analysis: { folder: ANALYSIS.folder } });
  });

  it('refuses an anchor that cannot be one', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = await reviewPdf(pipeline, 'ia');
    const noFolder = await reviewPdf(pipeline, 'ib', [100], { analysis: { ...ANALYSIS, folder: null } });
    const waiting = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 1, sha256: 'ic', sourceContext: null });
    for (const anchorId of [doc.id, noFolder.id, waiting.id, 'nope']) {
      const res = await reanalyzeReq(app, cookie, doc.id, { anchorId });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'invalid_anchor' });
    }
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('refuses a document not in review, or one that may already be in Drive', async () => {
    const { app, cookie, pipeline } = await setup();
    const waiting = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 1, sha256: 'na', sourceContext: null });
    expect(await (await reanalyzeReq(app, cookie, waiting.id)).json()).toEqual({ error: 'not_in_review' });
    const sent = await reviewPdf(pipeline, 'nb', [100], { filingTarget: { folderLinkId: 'BILLS', name: 'x.pdf' } });
    const res = await reanalyzeReq(app, cookie, sent.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'possibly_in_drive' });
    expect((await reanalyzeReq(app, cookie, 'nope')).status).toBe(404);
  });

  it('rejects a malformed body', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = await reviewPdf(pipeline, 'mb');
    for (const body of [{ anchorId: 5 }, { anchorId: '' }, { other: 1 }]) {
      const res = await reanalyzeReq(app, cookie, doc.id, body);
      expect(res.status).toBe(400);
    }
    const truncated = await app.request(`/api/documents/${doc.id}/reanalyze`, { method: 'POST', headers: { cookie }, body: '{"anchorId":' });
    expect(truncated.status).toBe(400);
  });

  it('can be approved as suggested once re-analysed with a filed document', async () => {
    const { app, cookie, pipeline, analyze } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const letter = filedLetter(pipeline);
    const receipt = await reviewPdf(pipeline, 'e2e');
    analyze.mockResolvedValue(okOutcome({ ...ANALYSIS, name: 'Return receipt', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } }));
    expect((await reanalyzeReq(app, cookie, receipt.id, { anchorId: letter.id })).status).toBe(200);
    await pipeline.worker.wake();
    expect(pipeline.repo.get(receipt.id)?.state).toBe('needs_review');
    const res = await app.request(`/api/documents/${receipt.id}/approve`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(pipeline.repo.get(receipt.id)).toMatchObject({
      decision: { name: 'Return receipt', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } },
      userEdited: false,
    });
  });
});

describe('header mode', () => {
  it('signs every router in by the proxy user', async () => {
    const { db, cleanup } = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'routes-docs-'));
    cleanups.push(cleanup, () => rmSync(dir, { recursive: true, force: true }));
    const pipeline = createPipeline({
      db,
      dataDir: dir,
      encryptionKey: KEY,
      defaults: { model: 'm', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
      analyzerFor: () => ({ analyze: vi.fn() }),
      liveSession: () => undefined,
      prepare: fakePrepare(),
    });
    const app = createApp({ db, encryptionKey: KEY, pipeline, authMode: { kind: 'header', user: 'owine', secret: null } });
    for (const path of ['/api/documents?since=0', '/api/settings', '/api/auth/status']) {
      expect([path, (await app.request(path, { headers: { 'Remote-User': 'owine' } })).status]).toEqual([path, 200]);
      expect([path, (await app.request(path)).status]).toEqual([path, 401]);
    }
  });
});
