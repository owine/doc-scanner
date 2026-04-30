import { ScansStore } from '../scanner/scans-store.js';
import type { IWorkerClient } from './worker-client.js';
import { WorkerClient } from './worker-client.js';

export interface ProgressEvent { scanId: string; doneCount: number; totalCount: number; }
export interface DoneEvent { scanId: string; pdfStatus: 'done' | 'partial'; }
export interface FailedEvent { scanId: string; error: string; }

type Listener<T> = (event: T) => void;

export type PdfBuilder = (pages: { blob: Blob; ocrText: string; ocrWords: import('../scanner/types.js').OcrWord[] }[]) => Promise<Blob>;

export class OcrQueue {
  private queue: string[] = [];                // scanIds in order
  private currentScanId: string | null = null;
  private cancelled = new Set<string>();
  private listeners: Record<string, Listener<any>[]> = {};

  constructor(
    private readonly store: ScansStore,
    private readonly client: IWorkerClient = new WorkerClient(),
    private readonly buildPdf: PdfBuilder = (async () => { throw new Error('PDF builder not provided'); }),
  ) {}

  async start(): Promise<void> {
    // Reset any 'running' rows back to 'pending' (resume after crash)
    const all = await this.store.findPendingPdf();
    for (const s of all) {
      if (s.pdfStatus === 'running') await this.store.setPdfStatus(s.id, 'pending');
    }
    // Sort by updatedAt asc (oldest first)
    const sorted = all.slice().sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of sorted) this.enqueue(s.id);
  }

  enqueueAfterFinish(scanId: string): void { this.enqueue(scanId); }

  private enqueue(scanId: string): void {
    if (!this.queue.includes(scanId) && this.currentScanId !== scanId) {
      this.queue.push(scanId);
    }
    void this.processNext();
  }

  cancel(scanId: string): void {
    this.cancelled.add(scanId);
    this.queue = this.queue.filter((id) => id !== scanId);
    if (this.currentScanId === scanId) {
      this.client.terminate();
      this.currentScanId = null;
      // worker recreates itself on next init() call inside processNext
    }
  }

  async retry(scanId: string): Promise<void> {
    await this.store.setPdfStatus(scanId, 'pending');
    await this.store.clearScanOcr(scanId);
    this.cancelled.delete(scanId);
    this.enqueue(scanId);
  }

  on(event: 'progress', listener: Listener<ProgressEvent>): void;
  on(event: 'done', listener: Listener<DoneEvent>): void;
  on(event: 'failed', listener: Listener<FailedEvent>): void;
  on(event: 'progress' | 'done' | 'failed', listener: Listener<any>): void {
    (this.listeners[event] = this.listeners[event] ?? []).push(listener);
  }

  private emit(event: string, payload: any): void {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }

  private async processNext(): Promise<void> {
    if (this.currentScanId !== null) return; // already processing
    const scanId = this.queue.shift();
    if (!scanId) return;
    if (this.cancelled.has(scanId)) { this.cancelled.delete(scanId); return void this.processNext(); }
    this.currentScanId = scanId;

    try {
      await this.client.init();
      await this.store.setPdfStatus(scanId, 'running');
      const pages = await this.store.getPages(scanId);

      let okCount = 0;
      let failCount = 0;
      for (const page of pages) {
        if (this.cancelled.has(scanId)) break;
        if (page.ocrText && page.ocrWords) { okCount++; this.emit('progress', { scanId, doneCount: okCount + failCount, totalCount: pages.length }); continue; }
        try {
          const r = await this.client.recognize(page.blob);
          await this.store.setPageOcr(scanId, page.ordinal, r.text, r.words);
          okCount++;
        } catch (err) {
          await this.store.setPageOcr(scanId, page.ordinal, '', []);
          failCount++;
        }
        this.emit('progress', { scanId, doneCount: okCount + failCount, totalCount: pages.length });
      }

      if (this.cancelled.has(scanId)) {
        this.cancelled.delete(scanId);
        this.currentScanId = null;
        return void this.processNext();
      }

      if (okCount === 0) {
        await this.store.setPdfStatus(scanId, 'failed', 'OCR failed on every page');
        this.emit('failed', { scanId, error: 'OCR failed on every page' });
      } else {
        const fresh = await this.store.getPages(scanId);
        const pdfBlob = await this.buildPdf(fresh.map((p) => ({
          blob: p.blob,
          ocrText: p.ocrText ?? '',
          ocrWords: p.ocrWords ?? [],
        })));
        await this.store.setPdfBlob(scanId, pdfBlob);
        const status = failCount === 0 ? 'done' : 'partial';
        await this.store.setPdfStatus(scanId, status);
        this.emit('done', { scanId, pdfStatus: status });
      }
    } catch (err) {
      await this.store.setPdfStatus(scanId, 'failed', (err as Error).message);
      this.emit('failed', { scanId, error: (err as Error).message });
    } finally {
      this.currentScanId = null;
      void this.processNext();
    }
  }
}
