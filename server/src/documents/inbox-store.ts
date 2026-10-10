import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtRestCipher } from '../crypto/at-rest.js';

export type BlobKind = 'original' | 'prepared' | 'thumbnail';
const KINDS: readonly BlobKind[] = ['original', 'prepared', 'thumbnail'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Documents waiting to be filed, encrypted, one file per document and kind,
 * in a directory beside the database. Writes go through a temp file and a
 * rename so a crash never leaves a half-written blob.
 */
export class InboxStore {
  constructor(
    private readonly dir: string,
    private readonly cipher: AtRestCipher,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string, kind: BlobKind): string {
    if (!ID.test(id)) throw new Error('invalid document id');
    return join(this.dir, `${id}.${kind}.bin`);
  }

  put(id: string, kind: BlobKind, bytes: Uint8Array): void {
    const p = this.path(id, kind);
    writeFileSync(`${p}.tmp`, this.cipher.seal(bytes));
    renameSync(`${p}.tmp`, p);
  }

  get(id: string, kind: BlobKind): Buffer {
    return this.cipher.open(readFileSync(this.path(id, kind)));
  }

  has(id: string, kind: BlobKind): boolean {
    return existsSync(this.path(id, kind));
  }

  deleteAll(id: string): void {
    for (const kind of KINDS) rmSync(this.path(id, kind), { force: true });
  }
}
