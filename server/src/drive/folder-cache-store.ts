import type { DB } from '../db.js';
import { logger } from '../logger.js';
import type { AtRestCipher } from '../crypto/at-rest.js';
import { RECENT_NAMES_PER_FOLDER, type TreeFile, type TreeFolder } from './folder-tree.js';

const time = (f: TreeFile): number => {
  const t = f.modified.getTime();
  return Number.isFinite(t) ? t : 0;
};

/** Only what the analyzer and the folder picker use; nothing else is kept at rest (spec §4). */
function trim(tree: TreeFolder[]): TreeFolder[] {
  return tree.map((f) => ({
    linkId: f.linkId,
    path: f.path,
    files: [...f.files]
      .sort((a, b) => time(b) - time(a))
      .slice(0, RECENT_NAMES_PER_FOLDER)
      .map((file) => ({ uid: file.uid, name: file.name, modified: file.modified })),
  }));
}

/**
 * The last walked folder tree — paths and each folder's five most recent
 * filenames — encrypted at rest, so documents can be analysed while no one
 * is logged in. Filing still needs a live session; this copy only feeds the
 * analyzer and the folder picker.
 */
export class FolderCacheStore {
  constructor(
    private readonly db: DB,
    private readonly cipher: AtRestCipher,
  ) {}

  /** Adds a just-filed document to its folder, so the next analysis sees the name at once. */
  recordFiled(folderLinkId: string, file: TreeFile): void {
    const cached = this.load();
    const folder = cached?.tree.find((f) => f.linkId === folderLinkId);
    if (!cached || !folder) return;
    folder.files = [file, ...folder.files.filter((f) => f.uid !== file.uid)];
    this.save(cached.tree, cached.walkedAt);
  }

  save(tree: TreeFolder[], walkedAt: Date): void {
    const sealed = this.cipher.seal(new TextEncoder().encode(JSON.stringify(trim(tree))));
    this.db
      .prepare(
        `INSERT INTO folder_cache (id, encrypted_tree, walked_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET encrypted_tree = excluded.encrypted_tree, walked_at = excluded.walked_at`,
      )
      .run(sealed, walkedAt.toISOString());
  }

  load(): { tree: TreeFolder[]; walkedAt: Date } | null {
    const row = this.db.prepare('SELECT encrypted_tree, walked_at FROM folder_cache WHERE id = 1').get() as
      | { encrypted_tree: Uint8Array; walked_at: string }
      | undefined;
    if (!row) return null;
    // Fixed reasons only: a JSON.parse message can quote decrypted folder names.
    let reason: 'open' | 'parse' = 'open';
    let tree: TreeFolder[];
    try {
      const plain = this.cipher.open(row.encrypted_tree).toString('utf8');
      reason = 'parse';
      const raw = JSON.parse(plain) as TreeFolder[];
      tree = raw.map((f) => ({ ...f, files: f.files.map((file) => ({ ...file, modified: new Date(file.modified) })) }));
    } catch {
      logger.warn({ reason }, 'folder cache unreadable; discarding it');
      this.db.prepare('DELETE FROM folder_cache WHERE id = 1').run();
      return null;
    }
    return { tree, walkedAt: new Date(row.walked_at) };
  }
}
