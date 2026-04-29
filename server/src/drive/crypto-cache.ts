import type { CachedCryptoMaterial, ProtonDriveCache, EntityResult } from '@protontech/drive-sdk';

/**
 * SDK ProtonDriveCache<CachedCryptoMaterial> implementation backed only by
 * an in-process Map.
 *
 * DO NOT add SQLite or any other persistence here. Decrypted node keys must
 * never touch disk; persisting them would defeat Drive's end-to-end encryption.
 * Type-level non-persistence is enforced by this being a separate class from
 * EntitiesCache rather than a parameterized common base.
 */

interface Entry {
  value: CachedCryptoMaterial;
  tags: readonly string[];
}

export class CryptoCache implements ProtonDriveCache<CachedCryptoMaterial> {
  private readonly store = new Map<string, Entry>();

  async clear(): Promise<void> {
    this.store.clear();
  }

  async setEntity(key: string, value: CachedCryptoMaterial, tags?: string[]): Promise<void> {
    this.store.set(key, { value, tags: tags ?? [] });
  }

  async getEntity(key: string): Promise<CachedCryptoMaterial> {
    const entry = this.store.get(key);
    if (!entry) throw new Error(`CryptoCache: key not found: ${key}`);
    return entry.value;
  }

  async *iterateEntities(
    keys: string[],
  ): AsyncGenerator<EntityResult<CachedCryptoMaterial>> {
    for (const key of keys) {
      const entry = this.store.get(key);
      if (entry) {
        yield { key, ok: true, value: entry.value };
      } else {
        yield { key, ok: false, error: `not found: ${key}` };
      }
    }
  }

  async *iterateEntitiesByTag(
    tag: string,
  ): AsyncGenerator<EntityResult<CachedCryptoMaterial>> {
    for (const [key, entry] of this.store.entries()) {
      if (entry.tags.includes(tag)) {
        yield { key, ok: true, value: entry.value };
      }
    }
  }

  async removeEntities(keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }
}
