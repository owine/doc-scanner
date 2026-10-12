import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDB } from 'idb';
import { resolve } from 'node:path';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';
import { UploadQueue } from '../../src/uploads/queue.js';
import { scanFileName, sendScanToInbox } from '../../src/uploads/scans.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';

const QUAD: Quad = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, bl: { x: 0, y: 100 }, br: { x: 100, y: 100 } };
const JPEG = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
const jpegBlob = () => new Blob([readFileSync(JPEG)], { type: 'image/jpeg' });

class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()]; }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

const idleQueue = () => new UploadQueue({ store: new MemoryStore(), send: () => new Promise(() => {}) });

// sendScanToInbox imports the PDF builder lazily; the first transform of pdf-lib is slow under parallel load.
beforeAll(async () => {
  await import('../../src/pdf/build.js');
}, 30_000);

let store: ScansStore;
beforeEach(async () => {
  store = new ScansStore();
  await store.open();
});

async function finishedScan(pages: number): Promise<string> {
  const id = await store.createInProgress();
  for (let i = 0; i < pages; i++) await store.appendPage(id, jpegBlob(), QUAD);
  await store.finish(id);
  return id;
}

describe('scanFileName', () => {
  it('names a scan by its local date and time', () => {
    expect(scanFileName(new Date(2026, 9, 12, 9, 5))).toBe('Scan 2026-10-12 09.05.pdf');
  });
});

describe('sendScanToInbox', () => {
  it('queues the scan as one image-only PDF, tied to its scan id and named by when it was scanned', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 4, 3, 14, 20));
      const id = await finishedScan(2);
      // Sent months later: the analyzer reads the name, so it keeps the scan's own date.
      vi.setSystemTime(new Date(2026, 9, 12, 9, 5));
      const queue = idleQueue();
      await sendScanToInbox(store, queue, id);
      const [item] = queue.list();
      expect(item).toMatchObject({ source: 'scanner', scanId: id, name: 'Scan 2026-05-03 14.20.pdf' });
      expect(item!.blob.type).toBe('application/pdf');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not queue the same scan twice', async () => {
    const id = await finishedScan(1);
    const queue = idleQueue();
    await sendScanToInbox(store, queue, id);
    await sendScanToInbox(store, queue, id);
    expect(queue.list()).toHaveLength(1);
  });

  it('sends, then deletes entirely, a scan saved by the on-device OCR version', async () => {
    // Shaped as the retired OCR queue left it: a finished PDF, text on every page.
    const raw = await openDB('docscanner', 2);
    await raw.put('scans', {
      id: 'legacy-1', status: 'completed', pageCount: 2,
      createdAt: new Date(2026, 4, 3, 14, 20).getTime(), updatedAt: new Date(2026, 4, 3, 14, 25).getTime(),
      thumbnailKey: 'legacy-thumb', pdfKey: 'legacy-pdf', pdfStatus: 'done', ocrError: null,
    });
    for (const ordinal of [0, 1]) {
      await raw.put('pages', {
        scanId: 'legacy-1', ordinal, blob: jpegBlob(), quad: QUAD, capturedAt: 1500,
        ocrText: 'Northwind Energy invoice', ocrWords: [{ text: 'Northwind', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, confidence: 91 }],
      });
    }
    await raw.put('thumbs', { id: 'legacy-thumb', blob: jpegBlob() });
    await raw.put('pdfs', { id: 'legacy-pdf', blob: new Blob(['%PDF'], { type: 'application/pdf' }), bytes: 4 });

    const queue = idleQueue();
    await sendScanToInbox(store, queue, 'legacy-1');
    const [item] = queue.list();
    expect(item).toMatchObject({ source: 'scanner', scanId: 'legacy-1', name: 'Scan 2026-05-03 14.20.pdf' });
    expect(item!.blob.type).toBe('application/pdf');

    await store.delete('legacy-1');
    expect(await raw.get('scans', 'legacy-1')).toBeUndefined();
    expect(await raw.getAllFromIndex('pages', 'by_scan', 'legacy-1')).toEqual([]);
    expect(await raw.get('thumbs', 'legacy-thumb')).toBeUndefined();
    expect(await raw.get('pdfs', 'legacy-pdf')).toBeUndefined();
    raw.close();
  });

  it('does not queue the same scan twice when both sends start at once', async () => {
    const id = await finishedScan(1);
    const queue = idleQueue();
    await Promise.all([sendScanToInbox(store, queue, id), sendScanToInbox(store, queue, id)]);
    expect(queue.list()).toHaveLength(1);
  });
});
