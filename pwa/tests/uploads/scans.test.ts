import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it('queues the scan as one image-only PDF, tied to its scan id', async () => {
    const id = await finishedScan(2);
    const queue = idleQueue();
    await sendScanToInbox(store, queue, id, new Date(2026, 9, 12, 9, 5));
    const [item] = queue.list();
    expect(item).toMatchObject({ source: 'scanner', scanId: id, name: 'Scan 2026-10-12 09.05.pdf' });
    expect(item!.blob.type).toBe('application/pdf');
  });

  it('does not queue the same scan twice', async () => {
    const id = await finishedScan(1);
    const queue = idleQueue();
    await sendScanToInbox(store, queue, id);
    await sendScanToInbox(store, queue, id);
    expect(queue.list()).toHaveLength(1);
  });

  it('does not queue the same scan twice when both sends start at once', async () => {
    const id = await finishedScan(1);
    const queue = idleQueue();
    await Promise.all([sendScanToInbox(store, queue, id), sendScanToInbox(store, queue, id)]);
    expect(queue.list()).toHaveLength(1);
  });
});
