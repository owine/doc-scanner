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

  it('round-trips a cursor for a scope', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatestEventId('scope-1', 'cursor-1');
    expect(await store.getLatestEventId('scope-1')).toBe('cursor-1');
  });

  it('overwrites the cursor of a scope in place', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatestEventId('scope-1', 'c1');
    await store.setLatestEventId('scope-1', 'c2');
    expect(await store.getLatestEventId('scope-1')).toBe('c2');
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM event_cursors').get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('keeps scopes independent', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);

    // The SDK asks for a 'core' scope plus one per volume; conflating them
    // would replay or skip events on whichever scope lost the race.
    await store.setLatestEventId('core', 'core-cursor');
    await store.setLatestEventId('volume-1', 'volume-cursor');

    expect(await store.getLatestEventId('core')).toBe('core-cursor');
    expect(await store.getLatestEventId('volume-1')).toBe('volume-cursor');
    expect(await store.getLatestEventId('volume-2')).toBeNull();
  });

  it('clear drops every scope', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatestEventId('core', 'c1');
    await store.setLatestEventId('volume-1', 'c2');

    await store.clear();

    expect(await store.getLatestEventId('core')).toBeNull();
    expect(await store.getLatestEventId('volume-1')).toBeNull();
  });
});
