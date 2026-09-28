import { NodeType, type ProtonDriveClient } from '@protontech/drive-sdk';

export interface FolderEntry {
  linkId: string;
  path: string;
}

type SdkFolderApi = Pick<ProtonDriveClient, 'getMyFilesRootFolder' | 'iterateFolderChildren'>;

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
    const root = await this.sdk.getMyFilesRootFolder();
    const out: FolderEntry[] = [{ linkId: root.uid, path: '/' }];
    await this.walk(root.uid, '/', out);
    this.tree = out;
  }

  private async walk(folderUid: string, parentPath: string, out: FolderEntry[]): Promise<void> {
    for await (const child of this.sdk.iterateFolderChildren(folderUid, { type: NodeType.Folder })) {
      // The filter is a server-side hint; keep the check so a non-folder can never
      // become a filing target.
      if (child.type !== NodeType.Folder) continue;
      // A folder whose name can't be decrypted has no usable path, so it and its
      // subtree are left out of the picker rather than shown as a placeholder.
      if (!child.name.ok) continue;
      const path = parentPath === '/' ? `/${child.name.value}` : `${parentPath}/${child.name.value}`;
      out.push({ linkId: child.uid, path });
      await this.walk(child.uid, path, out);
    }
  }
}
