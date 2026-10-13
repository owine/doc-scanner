import type { FolderChoice } from '../analyze/types.js';
import { isUnderAny, stripExtension } from '../drive/folder-tree.js';
import { folderPath } from './folders.js';
import type { Anchor, Decision, DocumentRow } from './types.js';

/**
 * What "File with" pairs a document with (spec §3), or null when `a` can't
 * be an anchor. A filed document gives the name it was filed under and the
 * folder it went to; one in review gives what would be filed now (the
 * decision, else the analysis). A new folder already created counts as
 * existing.
 */
export function snapshotAnchor(a: DocumentRow): Anchor | null {
  if (a.state === 'filed') {
    if (!a.filingTarget || !a.filedName || !a.filedFolderPath) return null;
    return {
      documentId: a.id,
      name: stripExtension(a.filedName),
      folder: { kind: 'existing', linkId: a.filingTarget.folderLinkId, path: a.filedFolderPath },
    };
  }
  if (a.state !== 'needs_review') return null;
  const name = a.decision?.name ?? a.analysis?.name;
  // Typed as the decision's folder: inferred from both, TypeScript would drop its createdLinkId.
  const f: Decision['folder'] | null | undefined = a.decision?.folder ?? a.analysis?.folder;
  if (!name || !f) return null;
  if (f.kind === 'new' && f.createdLinkId) {
    return { documentId: a.id, name, folder: { kind: 'existing', linkId: f.createdLinkId, path: folderPath(f) } };
  }
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
