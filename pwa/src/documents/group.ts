import type { DocumentState, DocumentView } from './types.js';

export const RECENT_FILED_LIMIT = 30;
/** The server purges discarded documents after this long (worker.ts DISCARD_RETENTION_MS). */
export const DISCARD_RETENTION_MS = 7 * 86_400_000;

const WAITING: ReadonlySet<DocumentState> = new Set(['received', 'analyzing', 'preparing', 'ready', 'filing', 'awaiting_login']);

export interface InboxGroups {
  review: DocumentView[];
  waiting: DocumentView[];
  awaitingLogin: number;
  filed: DocumentView[];
  failed: DocumentView[];
  discarded: DocumentView[];
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : 0);
const oldestFirst = (a: DocumentView, b: DocumentView) => time(a.createdAt) - time(b.createdAt);
const newestFirst = (a: DocumentView, b: DocumentView) => time(b.updatedAt) - time(a.updatedAt);

export function groupDocuments(docs: readonly DocumentView[], now: Date): InboxGroups {
  const of = (state: DocumentState) => docs.filter((d) => d.state === state);
  const waiting = docs.filter((d) => WAITING.has(d.state)).sort(oldestFirst);
  return {
    review: of('needs_review').sort(oldestFirst),
    waiting,
    awaitingLogin: waiting.filter((d) => d.state === 'awaiting_login').length,
    filed: of('filed').sort(newestFirst).slice(0, RECENT_FILED_LIMIT),
    failed: of('failed').sort(newestFirst),
    discarded: of('discarded')
      .filter((d) => now.getTime() - time(d.discardedAt) < DISCARD_RETENTION_MS)
      .sort((a, b) => time(b.discardedAt) - time(a.discardedAt)),
  };
}
