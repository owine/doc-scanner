export interface Point { x: number; y: number; }
export interface Quad { tl: Point; tr: Point; bl: Point; br: Point; }

export type ScanStatus = 'in_progress' | 'completed';

// Phase 5: orthogonal axis tracking the AI/upload journey for a scan.
// `needs_attention` (slice 4) is set when an upload fails repeatedly in
// the background drain — surfaces a banner so the user can manually retry.
export type UploadStatus =
  | 'idle'
  | 'pending_classify'
  | 'awaiting_confirm'
  | 'pending_upload'
  | 'done'
  | 'needs_attention';

export interface UploadSuggestion {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
}

export interface PageOcr {
  text: string;
  words: { text: string; x: number; y: number; w: number; h: number }[];
}

export interface Scan {
  id: string;          // ULID
  status: ScanStatus;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  thumbnailKey: string | null;
  pdfKey?: string | null;          // populated by Phase 5 slice 2 after PDF assembly

  // Phase 5 upload axis. `uploadStatus` defaults to 'idle' for new + migrated
  // scans. `suggestion` mirrors the server's ClassifyResult shape exactly —
  // never copy a post-edit name into it. `pageOcr` is the raw per-page OCR
  // returned alongside the suggestion (consumed by pdf/build during Save).
  // `finalName`/`finalFolderLinkId` are post-edit values written when the
  // user taps Save (slice 2). Drive metadata is set on transition to 'done'.
  uploadStatus: UploadStatus;
  uploadError: string | null;
  suggestion?: UploadSuggestion;
  pageOcr?: PageOcr[];
  finalName?: string;
  finalFolderLinkId?: string;
  driveNodeUid?: string;
  driveWebUrl?: string;
}

export interface Page {
  scanId: string;
  ordinal: number;
  blob: Blob;
  quad: Quad;
  capturedAt: number;
}

export interface Thumbnail {
  id: string;          // UUIDv4
  blob: Blob;
}

export interface PdfArtifact {
  id: string;
  blob: Blob;
  bytes: number;
}

export const ESTIMATED_PAGE_BYTES = 400_000;
