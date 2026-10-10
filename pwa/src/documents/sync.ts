import { useEffect, useState } from 'preact/hooks';
import { ApiError } from '../api.js';
import type { DocumentView } from './types.js';

type ListFn = (since: number) => Promise<{ documents: DocumentView[]; cursor: number }>;

export interface DocumentSyncOptions {
  list: ListFn;
  intervalMs?: number;
  /** The session is gone: polling stops and the app should show the login screen. */
  onUnauthorized?: () => void;
}

/** A guard against a feed that never runs dry within one poll. */
const MAX_PAGES = 20;

/**
 * Every document the server knows about, kept current from the change feed
 * (GET /api/documents?since=<cursor>). One poll pulls pages until one is
 * empty. Polls run every few seconds while the page is visible, and at once
 * when it becomes visible again.
 */
export class DocumentSync {
  private readonly docs = new Map<string, DocumentView>();
  private readonly listeners = new Set<() => void>();
  private snapshot: DocumentView[] | null = null;
  private cursor = 0;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Bumped by reset(): a poll from before a reset must not put old documents back. */
  private generation = 0;
  /** Bumped by start(): a tick from before a stop/start must not start a second timer loop. */
  private loop = 0;
  error: unknown = null;
  loaded = false;

  constructor(private readonly o: DocumentSyncOptions) {}

  /** A stable reference between changes, so consumers can compare it. */
  all(): DocumentView[] {
    return (this.snapshot ??= [...this.docs.values()]);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Takes a document from an action's response, unless a newer version is already held. */
  upsert(doc: DocumentView): void {
    if (this.put(doc)) this.emit();
  }

  poll(): Promise<void> {
    if (!this.inflight) {
      const p: Promise<void> = this.pull().finally(() => {
        // Only its own: reset() may have replaced it with a newer poll since.
        if (this.inflight === p) this.inflight = null;
      });
      this.inflight = p;
    }
    return this.inflight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop++;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.tick();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Forgets everything, for sign-out. */
  reset(): void {
    this.generation++;
    this.inflight = null;
    this.docs.clear();
    this.snapshot = null;
    this.cursor = 0;
    this.error = null;
    this.loaded = false;
    this.emit();
  }

  private put(doc: DocumentView): boolean {
    const held = this.docs.get(doc.id);
    if (held && held.seq > doc.seq) return false;
    this.docs.set(doc.id, doc);
    this.snapshot = null;
    return true;
  }

  private async pull(): Promise<void> {
    const generation = this.generation;
    const wasLoaded = this.loaded;
    const wasError = this.error;
    let changed = false;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const { documents, cursor } = await this.o.list(this.cursor);
        if (generation !== this.generation) return;
        for (const d of documents) if (this.put(d)) changed = true;
        this.cursor = Math.max(this.cursor, cursor);
        if (documents.length === 0) break;
      }
      this.error = null;
    } catch (err) {
      if (generation !== this.generation) return;
      this.error = err;
      if (err instanceof ApiError && err.status === 401) {
        this.stop();
        this.o.onUnauthorized?.();
      }
    }
    this.loaded = true;
    // Idle polls stay silent, so subscribers don't re-render every few seconds.
    if (changed || !wasLoaded || this.error !== wasError) this.emit();
  }

  private readonly tick = (): void => {
    if (!this.running) return;
    const loop = this.loop;
    const due = document.visibilityState === 'hidden' ? Promise.resolve() : this.poll();
    void due.finally(() => {
      if (this.running && loop === this.loop) this.timer = setTimeout(this.tick, this.o.intervalMs ?? 4000);
    });
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.poll();
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Re-renders on every change in the sync and returns its current state. */
export function useDocuments(sync: DocumentSync): { docs: DocumentView[]; loaded: boolean; error: unknown } {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const off = sync.subscribe(() => setVersion((v) => v + 1));
    // Catch a change that landed between the first render and subscribing.
    setVersion((v) => v + 1);
    return off;
  }, [sync]);
  return { docs: sync.all(), loaded: sync.loaded, error: sync.error };
}
