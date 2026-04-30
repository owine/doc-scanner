export interface Point { x: number; y: number; }
export interface Quad { tl: Point; tr: Point; bl: Point; br: Point; }

export type ScanStatus = 'in_progress' | 'completed';

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export type PdfStatus = 'pending' | 'running' | 'done' | 'failed' | 'partial';

export interface Scan {
  id: string;          // ULID
  status: ScanStatus;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  thumbnailKey: string | null;
  // NEW (Phase 4)
  pdfStatus?: PdfStatus;       // undefined = legacy Phase 3 scan; treated as 'pending'
  pdfKey?: string | null;
  ocrError?: string | null;
}

export interface Page {
  scanId: string;
  ordinal: number;
  blob: Blob;
  quad: Quad;
  capturedAt: number;
  // NEW
  ocrText?: string | null;
  ocrWords?: OcrWord[] | null;
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
