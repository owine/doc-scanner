import { describe, it, expect, afterEach } from 'vitest';
import { SessionStore } from '../../src/auth/session-store.js';
import { createTestDb } from '../helpers/test-db.js';
import type { ProtonSession } from '../../src/auth/srp.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

let cleanupFn: (() => void) | null = null;
afterEach(() => { cleanupFn?.(); cleanupFn = null; });

const sample: ProtonSession = {
  uid: 'uid-1', accessToken: 'at', refreshToken: 'rt', email: 'a@b.test',
};

describe('SessionStore', () => {
  it('round-trips a session through encrypted storage', () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new SessionStore(db, KEY);
    store.save(sample);
    expect(store.load()).toEqual(sample);
  });

  it('returns null when no session stored', () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new SessionStore(db, KEY);
    expect(store.load()).toBeNull();
  });

  it('clear() removes the session', () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new SessionStore(db, KEY);
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('refuses to load with the wrong key', () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    new SessionStore(db, KEY).save(sample);
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    expect(() => new SessionStore(db, otherKey).load()).toThrow();
  });

  it('overwrites existing session on save', () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new SessionStore(db, KEY);
    store.save(sample);
    store.save({ ...sample, accessToken: 'at2' });
    expect(store.load()?.accessToken).toBe('at2');
  });
});
