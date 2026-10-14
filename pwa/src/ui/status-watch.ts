import type { DocumentSync } from '../documents/sync.js';

export interface StatusWatchOptions {
  sync: Pick<DocumentSync, 'subscribe' | 'all' | 'error' | 'loaded'>;
  /** Reads GET /api/auth/status again and applies it. */
  refresh: () => Promise<unknown>;
  /** Whether the app believes Proton is live right now. */
  isLive: () => boolean;
  /** The least time between two reads this watch starts. */
  minGapMs?: number;
  now?: () => number;
}

/** A tab or a backgrounded phone app can flip visibility, and a flaky connection the sync, every few seconds. */
const MIN_GAP_MS = 5000;

/**
 * Notices a server whose Proton state changed under a warm app (passkey-unlock
 * spec §3): after a restart the keys are gone, yet the app still says `live`.
 * It reads the status again when the page becomes visible, when the document
 * sync recovers after an error, and when documents start waiting for a login
 * while the app believes Proton is live.
 *
 * Reads never overlap: a trigger while one is in flight is dropped (that read
 * is already asking), and one within `minGapMs` of the last read waits for
 * the gap's end, where any number of triggers make a single read.
 *
 * Returns a function that stops it.
 */
export function watchStatus({ sync, refresh, isLive, minGapMs = MIN_GAP_MS, now = Date.now }: StatusWatchOptions): () => void {
  let stopped = false;
  let inflight = false;
  let last = -Infinity;
  let held: ReturnType<typeof setTimeout> | null = null;

  function trigger(): void {
    if (stopped || inflight || held !== null) return;
    const wait = last + minGapMs - now();
    if (wait > 0) {
      held = setTimeout(() => {
        held = null;
        trigger();
      }, wait);
      return;
    }
    last = now();
    inflight = true;
    void refresh()
      .catch(() => {})
      .finally(() => {
        inflight = false;
      });
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') trigger();
  };
  document.addEventListener('visibilitychange', onVisibility);

  let failing = sync.error !== null;
  // Unknown until the first load: the status was read just before it.
  let awaiting: number | null = null;
  const off = sync.subscribe(() => {
    const nowFailing = sync.error !== null;
    const recovered = failing && !nowFailing;
    failing = nowFailing;
    if (!sync.loaded) {
      awaiting = null;
    } else {
      const count = sync.all().filter((d) => d.state === 'awaiting_login').length;
      // Documents wait for a login the app thinks it has: the server may have lost it.
      if (awaiting === 0 && count > 0 && isLive()) trigger();
      awaiting = count;
    }
    if (recovered) trigger();
  });

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    off();
    if (held !== null) clearTimeout(held);
    held = null;
  };
}
