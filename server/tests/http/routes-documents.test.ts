import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { createPipeline, type Pipeline } from '../../src/documents/pipeline.js';
import { ANALYSIS, TREE, okOutcome } from '../documents/harness.js';

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

async function setup() {
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
    liveSession: () => undefined,
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
  it('requires a login', async () => {
    const { app } = await setup();
    expect((await app.request('/api/documents')).status).toBe(401);
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
    // Unauthenticated refresh is refused by the guard. (A logged-in refresh
    // would walk the real Drive, so it is exercised in Task 18, not here.)
    expect((await app.request('/api/folders/refresh', { method: 'POST' })).status).toBe(401);
    const bad = await app.request('/api/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoFileThreshold: 7 }),
    });
    expect(bad.status).toBe(400);
  });
});
