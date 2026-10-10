import { NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import type { FolderContext } from '../analyze/types.js';

export interface TreeFile {
  uid: string;
  name: string;
  mediaType?: string;
  /** Best available "when was this filed" time, used to rank recent names. */
  modified: Date;
  size?: number;
}

export interface TreeFolder {
  linkId: string;
  /** Slash-joined path from My files; the root is "/". */
  path: string;
  files: TreeFile[];
}

export type TreeSdk = Pick<ProtonDriveClient, 'getMyFilesRootFolder' | 'iterateFolderChildrenNodeUids' | 'iterateNodes'>;

function isNode(n: unknown): n is NodeEntity {
  return typeof n === 'object' && n !== null && 'uid' in n;
}

/**
 * Walks My files depth-first and returns every folder with its files. A node
 * whose name can't be decrypted is skipped, and a folder like that takes its
 * subtree with it: with no usable path it can be neither a filing target nor
 * a naming example. Trashed nodes are skipped.
 */
export async function walkFolderTree(sdk: TreeSdk, signal?: AbortSignal): Promise<TreeFolder[]> {
  const root = await sdk.getMyFilesRootFolder();
  const out: TreeFolder[] = [];
  await walk(sdk, root.uid, '/', out, signal);
  return out;
}

async function walk(sdk: TreeSdk, uid: string, path: string, out: TreeFolder[], signal?: AbortSignal): Promise<void> {
  const childUids: string[] = [];
  for await (const childUid of sdk.iterateFolderChildrenNodeUids(uid, undefined, signal)) childUids.push(childUid);

  const folder: TreeFolder = { linkId: uid, path, files: [] };
  out.push(folder);
  const subfolders: { uid: string; path: string }[] = [];

  if (childUids.length > 0) {
    for await (const child of sdk.iterateNodes(childUids, signal)) {
      if (!isNode(child) || child.trashTime || !child.name.ok) continue;
      const name = child.name.value;
      if (child.type === NodeType.Folder) {
        subfolders.push({ uid: child.uid, path: path === '/' ? `/${name}` : `${path}/${name}` });
      } else if (child.type === NodeType.File) {
        folder.files.push({
          uid: child.uid,
          name,
          mediaType: child.mediaType,
          modified: child.activeRevision?.claimedModificationTime ?? child.modificationTime,
          size: child.activeRevision?.claimedSize,
        });
      }
    }
  }

  subfolders.sort((a, b) => a.path.localeCompare(b.path));
  for (const sub of subfolders) await walk(sdk, sub.uid, sub.path, out, signal);
}

export const RECENT_NAMES_PER_FOLDER = 5;

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The analyzer's view of the tree: each folder with the names of its most
 * recently filed documents as the naming signal. `excludeFileUids` hides
 * specific files, which the eval uses so a document is never shown its own
 * name.
 */
export function toFolderContexts(
  tree: TreeFolder[],
  opts: { perFolder?: number; excludeFileUids?: ReadonlySet<string> } = {},
): FolderContext[] {
  const perFolder = opts.perFolder ?? RECENT_NAMES_PER_FOLDER;
  return tree.map((f) => ({
    linkId: f.linkId,
    path: f.path,
    recentNames: f.files
      .filter((file) => !opts.excludeFileUids?.has(file.uid))
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, perFolder)
      .map((file) => stripExtension(file.name)),
  }));
}
