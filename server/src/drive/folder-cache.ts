import type { ProtonDriveClient } from '@protontech/drive-sdk';

export interface FolderEntry {
  linkId: string;
  path: string;
}

type SdkFolderApi = Pick<ProtonDriveClient, 'getMyFilesRootFolder' | 'iterateFolderChildren'>;

function unwrap<T>(maybe: { ok: true; value: T } | { ok: false }): T {
  if (!maybe.ok) throw new Error('SDK returned non-ok result');
  return maybe.value;
}

/**
 * Per-session walk of the Drive folder tree. Holds a flattened list of
 * `{ linkId, path }` for every folder reachable from MyFilesRootFolder,
 * sorted depth-first (parent before children). Files are skipped — this
 * cache is for "where can I file a document" pickers, not file listings.
 *
 * Lifetime is per Drive session: folder UIDs differ per Proton account,
 * so the cache is attached to `liveSession` rather than held as a process
 * singleton.
 */
export class FolderCache {
  private tree: FolderEntry[] = [];

  constructor(private readonly sdk: SdkFolderApi) {}

  getTree(): FolderEntry[] {
    return this.tree;
  }

  async refresh(): Promise<void> {
    const root = unwrap(await this.sdk.getMyFilesRootFolder());
    const out: FolderEntry[] = [{ linkId: root.uid, path: '/' }];
    await this.walk(root.uid, '/', out);
    this.tree = out;
  }

  private async walk(folderUid: string, parentPath: string, out: FolderEntry[]): Promise<void> {
    for await (const childMaybe of this.sdk.iterateFolderChildren(folderUid)) {
      if (!childMaybe.ok) continue;
      const child = childMaybe.value;
      if (String(child.type) !== 'folder') continue;
      const path = parentPath === '/' ? `/${child.name}` : `${parentPath}/${child.name}`;
      out.push({ linkId: child.uid, path });
      await this.walk(child.uid, path, out);
    }
  }
}
