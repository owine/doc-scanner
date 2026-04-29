import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ProtonDriveCache, EntityResult } from '@protontech/drive-sdk';
import type { DB } from '../db.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

interface StoredPayload {
  value: string;
  tags: string[];
}

/**
 * SDK ProtonDriveCache<string> implementation backed by SQLite.
 *
 * Each row's encrypted blob is an AES-GCM ciphertext of a JSON envelope
 * `{ value, tags }`. The session encryption key keeps folder metadata
 * (potentially including filenames inside SDK-serialised entities, plus the
 * tag values themselves) protected at rest to the same standard as the
 * Phase 1 session blob.
 *
 * Tag-based lookup is implemented as a table scan + decrypt + filter. For
 * Phase 2's narrow scope (one upload through a single root folder) the
 * cache stays small, so this is acceptable. A dedicated `entity_tags`
 * index table can be added later if cache size grows.
 */
export class EntitiesCache implements ProtonDriveCache<string> {
  private readonly key: Buffer;

  constructor(
    private readonly db: DB,
    base64Key: string,
  ) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('EntitiesCache: key must be 32 bytes');
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM entities_cache').run();
  }

  async setEntity(key: string, value: string, tags?: string[]): Promise<void> {
    const payload: StoredPayload = { value, tags: tags ?? [] };
    const blob = this.encrypt(JSON.stringify(payload));
    this.db
      .prepare(
        `INSERT INTO entities_cache (key, encrypted_blob, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           encrypted_blob = excluded.encrypted_blob,
           updated_at = datetime('now')`,
      )
      .run(key, blob);
  }

  async getEntity(key: string): Promise<string> {
    const row = this.db
      .prepare('SELECT encrypted_blob FROM entities_cache WHERE key = ?')
      .get(key) as { encrypted_blob: Buffer } | undefined;
    if (!row) {
      throw new Error(`Entity not found: ${key}`);
    }
    return this.decryptPayload(row.encrypted_blob).value;
  }

  async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<string>> {
    for (const key of keys) {
      try {
        const value = await this.getEntity(key);
        yield { key, ok: true, value };
      } catch (error) {
        yield { key, ok: false, error: `${error}` };
      }
    }
  }

  async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
    const rows = this.db
      .prepare('SELECT key, encrypted_blob FROM entities_cache')
      .all() as Array<{ key: string; encrypted_blob: Buffer }>;
    for (const row of rows) {
      try {
        const payload = this.decryptPayload(row.encrypted_blob);
        if (payload.tags.includes(tag)) {
          yield { key: row.key, ok: true, value: payload.value };
        }
      } catch (error) {
        yield { key: row.key, ok: false, error: `${error}` };
      }
    }
  }

  async removeEntities(keys: string[]): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM entities_cache WHERE key = ?');
    const tx = this.db.transaction((ks: string[]) => {
      for (const k of ks) stmt.run(k);
    });
    tx(keys);
  }

  private encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }

  private decryptPayload(blob: Buffer): StoredPayload {
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = blob.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as StoredPayload;
  }
}
