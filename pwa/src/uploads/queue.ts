import { useEffect, useState } from 'preact/hooks';
import { ulid } from 'ulid';
import { sendDocument, UploadError, type SendInput, type SendResult } from './send.js';
import type { UploadItem, UploadSource } from './types.js';
import { UploadStore, type UploadStorage } from './upload-store.js';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/**
 * The largest file this side sends (spec §3). A bigger one fails here, before
 * it costs any data. The server's bodyLimit (50 MiB) counts the whole
 * multipart body, not just the file: the boundaries, part headers, file name
 * and the other fields come out of it too. 64 KiB leaves room for those, so a
 * file this side accepts isn't then refused by the server.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 - 64 * 1024;

const TOO_LARGE = 'Too large to upload (the limit is 50 MB).';

const SCAN_NOT_BUILT = 'Could not send this scan. Try again.';

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
  /** The addScan call for each scan being built, so a second call waits on the first. */
  private readonly building = new Map<string, Promise<void>>();
  /**
   * Scans the server has accepted this session. Their local copy may outlive
   * the upload (a device-scan read from just before the delete, or a failed
   * delete), and must not show as left on the device meanwhile.
   */
  private readonly sentScans = new Set<string>();
  /**
   * Why a scan's last addScan failed, by scan id. Kept here, not by a screen:
   * both Done (in App) and the inbox's Send start a build, and the scan's row
   * comes back fresh once the build gives up its claim.
   */
  private readonly buildErrors = new Map<string, string>();
  private readonly store: UploadStorage;
  private readonly send: NonNullable<UploadQueueOptions['send']>;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private loading: Promise<void> | null = null;
  private active: string | null = null;
  private running = false;
  private paused = false;
  /** Bumped by every start(), i.e. every sign-in, so a 401 can be traced to the session it came from. */
  private session = 0;
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

  /** Why the scan's last send failed before it could be queued, if it did. */
  buildErrorOf(scanId: string): string | null {
    return this.buildErrors.get(scanId) ?? null;
  }

  /** Queued, being sent, having its PDF built, or accepted this session. */
  hasScan(scanId: string): boolean {
    return this.claimed.has(scanId) || this.sentScans.has(scanId) || this.items.some((i) => i.scanId === scanId);
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
   * Queues a scan once. The claim is taken before `build` runs, so the
   * device-scans list sees the scan as on its way at once. A second call while
   * the first is building gets the first's promise: it settles when the scan
   * is queued, or fails with it.
   */
  addScan(scanId: string, build: () => Promise<Omit<NewUpload, 'scanId'>>): Promise<void> {
    const inFlight = this.building.get(scanId);
    if (inFlight) return inFlight;
    if (this.hasScan(scanId)) return Promise.resolve();
    this.claimed.add(scanId);
    this.buildErrors.delete(scanId);
    this.emit();
    // Built on a later tick, so the entry below is always set before `finally` deletes it.
    const queued = Promise.resolve()
      .then(build)
      .then((pdf) => this.add([{ ...pdf, scanId }]))
      .catch((e: unknown) => {
        this.buildErrors.set(scanId, SCAN_NOT_BUILT);
        throw e;
      })
      .finally(() => {
        this.claimed.delete(scanId);
        this.building.delete(scanId);
        this.emit();
      });
    this.building.set(scanId, queued);
    return queued;
  }

  /** Sends a failed item again. Not one over the size limit: the server would refuse it again. */
  async retry(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || this.active === id || item.size > this.maxBytes) return;
    await this.save({ ...item, state: 'queued', error: null, attempts: 0, nextAttemptAt: this.now() });
    this.kick();
  }

  /**
   * Not while it is being sent: the server may already have it. Memory first,
   * so a kick while storage is still removing it can't send it.
   */
  async remove(id: string): Promise<boolean> {
    if (this.active === id) return false;
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
    await this.store.remove(id);
    return true;
  }

  start(): void {
    this.session += 1;
    this.paused = false;
    if (!this.running) {
      this.running = true;
      window.addEventListener('online', this.onConnection);
      window.addEventListener('offline', this.onConnection);
    }
    this.load().then(this.kick, (e: unknown) => console.error('could not read the upload queue', (e as Error)?.name));
  }

  /**
   * Queued items survive sign-out, and are sent by the next sign-in on this
   * device. Acceptable for a single-user app: whoever signs in next is the
   * same person.
   */
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

  /**
   * Memory first: a storage failure must not leave the item due again at once.
   * An item removed meanwhile stays removed, in memory and in storage.
   */
  private async save(item: UploadItem): Promise<void> {
    if (!this.items.some((i) => i.id === item.id)) return;
    this.items = this.items.map((i) => (i.id === item.id ? item : i));
    this.emit();
    await this.store.put(item);
  }

  private readonly onConnection = (e: Event): void => {
    if (e.type === 'online') {
      // The backoff was waiting for the network, which is back: everything
      // queued is due now. In memory only; a stored time is long past by the
      // next start anyway.
      const now = this.now();
      if (this.items.some((i) => i.state === 'queued' && i.nextAttemptAt > now)) {
        this.items = this.items.map((i) => (i.state === 'queued' && i.nextAttemptAt > now ? { ...i, nextAttemptAt: now } : i));
      }
    }
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
    const session = this.session;
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
      else if (failure) await this.refused(item, failure, session);
    } catch {
      // Storage failed while recording a refusal. The in-memory state is already right.
    } finally {
      this.active = null;
      this.progress.delete(item.id);
      this.emit();
      this.kick();
    }
  }

  /**
   * The follow-up (a scan's local delete) first, then the stored upload: a
   * crash in between leaves the upload, which is sent again at the next start
   * and answered as a duplicate. The other order would leave the scan on the
   * device, shown as not sent.
   */
  private async accepted(item: UploadItem, result: SendResult): Promise<void> {
    try {
      await this.o.onUploaded?.(item, result);
    } catch {
      // The upload succeeded; a failing follow-up must not put it back.
    }
    try {
      await this.store.remove(item.id);
    } catch {
      // The stored copy is sent again at the next start; the server answers it as a duplicate.
    }
    // Only now: until its local copy is gone, a scan must still read as on its way.
    if (item.scanId) this.sentScans.add(item.scanId);
    this.items = this.items.filter((i) => i.id !== item.id);
  }

  private async refused(item: UploadItem, e: UploadError, session: number): Promise<void> {
    if (e.status === 401) {
      // Sent with a session since replaced by a new sign-in: the item stays
      // queued as it is, and goes again with the new session.
      if (session !== this.session) return;
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
