import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtRestCipher } from '../crypto/at-rest.js';

export type BlobKind = 'original' | 'prepared' | 'thumbnail';
const KINDS: readonly BlobKind[] = ['original', 'prepared', 'thumbnail'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_NAME = /^([A-Za-z0-9_-]{1,64})\.(original|prepared|thumbnail)\.bin$/;

/** Thrown by get() when the blob does not exist. The message carries no path. */
export class InboxBlobMissingError extends Error {
  constructor(id: string, kind: BlobKind) {
    super(`inbox blob missing: ${kind} (document ${id})`);
    this.name = 'InboxBlobMissingError';
  }
}

/**
 * Documents waiting to be filed, encrypted, one file per document and kind,
 * in a directory beside the database.
 *
 * Writes go through a temp file and a rename, which protects against a
 * process crash, not a power loss (no fsync: acceptable for this app, and the
 * ciphertext is authenticated so a truncated file fails loudly). Leftover temp
 * files are removed on construction and on deleteAll.
 *
 * Blobs are read and written synchronously, which is fine at this volume. If
 * this ever goes async, the temp name must become unique per write.
 */
export class InboxStore {
  constructor(
    private readonly dir: string,
    private readonly cipher: AtRestCipher,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.tmp')) rmSync(join(dir, f), { force: true });
    }
  }

  private path(id: string, kind: BlobKind): string {
    if (!ID.test(id)) throw new Error('invalid document id');
    return join(this.dir, `${id}.${kind}.bin`);
  }

  put(id: string, kind: BlobKind, bytes: Uint8Array): void {
    const p = this.path(id, kind);
    const tmp = `${p}.tmp`;
    try {
      writeFileSync(tmp, this.cipher.seal(bytes), { mode: 0o600 });
      renameSync(tmp, p);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  get(id: string, kind: BlobKind): Buffer {
    const p = this.path(id, kind);
    let sealed: Buffer;
    try {
      sealed = readFileSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new InboxBlobMissingError(id, kind);
      throw err;
    }
    return this.cipher.open(sealed);
  }

  has(id: string, kind: BlobKind): boolean {
    return existsSync(this.path(id, kind));
  }

  deleteAll(id: string): void {
    for (const kind of KINDS) {
      const p = this.path(id, kind);
      rmSync(p, { force: true });
      rmSync(`${p}.tmp`, { force: true });
    }
  }

  /** Distinct ids of documents that have any blob. */
  listIds(): string[] {
    const ids = new Set<string>();
    for (const f of readdirSync(this.dir)) {
      const m = BLOB_NAME.exec(f);
      if (m) ids.add(m[1]!);
    }
    return [...ids];
  }
}
