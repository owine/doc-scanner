// The server's API shapes (server/src/documents/view.ts, routes-documents.ts,
// settings/settings-store.ts) as the PWA uses them.

export type DocumentState =
  | 'received'
  | 'analyzing'
  | 'preparing'
  | 'ready'
  | 'filing'
  | 'needs_review'
  | 'awaiting_login'
  | 'filed'
  | 'failed'
  | 'discarded';

export type DocumentSource = 'picker' | 'scanner' | 'share' | 'email';

/** An existing folder, or a new one to be created under an existing parent. */
export type FolderRef =
  | { kind: 'existing'; linkId: string; path: string }
  | { kind: 'new'; parentLinkId: string; parentPath: string; name: string };

export interface DocumentView {
  id: string;
  seq: number;
  state: DocumentState;
  source: DocumentSource;
  originalName: string | null;
  mime: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  reviewReason: string | null;
  error: string | null;
  attempts: number;
  analysis: {
    name: string;
    folder: FolderRef | null;
    confidence: number;
    rationale: string;
    isDocument: boolean;
    contentSeen?: boolean;
  } | null;
  decision: { name: string; folder: FolderRef } | null;
  filed: { name: string | null; folderPath: string | null; driveNodeUid: string | null; driveUrl: string | null } | null;
  autoFiled: boolean;
  userEdited: boolean;
  /** An upload was started, so discarding may leave a copy in Drive. */
  possiblyInDrive: boolean;
  discardRequested: boolean;
  discardedAt: string | null;
}

export interface FolderEntry {
  linkId: string;
  path: string;
}

export interface Settings {
  model: string;
  effort: 'low' | 'medium' | 'high';
  autoFileThreshold: number;
  autoFileEnabled: boolean;
  excludePaths: string[];
}

/** POST /approve: omitted fields mean "as suggested". */
export interface ApproveBody {
  name?: string;
  folder?: { kind: 'existing'; linkId: string } | { kind: 'new'; parentLinkId: string; name: string };
}
