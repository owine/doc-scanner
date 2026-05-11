import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import { ulid } from 'ulid';
import type { Page, PageOcr, PdfArtifact, Quad, Scan, Thumbnail, UploadStatus, UploadSuggestion } from './types.js';

interface DocScannerSchema extends DBSchema {
  scans: {
    key: string;
    value: Scan;
    indexes: { by_status: string; by_updatedAt: number; by_uploadStatus: string };
  };
  pages: {
    key: [string, number];
    value: Page;
    indexes: { by_scan: string };
  };
  thumbs: {
    key: string;
    value: Thumbnail;
  };
  pdfs: {
    key: string;
    value: PdfArtifact;
  };
}

const DB_NAME = 'docscanner';
const DB_VERSION = 3;

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Phase 5: legal `uploadStatus` transitions. setUploadStatus throws on
// illegal transitions. needs_attention is reachable from pending_upload
// after the background drain exhausts its retries; user-initiated
// "Retry all" moves it back to pending_upload for another drain.
const ALLOWED_TRANSITIONS: Record<UploadStatus, UploadStatus[]> = {
  idle: ['pending_classify'],
  pending_classify: ['awaiting_confirm'],
  awaiting_confirm: ['pending_upload', 'idle'],
  pending_upload: ['done', 'needs_attention'],
  needs_attention: ['pending_upload'],
  done: [],
};

export interface UploadStatusPatch {
  uploadError?: string | null;
  suggestion?: UploadSuggestion;
  pageOcr?: PageOcr[];
  finalName?: string;
  finalFolderLinkId?: string;
  driveNodeUid?: string;
  driveWebUrl?: string;
}

export class ScansStore {
  private db: IDBPDatabase<DocScannerSchema> | null = null;

