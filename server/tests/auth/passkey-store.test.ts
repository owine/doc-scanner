import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { createTestDb } from '../helpers/test-db.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { PasskeyStore, decodeBase64url } from '../../src/auth/passkey-store.js';
import { logger } from '../../src/logger.js';
import type { DB } from '../../src/db.js';

const KEY = Buffer.alloc(32, 5).toString('base64');
const ID = 'cred-AAAAAAAAAAAAAAAA';
const OTHER = 'cred-BBBBBBBBBBBBBBBB';
const PRF = new Uint8Array(32).fill(7);
const SALT = new Uint8Array(32).fill(3);
const PASS = 'mailbox-passphrase-Northwind';
const LABEL = 'Northwind phone';
const NOW = new Date('2026-10-13T10:00:00.000Z');

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  vi.restoreAllMocks();
});

function setup(): { s: PasskeyStore; db: DB } {
  const t = createTestDb();
  cleanup = t.cleanup;
  return { s: new PasskeyStore(t.db, new AtRestCipher(KEY, 'passkeys'), () => NOW), db: t.db };
}

const add = (s: PasskeyStore, credentialId = ID, prf: Uint8Array = PRF, salt: Uint8Array = SALT) =>
  s.add({ credentialId, label: LABEL, salt, prf, passphrase: new TextEncoder().encode(PASS) });

const text = (r: unknown) => (r instanceof Uint8Array ? new TextDecoder().decode(r) : r);

describe('PasskeyStore', () => {
  it('unwraps the passphrase with the right PRF output', () => {
    const { s } = setup();
    add(s);
    expect(text(s.unwrap(ID, PRF))).toBe(PASS);
  });

  it('follows the spec: HKDF(prf, salt) inside, the passkeys cipher outside, both bound to the id', () => {
    const { s, db } = setup();
    add(s);
    const row = db.prepare('SELECT wrapped FROM passkey_unlocks WHERE credential_id = ?').get(ID) as { wrapped: Uint8Array };
    const inner = new AtRestCipher(KEY, 'passkeys').open(row.wrapped, Buffer.from(ID));
    const key = Buffer.from(hkdfSync('sha256', PRF, SALT, 'docscanner-passkey-unlock', 32));
    const decipher = createDecipheriv('aes-256-gcm', key, inner.subarray(0, 12));
    decipher.setAuthTag(inner.subarray(12, 28));
    decipher.setAAD(Buffer.from(ID));
    expect(Buffer.concat([decipher.update(inner.subarray(28)), decipher.final()]).toString('utf8')).toBe(PASS);
  });

  it('answers wrong_secret for another PRF output, and keeps the row', () => {
    const { s } = setup();
    add(s);
    expect(s.unwrap(ID, new Uint8Array(32).fill(8))).toBe('wrong_secret');
    expect(s.count()).toBe(1);
  });

  it('answers unknown for an id it does not have', () => {
    const { s } = setup();
    expect(s.unwrap(ID, PRF)).toBe('unknown');
  });

  it('answers unreadable when the outer layer will not open, and removes only that row', () => {
    const { s, db } = setup();
    add(s);
    add(s, OTHER);
    const warn = vi.spyOn(logger, 'warn');
    db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(new Uint8Array(60), ID);
    expect(s.unwrap(ID, PRF)).toBe('unreadable');
    expect(s.list().map((p) => p.credentialId)).toEqual([OTHER]);
    expect(warn).toHaveBeenCalledWith({ credential: 'cred-AAA' }, 'passkey unlock unreadable; removed');
  });

  it('binds a wrap to its credential id', () => {
    const { s, db } = setup();
    add(s);
    add(s, OTHER);
    const { wrapped } = db.prepare('SELECT wrapped FROM passkey_unlocks WHERE credential_id = ?').get(ID) as { wrapped: Uint8Array };
    db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(wrapped, OTHER);
    expect(s.unwrap(OTHER, PRF)).toBe('unreadable');
  });

  it('seals the label: the raw row holds neither the label nor the passphrase', () => {
    const { s, db } = setup();
    add(s);
    const row = db.prepare('SELECT * FROM passkey_unlocks').get() as Record<string, unknown>;
    for (const value of Object.values(row)) {
      const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
      expect(bytes.includes(Buffer.from(LABEL))).toBe(false);
      expect(bytes.includes(Buffer.from(PASS))).toBe(false);
    }
    expect(s.list()[0]?.label).toBe(LABEL);
  });

  it('lists each passkey with its dates, and touch records the last use', () => {
    const { s } = setup();
    expect(add(s)).toEqual({ credentialId: ID, label: LABEL, createdAt: NOW.toISOString(), lastUsedAt: null });
    expect(s.list()).toEqual([{ credentialId: ID, label: LABEL, createdAt: NOW.toISOString(), lastUsedAt: null }]);
    s.touch(ID);
    expect(s.list()[0]?.lastUsedAt).toBe(NOW.toISOString());
  });

  it('lists every id with its salt', () => {
    const { s } = setup();
    add(s);
    expect(s.saltsFor().map((p) => ({ id: p.credentialId, salt: Array.from(p.salt) }))).toEqual([{ id: ID, salt: Array.from(SALT) }]);
  });

  it('removes one, or all of them', () => {
    const { s } = setup();
    add(s);
    expect(s.remove(ID)).toBe(true);
    expect(s.remove(ID)).toBe(false);
    add(s);
    add(s, OTHER);
    expect(s.removeAll()).toBe(2);
    expect(s.count()).toBe(0);
  });

  it('replaces the wrap when the same credential is added again', () => {
    const { s } = setup();
    add(s);
    const prf2 = new Uint8Array(32).fill(9);
    add(s, ID, prf2, new Uint8Array(32).fill(4));
    expect(s.count()).toBe(1);
    expect(text(s.unwrap(ID, prf2))).toBe(PASS);
  });
});

