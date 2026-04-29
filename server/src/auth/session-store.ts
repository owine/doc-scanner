import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import type { ProtonSession } from './srp.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export class SessionStore {
  private readonly key: Buffer;

  constructor(private readonly db: DB, base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('SessionStore: key must be 32 bytes');
  }

  save(session: ProtonSession): void {
    const blob = this.encrypt(JSON.stringify(session));
    this.db.prepare(`
      INSERT INTO sessions (id, encrypted_blob, email, updated_at)
      VALUES (1, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET encrypted_blob = excluded.encrypted_blob,
                                     email = excluded.email,
                                     updated_at = datetime('now')
    `).run(blob, session.email);
  }

  load(): ProtonSession | null {
    const row = this.db.prepare('SELECT encrypted_blob FROM sessions WHERE id = 1').get() as { encrypted_blob: Uint8Array } | undefined;
    if (!row) return null;
    const json = this.decrypt(row.encrypted_blob);
    return JSON.parse(json) as ProtonSession;
  }

  clear(): void {
    this.db.prepare('DELETE FROM sessions WHERE id = 1').run();
  }

  private encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }

  private decrypt(blob: Uint8Array): string {
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = blob.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
