import { useEffect, useState } from 'preact/hooks';
import { ulid } from 'ulid';
import { sendDocument, UploadError, type SendInput, type SendResult } from './send.js';
import type { UploadItem, UploadSource } from './types.js';
import { UploadStore, type UploadStorage } from './upload-store.js';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/** The server's limit (spec §3). A bigger file fails here, before it costs any data. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const TOO_LARGE = 'Too large to upload (the limit is 50 MB).';

/** Plain-language reasons for permanent refusals. */
const REFUSALS: Record<string, string> = {
  payload_too_large: TOO_LARGE,
  empty_file: 'The file is empty.',
  missing_file: 'The file could not be read.',
  unreadable: 'The file could not be read.',
  invalid_source: 'The upload was refused.',
};

function refusal(e: UploadError): string {
  // A reverse proxy's own 413 page carries no code.
  if (e.status === 413) return TOO_LARGE;
  return (e.code && REFUSALS[e.code]) || `The server refused this file (${e.code ?? e.status}).`;
}

export interface NewUpload {
  blob: Blob;
  name: string;
  source: UploadSource;
  scanId?: string;
}

export interface UploadQueueOptions {
  store?: UploadStorage;
  send?: (input: SendInput, onProgress: (fraction: number) => void) => Promise<SendResult>;
  now?: () => number;
  /** Files over this many bytes fail at once. Defaults to the server's limit. */
  maxBytes?: number;
  /** The server has it. A scan's local copy can go. */
  onUploaded?: (item: UploadItem, result: SendResult) => void | Promise<void>;
  /** The session is gone: the queue waits for the next sign-in (start()). */
  onUnauthorized?: () => void;
  /** A permanent refusal, for error reporting. Status and code only. */
  report?: (err: UploadError) => void;
}

/**
 * Files on their way to the server (spec §3). Kept in IndexedDB until the
 * server has them, so closing the app or losing the connection loses nothing.
 */