  async open(): Promise<void> {
    this.db = await openDB<DocScannerSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const scans = db.createObjectStore('scans', { keyPath: 'id' });
          scans.createIndex('by_status', 'status');
          scans.createIndex('by_updatedAt', 'updatedAt');

          const pages = db.createObjectStore('pages', { keyPath: ['scanId', 'ordinal'] });
          pages.createIndex('by_scan', 'scanId');

          db.createObjectStore('thumbs', { keyPath: 'id' });
        }
        if (oldVersion < 2) {
          db.createObjectStore('pdfs', { keyPath: 'id' });
        }
        if (oldVersion < 3) {
          // Add by_uploadStatus index + default uploadStatus on existing scans.
          const scans = tx.objectStore('scans');
          scans.createIndex('by_uploadStatus', 'uploadStatus');
          // Migrate existing rows.
          (async () => {
            const all = await scans.getAll();
            for (const s of all) {
              if (s.uploadStatus === undefined) {
                s.uploadStatus = 'idle';
                s.uploadError = null;
                await scans.put(s);
              }
            }
          })();
        }
      },
    });
  }

  private get d(): IDBPDatabase<DocScannerSchema> {
    if (!this.db) throw new Error('ScansStore not open()');
    return this.db;
  }

  async createInProgress(): Promise<string> {
    const prior = await this.findInProgress();
    if (prior) await this.delete(prior.id);

    const now = Date.now();
    const id = ulid();
    const scan: Scan = {
      id, status: 'in_progress', pageCount: 0, createdAt: now, updatedAt: now,
      thumbnailKey: null, uploadStatus: 'idle', uploadError: null,
    };
    await this.d.put('scans', scan);
    return id;
  }

  async findInProgress(): Promise<Scan | null> {
    const rows = await this.d.getAllFromIndex('scans', 'by_status', 'in_progress');
    return rows[0] ?? null;
  }

  async appendPage(scanId: string, blob: Blob, quad: Quad): Promise<number> {
    const tx = this.d.transaction(['scans', 'pages'], 'readwrite');
    const scan = await tx.objectStore('scans').get(scanId);
    if (!scan) throw new Error(`scan not found: ${scanId}`);
    const ordinal = scan.pageCount;
    await tx.objectStore('pages').put({ scanId, ordinal, blob, quad, capturedAt: Date.now() });
    scan.pageCount = ordinal + 1;
    scan.updatedAt = Date.now();
    await tx.objectStore('scans').put(scan);
    await tx.done;
    return ordinal;
  }

  async updatePage(scanId: string, ordinal: number, blob: Blob, quad: Quad): Promise<void> {
    const existing = await this.d.get('pages', [scanId, ordinal]);
    if (!existing) throw new Error(`page not found: ${scanId}/${ordinal}`);
    await this.d.put('pages', { ...existing, blob, quad });
    const scan = await this.d.get('scans', scanId);
    if (scan) {
      scan.updatedAt = Date.now();
      await this.d.put('scans', scan);
    }
  }

  async getPages(scanId: string): Promise<Page[]> {
    const all = await this.d.getAllFromIndex('pages', 'by_scan', scanId);
    return all.sort((a, b) => a.ordinal - b.ordinal);
  }

  async finish(scanId: string): Promise<void> {
    const pages = await this.getPages(scanId);
    if (pages.length === 0) throw new Error(`cannot finish empty scan: ${scanId}`);
    const thumb = await makeThumbnail(pages[0]!.blob);
    const thumbId = uuid();
    await this.d.put('thumbs', { id: thumbId, blob: thumb });

    const scan = await this.d.get('scans', scanId);
    if (!scan) throw new Error(`scan not found: ${scanId}`);
    scan.status = 'completed';
    scan.thumbnailKey = thumbId;
    scan.updatedAt = Date.now();
    await this.d.put('scans', scan);
  }

  async delete(scanId: string): Promise<void> {
    const tx = this.d.transaction(['scans', 'pages', 'thumbs', 'pdfs'], 'readwrite');
    const scan = await tx.objectStore('scans').get(scanId);
    if (scan?.thumbnailKey) await tx.objectStore('thumbs').delete(scan.thumbnailKey);
    if (scan?.pdfKey) await tx.objectStore('pdfs').delete(scan.pdfKey);
    const pageKeys = await tx.objectStore('pages').index('by_scan').getAllKeys(scanId);
    for (const k of pageKeys) await tx.objectStore('pages').delete(k);
    await tx.objectStore('scans').delete(scanId);
    await tx.done;
  }

  async getPdf(pdfKey: string): Promise<Blob | null> {
    const row = await this.d.get('pdfs', pdfKey);
    return row?.blob ?? null;
  }

  /**
   * Persist an assembled searchable PDF and link it to its scan. PR-8 #2
   * fix: a single IDB transaction over both stores ensures we don't leave
   * an orphaned `pdfs` row if the scan lookup or update fails. The scan
   * is loaded *inside* the same transaction so the orphan window is zero.
   *
   * Replaces any prior `pdfKey` the scan referenced (deleted in the same
   * transaction). Returns the new pdfKey.
   */
  async setPdfBlob(scanId: string, blob: Blob): Promise<string> {
    const tx = this.d.transaction(['scans', 'pdfs'], 'readwrite');
    const scans = tx.objectStore('scans');
    const pdfs = tx.objectStore('pdfs');

    const scan = await scans.get(scanId);
    if (!scan) {
      // Transaction auto-aborts when we return without awaiting tx.done
      // and the throw bubbles up — no orphaned pdfs row possible because
      // we haven't called pdfs.put yet.
      throw new Error(`scan not found: ${scanId}`);
    }

    if (scan.pdfKey) await pdfs.delete(scan.pdfKey);
    const id = uuid();
    await pdfs.put({ id, blob, bytes: blob.size });
    scan.pdfKey = id;
    scan.updatedAt = Date.now();
    await scans.put(scan);
    await tx.done;
    return id;
  }

  async listCompleted(): Promise<Scan[]> {
    const all = await this.d.getAllFromIndex('scans', 'by_updatedAt');
    return all.filter((s) => s.status === 'completed').reverse();
  }

  async getThumbnailBlob(thumbId: string): Promise<Blob | null> {
    const t = await this.d.get('thumbs', thumbId);
    return t?.blob ?? null;
  }

  async getScan(scanId: string): Promise<Scan | null> {
    const s = await this.d.get('scans', scanId);
    return s ?? null;
  }

  /**
   * Phase 5: drive the upload-state machine for a scan. Validates that
   * `next` is a legal transition from the scan's current `uploadStatus`
   * and atomically merges the optional `patch` into the row. Throws on
   * illegal transitions or missing scan. Single-row IDB transaction —
   * concurrent calls on the same scanId are serialised by IDB itself.
   */
  async setUploadStatus(scanId: string, next: UploadStatus, patch: UploadStatusPatch = {}): Promise<void> {
    const tx = this.d.transaction('scans', 'readwrite');
    const scan = await tx.objectStore('scans').get(scanId);
    if (!scan) throw new Error(`scan not found: ${scanId}`);
    const legal = ALLOWED_TRANSITIONS[scan.uploadStatus] ?? [];
    if (!legal.includes(next)) {
      throw new Error(`illegal uploadStatus transition: ${scan.uploadStatus} → ${next}`);
    }
    Object.assign(scan, patch);
    scan.uploadStatus = next;
    scan.updatedAt = Date.now();
    await tx.objectStore('scans').put(scan);
    await tx.done;
  }

  /** Read all page blobs for a scan in ordinal order (slice 1: classify input). */
  async getPageBlobs(scanId: string): Promise<Blob[]> {
    const pages = await this.getPages(scanId);
    return pages.map((p) => p.blob);
  }

  /**
   * Atomic patch combining `setUploadStatus('awaiting_confirm', ...)` with
   * the suggestion + pageOcr received from /api/classify. Use this rather
   * than two sequential setUploadStatus calls so a failure mid-write
   * doesn't leave a half-populated state.
   */
  async setSuggestionAndOcr(
    scanId: string,
    suggestion: UploadSuggestion | undefined,
    pageOcr: PageOcr[] | undefined,
  ): Promise<void> {
    const patch: UploadStatusPatch = {};
    if (suggestion !== undefined) patch.suggestion = suggestion;
    if (pageOcr !== undefined) patch.pageOcr = pageOcr;
    await this.setUploadStatus(scanId, 'awaiting_confirm', patch);
  }

  /** Concatenate per-page OCR text (used when uploading PDF in slice 2). */
  async getCombinedOcrText(scanId: string): Promise<string> {
    const scan = await this.getScan(scanId);
    if (!scan?.pageOcr) return '';
    return scan.pageOcr.map((p) => p.text).filter((t) => t.length > 0).join('\n\n');
  }
}

/**
 * Decode a JPEG Blob, downscale to ≤256px max edge, return new JPEG Blob.
 * In test environments where OffscreenCanvas is unavailable, return source as-is.
 */
async function makeThumbnail(source: Blob): Promise<Blob> {
  if (typeof OffscreenCanvas === 'undefined') return source;

  const bitmap = await createImageBitmap(source);
  const max = 256;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}
