import { describe, it, expect, afterEach } from 'vitest';
import { EntitiesCache } from '../../src/drive/entities-cache.js';
import { createTestDb } from '../helpers/test-db.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

let cleanupFn: (() => void) | null = null;
afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe('EntitiesCache', () => {
  it('round-trips a value via setEntity/getEntity', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.setEntity('foo', 'bar-value');
    expect(await cache.getEntity('foo')).toBe('bar-value');
  });

  it('throws on missing key from getEntity', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await expect(cache.getEntity('nonexistent')).rejects.toThrow();
  });

  it('removes entities by keys', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.setEntity('foo', 'bar');
    await cache.setEntity('baz', 'qux');
    await cache.removeEntities(['foo', 'missing']);
    await expect(cache.getEntity('foo')).rejects.toThrow();
    expect(await cache.getEntity('baz')).toBe('qux');
  });

  it('throws on wrong encryption key', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    await new EntitiesCache(db, KEY).setEntity('foo', 'bar');
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    const otherCache = new EntitiesCache(db, otherKey);
    await expect(otherCache.getEntity('foo')).rejects.toThrow();
  });

  it('overwrites existing key', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.setEntity('foo', 'v1');
    await cache.setEntity('foo', 'v2');
    expect(await cache.getEntity('foo')).toBe('v2');
  });

  it('iterateEntities yields ok and not-ok results', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.setEntity('a', 'A');
    await cache.setEntity('b', 'B');
    const results = [];
    for await (const r of cache.iterateEntities(['a', 'missing', 'b'])) {
      results.push(r);
    }
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ key: 'a', ok: true, value: 'A' });
    expect(results[1].ok).toBe(false);
    expect(results[2]).toEqual({ key: 'b', ok: true, value: 'B' });
  });

  it('iterateEntitiesByTag filters by tag', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.setEntity('node-1', 'one', ['parentUid:abc', 'shared']);
    await cache.setEntity('node-2', 'two', ['parentUid:abc']);
    await cache.setEntity('node-3', 'three', ['parentUid:xyz']);
    const out: Record<string, string> = {};
    for await (const r of cache.iterateEntitiesByTag('parentUid:abc')) {
      if (r.ok) out[r.key] = r.value;
    }
    expect(out).toEqual({ 'node-1': 'one', 'node-2': 'two' });
  });

  it('clear empties the cache', async () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.setEntity('foo', 'bar');
    await cache.clear();
    await expect(cache.getEntity('foo')).rejects.toThrow();
  });
});
