import { describe, it, expect, afterEach } from 'vitest';
import { EventIdStore } from '../../src/drive/event-id-store.js';
import { createTestDb } from '../helpers/test-db.js';

let cleanupFn: (() => void) | null = null;
afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe('EventIdStore', () => {
  it('returns null when no cursor stored', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);
    expect(await store.getLatestEventId('scope-1')).toBeNull();
  });

  it('round-trips a cursor', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatestEventId('cursor-1');
    expect(await store.getLatestEventId('scope-1')).toBe('cursor-1');
  });

  it('overwrites existing cursor (single-row contract)', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatestEventId('c1');
    await store.setLatestEventId('c2');
    expect(await store.getLatestEventId('scope-1')).toBe('c2');
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM event_cursors').get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });
});
