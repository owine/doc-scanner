export interface Point { x: number; y: number; }
export interface Quad { tl: Point; tr: Point; bl: Point; br: Point; }

export type ScanStatus = 'in_progress' | 'completed';

export interface Scan {
  id: string;          // ULID
  status: ScanStatus;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  thumbnailKey: string | null;
  /** Legacy (on-device OCR): a stored PDF that delete() must also remove. */
  pdfKey?: string | null;
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
