import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession, type LiveSession } from '../../src/auth/live-session.js';
import type { DriveClient } from '../../src/drive/client.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { createPipeline, type Pipeline } from '../../src/documents/pipeline.js';
import { ANALYSIS, TREE, okOutcome } from '../documents/harness.js';
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
  return { app, pipeline, cookie, analyze };
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
      ['POST', '/api/documents/some-id/approve'],
      ['POST', '/api/documents/some-id/discard'],
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
    pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS });
    const post = (path: string) => app.request(`/api/documents/${doc.id}/${path}`, { method: 'POST', headers: { cookie } });
    expect((await post('discard')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)?.state).toBe('discarded');
    expect((await post('restore')).status).toBe(200);
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
    pipeline.repo.transition(doc.id, 'needs_review', 'failed', { error: 'x' });
    expect((await post('retry')).status).toBe(200);
    // Retry resumes at `ready`; the worker then decides at once, and with
    // auto-filing off that means review again.
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'auto-filing is off', error: null, attempts: 0 });
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
  });
});

type App = Awaited<ReturnType<typeof setup>>['app'];

/** A document waiting in review with the harness's analysis. */
function inReview(pipeline: Pipeline, sha256 = 'r') {
  const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256, sourceContext: null });
  pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS });
  return doc;
}

function approve(app: App, cookie: string, id: string, body?: string) {
  return app.request(`/api/documents/${id}/approve`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
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
    expect(pipeline.repo.listChangedSince(0)).toHaveLength(0);
  });
});
