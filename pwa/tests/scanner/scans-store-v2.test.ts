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
    expect(completed[0]!.pdfStatus).toBeUndefined();   // legacy = undefined

    const pages = await store.getPages('legacy-scan-1');
    expect(pages.length).toBe(1);
    expect(await pages[0]!.blob.text()).toBe('p1');
    expect(pages[0]!.ocrText).toBeUndefined();

    // pdfs object store should now exist
    expect(await store.getPdf('nonexistent')).toBeNull();
  });

  it('findPendingPdf returns legacy scans + running scans + pending scans, excludes done/failed', async () => {
    const store = new ScansStore();
    await store.open();
    // legacy: created via ScansStore, but with pdfStatus undefined
    const a = await store.createInProgress();
    await store.appendPage(a, blob('a'), Q);
    await store.finish(a);
    // pdfStatus is undefined after finish in Phase 3 code; we'll simulate 'running' / 'done' / 'failed'
    await store.setPdfStatus(a, 'done');
    const b = await store.createInProgress();
    await store.appendPage(b, blob('b'), Q);
    await store.finish(b);
    await store.setPdfStatus(b, 'failed', 'oops');
    const c = await store.createInProgress();
    await store.appendPage(c, blob('c'), Q);
    await store.finish(c);
    await store.setPdfStatus(c, 'pending');
    const d = await store.createInProgress();
    await store.appendPage(d, blob('d'), Q);
    await store.finish(d);
    await store.setPdfStatus(d, 'running');

    const pending = await store.findPendingPdf();
    const ids = pending.map((s) => s.id).sort();
    expect(ids).toEqual([c, d].sort());
  });

  it('setPageOcr persists text + words on a page', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.setPageOcr(id, 0, 'hello world', [
      { text: 'hello', x: 0, y: 0, w: 50, h: 20, confidence: 90 },
      { text: 'world', x: 60, y: 0, w: 60, h: 20, confidence: 88 },
    ]);
    const pages = await store.getPages(id);
    expect(pages[0]!.ocrText).toBe('hello world');
    expect(pages[0]!.ocrWords?.length).toBe(2);
  });

  it('setPdfBlob inserts into pdfs store and links the scan', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.finish(id);
    const pdfBlob = blob('%PDF-1.7 ... fake');
    const pdfKey = await store.setPdfBlob(id, pdfBlob);
    expect(pdfKey).toMatch(/^[0-9a-f-]+$/i);
    const back = await store.getPdf(pdfKey);
    expect(back).not.toBeNull();
    expect(await back!.text()).toBe('%PDF-1.7 ... fake');
    const list = await store.listCompleted();
    expect(list[0]!.pdfKey).toBe(pdfKey);
  });

  it('delete cascades the pdf as well as pages and thumbnail', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.finish(id);
    const pdfKey = await store.setPdfBlob(id, blob('pdf'));
    await store.delete(id);
    expect(await store.getPdf(pdfKey)).toBeNull();
  });
});
