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

export const ESTIMATED_PAGE_BYTES = 400_000;