export class UploadQueue {
  private items: UploadItem[] = [];
  private readonly progress = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  /** Scans whose PDF is being built: on their way, though not queued yet. */
  private readonly claimed = new Set<string>();
  private readonly store: UploadStorage;
  private readonly send: NonNullable<UploadQueueOptions['send']>;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private loading: Promise<void> | null = null;
  private active: string | null = null;
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: UploadQueueOptions = {}) {
    this.store = o.store ?? new UploadStore();
    this.send = o.send ?? ((input, onProgress) => sendDocument(input, onProgress));
    // Read the clock on every call, so a test's fake clock applies whenever it was installed.
    this.now = o.now ?? (() => Date.now());
    this.maxBytes = o.maxBytes ?? MAX_UPLOAD_BYTES;
  }

  /** A stable reference between changes. */
  list(): readonly UploadItem[] {
    return this.items;
  }

  progressOf(id: string): number | null {
    return this.progress.get(id) ?? null;
  }

  isSending(id: string): boolean {
    return this.active === id;
  }

  /** Queued, being sent, or having its PDF built. */
  hasScan(scanId: string): boolean {
    return this.claimed.has(scanId) || this.items.some((i) => i.scanId === scanId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async add(files: readonly NewUpload[]): Promise<void> {
    await this.load();
    try {
      for (const f of files) {
        const now = this.now();
        const tooLarge = f.blob.size > this.maxBytes;
        const item: UploadItem = {
          id: ulid(),
          name: f.name,
          size: f.blob.size,
          blob: f.blob,
          source: f.source,
          scanId: f.scanId ?? null,
          createdAt: now,
          attempts: 0,
          state: tooLarge ? 'failed' : 'queued',
          error: tooLarge ? TOO_LARGE : null,
          nextAttemptAt: now,
        };
        await this.store.put(item);
        this.items = [...this.items, item];
      }
    } finally {
      this.emit();
      this.kick();
    }
  }

  /**
   * Queues a scan once. The claim is taken before `build` runs, so a second
   * call, or the device-scans list, sees the scan as on its way at once.
   */
  async addScan(scanId: string, build: () => Promise<Omit<NewUpload, 'scanId'>>): Promise<void> {
    if (this.hasScan(scanId)) return;
    this.claimed.add(scanId);
    this.emit();
    try {
      await this.add([{ ...(await build()), scanId }]);
    } finally {
      this.claimed.delete(scanId);
      this.emit();
    }
  }

  /** Sends a failed item again. Not one over the size limit: the server would refuse it again. */
  async retry(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || this.active === id || item.size > this.maxBytes) return;
    await this.save({ ...item, state: 'queued', error: null, attempts: 0, nextAttemptAt: this.now() });
    this.kick();
  }

  /** Not while it is being sent: the server may already have it. */
  async remove(id: string): Promise<boolean> {
    if (this.active === id) return false;
    await this.store.remove(id);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
    return true;
  }

  start(): void {
    this.paused = false;
    if (!this.running) {
      this.running = true;
      window.addEventListener('online', this.onConnection);
      window.addEventListener('offline', this.onConnection);
    }
    this.load().then(this.kick, (e: unknown) => console.error('could not read the upload queue', (e as Error)?.name));
  }

  stop(): void {
    this.running = false;
    window.removeEventListener('online', this.onConnection);
    window.removeEventListener('offline', this.onConnection);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Reads the stored queue once. A failed read is tried again by the next start() or add(). */
  private load(): Promise<void> {
    this.loading ??= this.store.all().then(
      (stored) => {
        const known = new Set(this.items.map((i) => i.id));
        this.items = [...stored.filter((i) => !known.has(i.id)), ...this.items];
        this.emit();
      },
      (err: unknown) => {
        this.loading = null;
        throw err;
      },
    );
    return this.loading;
  }

  /** Memory first: a storage failure must not leave the item due again at once. */
  private async save(item: UploadItem): Promise<void> {
    this.items = this.items.map((i) => (i.id === item.id ? item : i));
    this.emit();
    await this.store.put(item);
  }

  private readonly onConnection = (): void => {
    this.emit(); // the rows say whether they wait for a connection
    this.kick();
  };

  private readonly kick = (): void => {
    if (!this.running || this.paused || this.active !== null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (navigator.onLine === false) return; // the 'online' event kicks again
    const queued = this.items.filter((i) => i.state === 'queued');
    if (queued.length === 0) return;
    const now = this.now();
    const due = queued.find((i) => i.nextAttemptAt <= now);
    if (!due) {
      const wait = Math.min(...queued.map((i) => i.nextAttemptAt)) - now;
      this.timer = setTimeout(this.kick, wait);
      return;
    }
    void this.upload(due);
  };

  private async upload(item: UploadItem): Promise<void> {
    this.active = item.id;
    this.progress.set(item.id, 0);
    this.emit();
    let result: SendResult | null = null;
    let failure: UploadError | null = null;
    try {
      result = await this.send({ blob: item.blob, name: item.name, source: item.source }, (fraction) =>
        this.setProgress(item.id, fraction),
      );
    } catch (err) {
      // Anything but an UploadError is a fault on this side; sending again won't help.
      failure = err instanceof UploadError ? err : new UploadError(0, 'unreadable');
    }
    try {
      if (result) await this.accepted(item, result);
      else if (failure) await this.refused(item, failure);
    } catch {
      // Storage failed while recording a refusal. The in-memory state is already right.
    } finally {
      this.active = null;
      this.progress.delete(item.id);
      this.emit();
      this.kick();
    }
  }

  private async accepted(item: UploadItem, result: SendResult): Promise<void> {
    try {
      await this.store.remove(item.id);
    } catch {
      // The stored copy is sent again at the next start; the server answers it as a duplicate.
    }
    try {
      await this.o.onUploaded?.(item, result);
    } catch {
      // The upload succeeded; a failing follow-up must not put it back.
    }
    // Only now: until its local copy is gone, a scan must still read as on its way.
    this.items = this.items.filter((i) => i.id !== item.id);
  }

  private async refused(item: UploadItem, e: UploadError): Promise<void> {
    if (e.status === 401) {
      this.paused = true;
      this.o.onUnauthorized?.();
    } else if (e.transient) {
      const attempts = item.attempts + 1;
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
      await this.save({ ...item, attempts, nextAttemptAt: this.now() + wait });
    } else {
      this.o.report?.(e);
      await this.save({ ...item, state: 'failed', error: refusal(e) });
    }
  }

  /** Tells subscribers only when the shown percentage changes: progress events can come many times a second. */
  private setProgress(id: string, fraction: number): void {
    const shown = Math.round((this.progress.get(id) ?? 0) * 100);
    this.progress.set(id, fraction);
    if (Math.round(fraction * 100) !== shown) this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Re-renders on every queue change. */
export function useUploads(queue: UploadQueue): readonly UploadItem[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const off = queue.subscribe(() => setVersion((v) => v + 1));
    setVersion((v) => v + 1);
    return off;
  }, [queue]);
  return queue.list();
}