describe('PasskeyStore input checks', () => {
  it('refuses a PRF output or salt that is not 32 bytes, or a malformed credential id', () => {
    const { s } = setup();
    expect(() => add(s, ID, new Uint8Array(0))).toThrow('invalid passkey entry');
    expect(() => add(s, ID, new Uint8Array(31))).toThrow('invalid passkey entry');
    expect(() => add(s, ID, PRF, new Uint8Array(16))).toThrow('invalid passkey entry');
    expect(() => add(s, 'short')).toThrow('invalid passkey entry');
    expect(() => add(s, 'has spaces and is long enough')).toThrow('invalid passkey entry');
    expect(s.count()).toBe(0);
  });

  it('answers wrong_secret for a PRF output of the wrong length, even an empty one', () => {
    const { s } = setup();
    add(s);
    expect(s.unwrap(ID, new Uint8Array(0))).toBe('wrong_secret');
    expect(s.unwrap(ID, new Uint8Array(31))).toBe('wrong_secret');
    expect(s.count()).toBe(1);
  });

  it('answers unreadable when the store is opened with a different env key', () => {
    const { s, db } = setup();
    add(s);
    const other = new PasskeyStore(db, new AtRestCipher(Buffer.alloc(32, 6).toString('base64'), 'passkeys'), () => NOW);
    expect(other.unwrap(ID, PRF)).toBe('unreadable');
    expect(other.count()).toBe(0);
  });

  it('answers unreadable for an outer blob shorter than 28 bytes', () => {
    const { s, db } = setup();
    add(s);
    db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(new Uint8Array(10), ID);
    expect(s.unwrap(ID, PRF)).toBe('unreadable');
  });

  it('answers wrong_secret when the inner layer is too short to hold an iv and tag', () => {
    const { s, db } = setup();
    add(s);
    const sealed = new AtRestCipher(KEY, 'passkeys').seal(new Uint8Array(10), Buffer.from(ID));
    db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(sealed, ID);
    expect(s.unwrap(ID, PRF)).toBe('wrong_secret');
  });
});

describe('decodeBase64url', () => {
  it('decodes base64url and refuses anything else', () => {
    expect(Array.from(decodeBase64url('AQID-_8')!)).toEqual([1, 2, 3, 251, 255]);
    expect(decodeBase64url('AQ+D')).toBeNull();
    expect(decodeBase64url('AQ==')).toBeNull();
  });
});
