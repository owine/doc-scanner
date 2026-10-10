import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { InboxStore, InboxBlobMissingError } from '../../src/documents/inbox-store.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store() {
  dir = mkdtempSync(join(tmpdir(), 'inbox-test-'));
  return new InboxStore(dir, new AtRestCipher(Buffer.alloc(32, 3).toString('base64'), 'inbox'));
}

describe('InboxStore', () => {
  it('round-trips bytes per document and kind', () => {
    const s = store();
    s.put('doc1', 'original', new TextEncoder().encode('original bytes'));
    s.put('doc1', 'prepared', new TextEncoder().encode('prepared bytes'));
    expect(new TextDecoder().decode(s.get('doc1', 'original'))).toBe('original bytes');
    expect(new TextDecoder().decode(s.get('doc1', 'prepared'))).toBe('prepared bytes');
  });

  it('never writes plaintext to disk', () => {
    const s = store();
    s.put('doc1', 'original', new TextEncoder().encode('SECRET-MARKER'));
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes('SECRET-MARKER')).toBe(false);
  });

  it('deletes every blob of a document', () => {
    const s = store();
    s.put('doc1', 'original', new Uint8Array([1]));
    s.put('doc1', 'prepared', new Uint8Array([2]));
    s.deleteAll('doc1');
    expect(readdirSync(dir)).toEqual([]);
    expect(s.has('doc1', 'original')).toBe(false);
  });

  it('rejects ids that could escape the directory', () => {
    expect(() => store().put('../x', 'original', new Uint8Array([1]))).toThrow(/invalid document id/);
  });

  it('reports has() after put and removes all three kinds', () => {
    const s = store();
    expect(s.has('doc1', 'original')).toBe(false);
    for (const k of ['original', 'prepared', 'thumbnail'] as const) {
      s.put('doc1', k, new Uint8Array([1]));
      expect(s.has('doc1', k)).toBe(true);
    }
    s.deleteAll('doc1');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes stray temp files on deleteAll and on construction', () => {
    const s = store();
    writeFileSync(join(dir, 'doc1.original.bin.tmp'), 'x');
    s.deleteAll('doc1');
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, 'doc2.prepared.bin.tmp'), 'x');
    new InboxStore(dir, new AtRestCipher(Buffer.alloc(32, 3).toString('base64'), 'inbox'));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('throws InboxBlobMissingError without a path for a missing blob', () => {
    const s = store();
    let err: unknown;
    try {
      s.get('nope', 'original');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InboxBlobMissingError);
    expect((err as Error).message).not.toContain('/');
  });

  it('overwrites an existing blob', () => {
    const s = store();
    s.put('doc1', 'original', new TextEncoder().encode('one'));
    s.put('doc1', 'original', new TextEncoder().encode('two'));
    expect(new TextDecoder().decode(s.get('doc1', 'original'))).toBe('two');
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('lists each document id once and ignores stray files', () => {
    const s = store();
    s.put('doc1', 'original', new Uint8Array([1]));
    s.put('doc1', 'prepared', new Uint8Array([1]));
    s.put('doc2', 'thumbnail', new Uint8Array([1]));
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'doc3.weird.bin'), 'x');
    expect(s.listIds().sort()).toEqual(['doc1', 'doc2']);
  });

  it.each(['', '..', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(65)])('rejects invalid id %j everywhere', (id) => {
    const s = store();
    expect(() => s.put(id, 'original', new Uint8Array([1]))).toThrow(/invalid document id/);
    expect(() => s.get(id, 'original')).toThrow(/invalid document id/);
    expect(() => s.has(id, 'original')).toThrow(/invalid document id/);
    expect(() => s.deleteAll(id)).toThrow(/invalid document id/);
  });

  it.skipIf(process.platform === 'win32')('writes files owner-only', () => {
    const s = store();
    s.put('doc1', 'original', new Uint8Array([1]));
    expect(statSync(join(dir, 'doc1.original.bin')).mode & 0o777).toBe(0o600);
  });
});
