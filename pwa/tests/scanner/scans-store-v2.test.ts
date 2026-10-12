import { describe, it, expect, beforeEach } from 'vitest';
import { openDB } from 'idb';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

const DB_NAME = 'docscanner';
const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });

beforeEach(() => { indexedDB.deleteDatabase(DB_NAME); });

describe('ScansStore v2 migration', () => {
  it('preserves Phase 3 data when bumping from v1 to v2', async () => {
    // Seed a v1 database with the Phase 3 schema
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const scans = db.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('by_status', 'status');
        scans.createIndex('by_updatedAt', 'updatedAt');
        const pages = db.createObjectStore('pages', { keyPath: ['scanId', 'ordinal'] });
        pages.createIndex('by_scan', 'scanId');
        db.createObjectStore('thumbs', { keyPath: 'id' });
      },
    });
    await v1.put('scans', {
      id: 'legacy-scan-1', status: 'completed', pageCount: 1,
      createdAt: 1000, updatedAt: 2000, thumbnailKey: 'thumb-1',
    });
    await v1.put('pages', { scanId: 'legacy-scan-1', ordinal: 0, blob: blob('p1'), quad: Q, capturedAt: 1500 });
    await v1.put('thumbs', { id: 'thumb-1', blob: blob('t') });
    v1.close();

    // Open at v2 via ScansStore — runs the migration
    const store = new ScansStore();
    await store.open();

    const completed = await store.listCompleted();
    expect(completed.length).toBe(1);
    expect(completed[0]!.id).toBe('legacy-scan-1');

    const pages = await store.getPages('legacy-scan-1');
    expect(pages.length).toBe(1);
    expect(await pages[0]!.blob.text()).toBe('p1');
  });

  it('delete also removes a PDF left by on-device OCR', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.finish(id);
    // What the retired OCR queue left behind: a pdfs row the scan points at.
    const raw = await openDB(DB_NAME, 2);
    await raw.put('pdfs', { id: 'legacy-pdf', blob: blob('pdf'), bytes: 3 });
    await raw.put('scans', { ...(await raw.get('scans', id)), pdfKey: 'legacy-pdf' });
    await store.delete(id);
    expect(await raw.get('pdfs', 'legacy-pdf')).toBeUndefined();
    raw.close();
  });
});
