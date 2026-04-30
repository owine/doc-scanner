import type { OcrResult, WorkerInput, WorkerOutput } from './types.js';

const WORKER_RECOGNIZE_TIMEOUT_MS = 30_000;

export interface IWorkerClient {
  init(): Promise<void>;
  recognize(blob: Blob): Promise<OcrResult>;
  terminate(): void;
}

interface PendingJob {
  resolve: (r: OcrResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerClient implements IWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private jobs = new Map<string, PendingJob>();
  private nextJobId = 0;

  private spawn(): Worker {
    // Vite resolves the URL ctor pattern at build time so the Worker is bundled.
    const w = new Worker(new URL('./tesseract-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerOutput>) => this.handle(e.data);
    w.onerror = () => this.failAll(new Error('worker fatal error'));
    return w;
  }

  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.worker = this.spawn();
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker init timeout')), 60_000);
      const onReady = (e: MessageEvent<WorkerOutput>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          this.worker!.removeEventListener('message', onReady);
          resolve();
        } else if (e.data.type === 'error' && e.data.jobId === 'init') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      this.worker!.addEventListener('message', onReady);
      this.post({ type: 'init' });
    });
    return this.ready;
  }

  recognize(blob: Blob): Promise<OcrResult> {
    if (!this.worker) return Promise.reject(new Error('worker not initialized'));
    const jobId = `j${this.nextJobId++}`;
    return new Promise<OcrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(jobId);
        reject(new Error('recognize timeout'));
      }, WORKER_RECOGNIZE_TIMEOUT_MS);
      this.jobs.set(jobId, { resolve, reject, timer });
      this.post({ type: 'recognize', jobId, blob });
    });
  }

  terminate(): void {
    if (this.worker) this.worker.terminate();
    this.failAll(new Error('worker terminated'));
    this.worker = null;
    this.ready = null;
  }

  private post(msg: WorkerInput): void { this.worker?.postMessage(msg); }

  private handle(msg: WorkerOutput): void {
    if (msg.type === 'result') {
      const job = this.jobs.get(msg.jobId);
      if (!job) return;
      clearTimeout(job.timer);
      this.jobs.delete(msg.jobId);
      job.resolve({ text: msg.text, words: msg.words });
    } else if (msg.type === 'error') {
      const job = this.jobs.get(msg.jobId);
      if (!job) return;
      clearTimeout(job.timer);
      this.jobs.delete(msg.jobId);
      job.reject(new Error(msg.message));
    }
  }

  private failAll(err: Error): void {
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    this.jobs.clear();
  }
}
