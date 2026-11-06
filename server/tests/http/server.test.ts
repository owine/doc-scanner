import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function app() {
  const t = createTestDb();
  const dist = mkdtempSync(join(tmpdir(), 'pwa-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>doc-scanner</title>');
  writeFileSync(join(dist, 'app.js'), 'console.log(1)');
  cleanups.push(t.cleanup, () => rmSync(dist, { recursive: true, force: true }));
  return createApp({ db: t.db, encryptionKey: KEY, pwaDistPath: dist });
}

describe('createApp', () => {
  it.each([
    ['the app shell', 'GET', '/', 200],
    ['a static file', 'GET', '/app.js', 200],
    ['the index fallback', 'GET', '/inbox/some-route', 200],
    ['an API answer', 'GET', '/api/health', 200],
    ['a refused API request', 'POST', '/api/drive/test-upload', 401],
  ])('forbids framing %s', async (_label, method, path, status) => {
    const res = await app().request(path, { method });
    expect(res.status).toBe(status);
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
