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

export interface WalkOptions {
  signal?: AbortSignal;
  /** Folders listed at once. Each listing is a few sequential round trips, so this is what makes a big tree fast. */
  concurrency?: number;
  onProgress?: (p: { folders: number; files: number; pending: number }) => void;
}

/**
 * Walks My files and returns every folder with its files, sorted by path. A
 * node whose name can't be decrypted is skipped, and a folder like that takes
 * its subtree with it: with no usable path it can be neither a filing target
 * nor a naming example. Trashed nodes are skipped.
 */
export async function walkFolderTree(sdk: TreeSdk, opts: WalkOptions = {}): Promise<TreeFolder[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const root = await sdk.getMyFilesRootFolder();
  const out: TreeFolder[] = [];
  const queue: { uid: string; path: string }[] = [{ uid: root.uid, path: '/' }];
  let active = 0;
  let files = 0;

  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = (): void => {
      if (failed) return;
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const job = queue.shift()!;
        active++;
        listFolder(sdk, job.uid, job.path, opts.signal).then(
          ({ folder, subfolders }) => {
            active--;
            out.push(folder);
            files += folder.files.length;
            queue.push(...subfolders);
            opts.onProgress?.({ folders: out.length, files, pending: queue.length + active });
            pump();
          },
          (err: unknown) => {
            failed = true;
            reject(err);
          },
        );
      }
    };
    pump();
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFolder(
  sdk: TreeSdk,
  uid: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ folder: TreeFolder; subfolders: { uid: string; path: string }[] }> {
  const childUids: string[] = [];
  for await (const childUid of sdk.iterateFolderChildrenNodeUids(uid, undefined, signal)) childUids.push(childUid);

  const folder: TreeFolder = { linkId: uid, path, files: [] };
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

  return { folder, subfolders };
}

export const RECENT_NAMES_PER_FOLDER = 5;

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** True when `path` is one of `prefixes` or inside one (whole path segments only). */
export function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/**
 * The analyzer's view of the tree: each folder with the names of its most
 * recently filed documents as the naming signal. `excludePaths` are the
 * user's "never file here" folders (an archive, closed projects); they and
 * everything under them are left out entirely. `excludeFileUids` hides
 * specific files, which the eval uses so a document is never shown its own
 * name.
 */
export function toFolderContexts(
  tree: TreeFolder[],
  opts: { perFolder?: number; excludeFileUids?: ReadonlySet<string>; excludePaths?: readonly string[] } = {},
): FolderContext[] {
  const perFolder = opts.perFolder ?? RECENT_NAMES_PER_FOLDER;
  const excludePaths = opts.excludePaths ?? [];
  return tree.filter((f) => !isUnderAny(f.path, excludePaths)).map((f) => ({
    linkId: f.linkId,
    path: f.path,
    recentNames: f.files
      .filter((file) => !opts.excludeFileUids?.has(file.uid))
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, perFolder)
      .map((file) => stripExtension(file.name)),
  }));
}
