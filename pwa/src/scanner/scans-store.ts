import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import { ulid } from 'ulid';
import type { Page, Quad, Scan, Thumbnail } from './types.js';

interface DocScannerSchema extends DBSchema {
  scans: {
    key: string;
    value: Scan;
    indexes: { by_status: string; by_updatedAt: number };
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
}

const DB_NAME = 'docscanner';
const DB_VERSION = 1;

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class ScansStore {
  private db: IDBPDatabase<DocScannerSchema> | null = null;

  async open(): Promise<void> {
    this.db = await openDB<DocScannerSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const scans = db.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('by_status', 'status');
        scans.createIndex('by_updatedAt', 'updatedAt');

        const pages = db.createObjectStore('pages', { keyPath: ['scanId', 'ordinal'] });
        pages.createIndex('by_scan', 'scanId');

        db.createObjectStore('thumbs', { keyPath: 'id' });
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
    const scan: Scan = { id, status: 'in_progress', pageCount: 0, createdAt: now, updatedAt: now, thumbnailKey: null };
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
    const tx = this.d.transaction(['scans', 'pages', 'thumbs'], 'readwrite');
    const scan = await tx.objectStore('scans').get(scanId);
    if (scan?.thumbnailKey) await tx.objectStore('thumbs').delete(scan.thumbnailKey);
    const pageKeys = await tx.objectStore('pages').index('by_scan').getAllKeys(scanId);
    for (const k of pageKeys) await tx.objectStore('pages').delete(k);
    await tx.objectStore('scans').delete(scanId);
    await tx.done;
  }

  async listCompleted(): Promise<Scan[]> {
    const all = await this.d.getAllFromIndex('scans', 'by_updatedAt');
    return all.filter((s) => s.status === 'completed').reverse();
  }

  async getThumbnailBlob(thumbId: string): Promise<Blob | null> {
    const t = await this.d.get('thumbs', thumbId);
    return t?.blob ?? null;
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
