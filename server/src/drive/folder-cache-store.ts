import type { DB } from '../db.js';
import type { AtRestCipher } from '../crypto/at-rest.js';
import { RECENT_NAMES_PER_FOLDER, type TreeFile, type TreeFolder } from './folder-tree.js';

/** Only what the analyzer and the folder picker use; nothing else is kept at rest (spec §4). */
function trim(tree: TreeFolder[]): TreeFolder[] {
  return tree.map((f) => ({
    linkId: f.linkId,
    path: f.path,
    files: [...f.files]
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
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
    folder.files.unshift(file);
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
    const raw = JSON.parse(this.cipher.open(row.encrypted_tree).toString('utf8')) as TreeFolder[];
    const tree = raw.map((f) => ({ ...f, files: f.files.map((file) => ({ ...file, modified: new Date(file.modified) })) }));
    return { tree, walkedAt: new Date(row.walked_at) };
  }
}
