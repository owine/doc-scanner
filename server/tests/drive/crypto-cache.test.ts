import { describe, it, expect } from 'vitest';
import { CryptoCache } from '../../src/drive/crypto-cache.js';
import type { CachedCryptoMaterial } from '@protontech/drive-sdk';

const sample = (): CachedCryptoMaterial => ({});

describe('CryptoCache', () => {
  it('round-trips a value via setEntity/getEntity', async () => {
    const cache = new CryptoCache();
    const value = sample();
    await cache.setEntity('k1', value);
    expect(await cache.getEntity('k1')).toBe(value);
  });

  it('throws on missing key from getEntity', async () => {
    const cache = new CryptoCache();
    await expect(cache.getEntity('missing')).rejects.toThrow();
  });

  it('removes entities by keys', async () => {
    const cache = new CryptoCache();
    await cache.setEntity('a', sample());
    const b = sample();
    await cache.setEntity('b', b);
    await cache.removeEntities(['a', 'missing']);
    await expect(cache.getEntity('a')).rejects.toThrow();
    expect(await cache.getEntity('b')).toBe(b);
  });

  it('clear empties the cache', async () => {
    const cache = new CryptoCache();
    await cache.setEntity('a', sample());
    await cache.setEntity('b', sample());
    await cache.clear();
    await expect(cache.getEntity('a')).rejects.toThrow();
    await expect(cache.getEntity('b')).rejects.toThrow();
  });

  it('iterateEntities yields ok and not-ok results', async () => {
    const cache = new CryptoCache();
    const v = sample();
    await cache.setEntity('a', v);
    const results = [];
    for await (const r of cache.iterateEntities(['a', 'missing'])) {
      results.push(r);
    }
    expect(results).toHaveLength(2);
    const a = results.find((r) => r.key === 'a');
    const missing = results.find((r) => r.key === 'missing');
    expect(a).toMatchObject({ ok: true, value: v });
    expect(missing?.ok).toBe(false);
  });

  it('iterateEntitiesByTag filters by tag', async () => {
    const cache = new CryptoCache();
    await cache.setEntity('a', sample(), ['tag1']);
    await cache.setEntity('b', sample(), ['tag2']);
    await cache.setEntity('c', sample(), ['tag1', 'tag2']);
    const out: string[] = [];
    for await (const r of cache.iterateEntitiesByTag('tag1')) {
      if (r.ok) out.push(r.key);
    }
    expect(out.sort()).toEqual(['a', 'c']);
  });
});
