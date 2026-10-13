import type { DocumentView } from '../../documents/types.js';
import { displayName, folderLabel } from './labels.js';

/** Other cards in review that can be combined with `current`. The server refuses one that may be in Drive. */
export function combineCandidates(current: DocumentView, review: readonly DocumentView[]): DocumentView[] {
  return review.filter((d) => d.id !== current.id && !d.possiblyInDrive);
}

/** Where an anchor is filed, or would be: null when it has no folder (the server refuses those). */
export function anchorFolder(d: DocumentView): string | null {
  if (d.state === 'filed') return d.filed?.folderPath ?? null;
  const f = d.decision?.folder ?? d.analysis?.folder;
  return f ? folderLabel(f) : null;
}

/** What "File with" can pair `current` with: other review cards, and recently filed documents. */
export function anchorCandidates(current: DocumentView, review: readonly DocumentView[], filed: readonly DocumentView[]) {
  return {
    review: review.filter((d) => d.id !== current.id && anchorFolder(d) !== null),
    filed: filed.filter((d) => d.filed?.name && anchorFolder(d) !== null),
  };
}

export function matches(d: DocumentView, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${displayName(d)} ${anchorFolder(d) ?? ''}`.toLowerCase().includes(q);
}
