import type { Analysis, IngestSource } from '../analyze/types.js';

export type DocumentState =
  | 'received'
  | 'analyzing'
  | 'preparing'
  | 'ready'
  | 'needs_review'
  | 'awaiting_login'
  | 'filing'
  | 'filed'
  | 'failed'
  | 'discarded';

/** States the worker picks up. The three working states are re-run after a crash. */
export const WORKABLE_STATES: readonly DocumentState[] = ['received', 'analyzing', 'preparing', 'ready', 'filing'];
export const WORKING_STATES: readonly DocumentState[] = ['analyzing', 'preparing', 'filing'];
/** Discard applies at once here; in a working state it waits for the stage to end. */
export const RESTING_STATES: readonly DocumentState[] = ['received', 'ready', 'needs_review', 'awaiting_login', 'failed'];

/** States a pending discard may still be applied from; never 'filed' or 'discarded'. */
export const DISCARDABLE_STATES: readonly DocumentState[] = [...RESTING_STATES, 'analyzing', 'preparing', 'filing'];

/**
 * The analysis as kept on the row: without the text snippet, which nothing
 * reads back (history recall is off in v1) and which would only keep document
 * text at rest for longer.
 */
export type StoredAnalysis = Omit<Analysis, 'textSnippet'>;

/** What is being filed: the analysis's answer or the user's approved edit. */
export interface Decision {
  name: string;
  folder:
    | { kind: 'existing'; linkId: string; path: string }
    | { kind: 'new'; parentLinkId: string; parentPath: string; name: string; createdLinkId?: string };
}

/** Written just before upload, so a restart can tell whether it already happened. */
export interface FilingTarget {
  folderLinkId: string;
  name: string;
}

export interface DocumentRow {
  id: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  source: IngestSource;
  originalName: string | null;
  mime: string;
  size: number;
  sha256: string;
  sourceContext: string | null;
  state: DocumentState;
  reviewReason: string | null;
  attempts: number;
  nextAttemptAt: string;
  error: string | null;
  analysis: StoredAnalysis | null;
  preparedMime: string | null;
  decision: Decision | null;
  filingTarget: FilingTarget | null;
  filedName: string | null;
  filedFolderPath: string | null;
  driveNodeUid: string | null;
  autoFiled: boolean;
  userEdited: boolean;
  discardRequested: boolean;
  discardedAt: string | null;
}

export interface NewDocument {
  source: IngestSource;
  originalName: string | null;
  mime: string;
  size: number;
  sha256: string;
  sourceContext: string | null;
}

/** Columns a transition may set alongside the new state. */
export interface DocumentPatch {
  reviewReason?: string | null;
  attempts?: number;
  nextAttemptAt?: Date;
  error?: string | null;
  analysis?: StoredAnalysis | null;
  preparedMime?: string | null;
  decision?: Decision | null;
  filingTarget?: FilingTarget | null;
  filedName?: string | null;
  filedFolderPath?: string | null;
  driveNodeUid?: string | null;
  autoFiled?: boolean;
  userEdited?: boolean;
  discardRequested?: boolean;
  discardedAt?: Date | null;
}
