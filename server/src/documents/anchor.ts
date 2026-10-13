import { sanitiseName } from '../analyze/resolve.js';
import type { FolderChoice } from '../analyze/types.js';
import { isUnderAny, stripExtension } from '../drive/folder-tree.js';
import { folderPath } from './folders.js';
import type { Anchor, Decision, DocumentRow } from './types.js';

/**
 * What "File with" pairs a document with (spec §3), or null when `a` can't
 * be an anchor. A filed document gives the name it was filed under and the
 * folder it went to; one in review gives what would be filed now (the
 * decision, else the analysis).  A new folder stays a proposal.
 */
export function snapshotAnchor(a: DocumentRow): Anchor | null {
  if (a.state === 'filed') {
    if (!a.filingTarget || !a.filedName || !a.filedFolderPath) return null;
    // A Drive name can be anything the user renamed it to, and it reaches the prompt.
    const name = sanitiseName(stripExtension(a.filedName), '');
    if (!name) return null;
    return {
      documentId: a.id,
      name,
      folder: { kind: 'existing', linkId: a.filingTarget.folderLinkId, path: a.filedFolderPath },
    };
  }
  if (a.state !== 'needs_review') return null;
  const name = a.decision?.name ?? a.analysis?.name;
  const f = a.decision?.folder ?? a.analysis?.folder;
  if (!name || !f) return null;
  // A new folder stays new even once created (createdLinkId dropped): it may
  // not be in the cache yet, and the file stage reuses a folder of that name.
  const folder: FolderChoice =
    f.kind === 'existing'
      ? { kind: 'existing', linkId: f.linkId, path: f.path }
      : { kind: 'new', parentLinkId: f.parentLinkId, parentPath: f.parentPath, name: f.name };
  return { documentId: a.id, name, folder };
}

/**
 * The anchor's folder as the tree has it now, or null when it (or a new
 * folder's parent) is gone, or it is now under a never-file-here path.
 */
export function currentAnchorFolder(
  anchor: Anchor,
  tree: readonly { linkId: string; path: string }[],
  excludePaths: readonly string[],
): FolderChoice | null {
  const pathOf = new Map(tree.map((f) => [f.linkId, f.path]));
  const f = anchor.folder;
  let now: FolderChoice;
  if (f.kind === 'existing') {
    const path = pathOf.get(f.linkId);
    if (!path) return null;
    now = { kind: 'existing', linkId: f.linkId, path };
  } else {
    const parentPath = pathOf.get(f.parentLinkId);
    if (!parentPath) return null;
    now = { kind: 'new', parentLinkId: f.parentLinkId, parentPath, name: f.name };
  }
  return isUnderAny(folderPath(now), excludePaths) ? null : now;
}
