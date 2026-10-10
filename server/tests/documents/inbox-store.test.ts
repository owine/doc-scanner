import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { InboxStore } from '../../src/documents/inbox-store.js';

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
});
