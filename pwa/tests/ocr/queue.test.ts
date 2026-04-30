import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OcrQueue } from '../../src/ocr/queue.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { OcrResult } from '../../src/ocr/types.js';
import type { Quad } from '../../src/scanner/types.js';

// Fake worker-client that we drive deterministically.
class FakeClient {
  initCalls = 0;
  terminateCalls = 0;
  pending: { blob: Blob; resolve: (r: OcrResult) => void; reject: (e: Error) => void }[] = [];
  init = vi.fn(async () => { this.initCalls++; });
  recognize = vi.fn((blob: Blob) => new Promise<OcrResult>((resolve, reject) => {
    this.pending.push({ blob, resolve, reject });
  }));
  terminate = vi.fn(() => { this.terminateCalls++; this.failAll(new Error('terminated')); });
  // Test-only helper:
  resolveNext(result: OcrResult): void {
    const job = this.pending.shift();
    if (!job) throw new Error('no pending job');
    job.resolve(result);
  }
  rejectNext(err: Error): void {
    const job = this.pending.shift();
    if (!job) throw new Error('no pending job');
    job.reject(err);
  }
  failAll(err: Error): void { while (this.pending.length) this.rejectNext(err); }
}

// Fake pdf builder (so queue tests don't depend on pdf-lib).
const fakePdf = vi.fn(async () => new Blob(['%PDF fake'], { type: 'application/pdf' }));

const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });
const ocr = (text: string): OcrResult => ({ text, words: [] });

let store: ScansStore;
let client: FakeClient;

beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
  client = new FakeClient();
  fakePdf.mockClear();
});

async function makeCompletedScan(pages: string[]): Promise<string> {
  const id = await store.createInProgress();
  for (const p of pages) await store.appendPage(id, blob(p), Q);
  await store.finish(id);
  await store.setPdfStatus(id, 'pending');
  return id;
}

describe('OcrQueue', () => {
  it('processes a single pending scan end-to-end and marks done', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);

    await q.start();
    // First page request goes out; resolve it
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('hello'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('world'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });
    expect(fakePdf).toHaveBeenCalledOnce();
    const pages = await store.getPages(id);
    expect(pages[0]!.ocrText).toBe('hello');
    expect(pages[1]!.ocrText).toBe('world');
  });

  it('partial: keeps building PDF when some pages fail; status = partial', async () => {
    const id = await makeCompletedScan(['p1', 'p2', 'p3']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('hello'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.rejectNext(new Error('blurry'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(3));
    client.resolveNext(ocr('world'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('partial');
    });
    expect(fakePdf).toHaveBeenCalledOnce();
  });

  it('failed: marks pdfStatus failed when all pages fail', async () => {
    await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalled());
    client.rejectNext(new Error('boom'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.rejectNext(new Error('boom'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('failed');
    });
    expect(fakePdf).not.toHaveBeenCalled();
  });

  it('FIFO by updatedAt — older completed scan processes first', async () => {
    const a = await makeCompletedScan(['a']);
    await new Promise((r) => setTimeout(r, 5));
    const b = await makeCompletedScan(['b']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    // First job must be `a` (older). We can verify by completing it and watching state.
    client.resolveNext(ocr('a'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      const aRow = list.find((s) => s.id === a);
      expect(aRow!.pdfStatus).toBe('done');
    });
    expect((await store.listCompleted()).find((s) => s.id === b)!.pdfStatus).toBe('running');
  });

  it('resume: skips pages that already have ocrText', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    // Pre-OCR page 0 (simulating mid-OCR tab kill)
    await store.setPageOcr(id, 0, 'pre-existing', []);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    // Only page 1 should be sent to the worker
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('p1-text'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });
    expect(client.recognize).toHaveBeenCalledTimes(1);
  });

  it('cancel during in-flight terminates worker and stops processing', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    q.cancel(id);
    expect(client.terminateCalls).toBeGreaterThan(0);
    // No PDF was assembled
    expect(fakePdf).not.toHaveBeenCalled();
  });

  it('retry: resets state and re-queues', async () => {
    const id = await makeCompletedScan(['p1']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.rejectNext(new Error('boom'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('failed');
    });

    await q.retry(id);
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('done'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });
  });

  it('cancel during in-flight: finally does not clobber a subsequent retry\'s state', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));

    // Cancel mid-flight (terminates worker; OLD processNext's recognize rejects)
    q.cancel(id);
    // terminate() already calls failAll internally in FakeClient, so pending jobs are drained

    // Retry — kicks a NEW processNext for the same scan
    await q.retry(id);
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('a'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(3));
    client.resolveNext(ocr('b'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });

    // Verify pages have the NEW OCR text, not the cancelled-flow's empty strings
    const pages = await store.getPages(id);
    expect(pages[0]!.ocrText).toBe('a');
    expect(pages[1]!.ocrText).toBe('b');
  });

  it('emits progress events', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    const events: { scanId: string; doneCount: number; totalCount: number }[] = [];
    q.on('progress', (e) => events.push(e));
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('a'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('b'));
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    expect(events.some((e) => e.scanId === id && e.doneCount === 1 && e.totalCount === 2)).toBe(true);
  });
});
