import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentSync } from '../../src/documents/sync.js';
import { watchStatus } from '../../src/ui/status-watch.js';
import { makeDoc } from '../documents/fixtures.js';
import type { DocumentView } from '../../src/documents/types.js';

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let stops: (() => void)[] = [];
beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

/** A sync whose next poll answers `next`; an Error rejects it. */
function fakeSync() {
  let next: DocumentView[] | Error = [];
  let cursor = 0;
  const sync = new DocumentSync({
    list: async () => {
      const answer = next;
      if (answer instanceof Error) throw answer;
      next = [];
      return { documents: answer, cursor: answer.length ? ++cursor : cursor };
    },
  });
  return { sync, answer: (a: DocumentView[] | Error) => (next = a) };
}

function setup(over: { live?: boolean; minGapMs?: number } = {}) {
  const { sync, answer } = fakeSync();
  let clock = 1_000_000;
  const refresh = vi.fn(async () => {});
  const live = { value: over.live ?? true };
  const stop = watchStatus({ sync, refresh, isLive: () => live.value, minGapMs: over.minGapMs ?? 5000, now: () => clock });
  stops.push(stop);
  return { sync, answer, refresh, live, stop, advance: (ms: number) => (clock += ms) };
}

describe('watchStatus', () => {
  it('reads the status again when the page becomes visible', async () => {
    const { refresh } = setup();
    setVisibility('hidden');
    expect(refresh).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reads the status again when the document sync recovers after an error', async () => {
    const { sync, answer, refresh } = setup();
    await sync.poll();
    expect(refresh).not.toHaveBeenCalled();
    answer(new Error('offline'));
    await sync.poll();
    expect(refresh).not.toHaveBeenCalled();
    answer([]);
    await sync.poll();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reads the status again when documents start waiting for a login while live', async () => {
    const { sync, answer, refresh } = setup();
    const doc = makeDoc({ state: 'ready' });
    answer([doc]);
    await sync.poll();
    expect(refresh).not.toHaveBeenCalled();
    answer([{ ...doc, seq: doc.seq + 100, state: 'awaiting_login' }]);
    await sync.poll();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Still waiting, one more: not a new 0 → n.
    answer([makeDoc({ state: 'awaiting_login', seq: doc.seq + 200 })]);
    await sync.poll();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('takes the first load as it is: the status was just read', async () => {
    const { sync, answer, refresh } = setup();
    answer([makeDoc({ state: 'awaiting_login' })]);
    await sync.poll();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores waiting documents unless the app believes Proton is live', async () => {
    const { sync, answer, refresh } = setup({ live: false });
    await sync.poll();
    answer([makeDoc({ state: 'awaiting_login' })]);
    await sync.poll();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('coalesces triggers: one read in flight, then at most one per gap, the last trigger kept', async () => {
    vi.useFakeTimers();
    const { refresh, advance } = setup();
    let finish!: () => void;
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    setVisibility('visible');
    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    // Within the gap: held for its end, and many triggers make one read.
    advance(1000);
    for (let i = 0; i < 10; i++) setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops listening, and drops a held read, once stopped', async () => {
    vi.useFakeTimers();
    const { refresh, stop, advance } = setup();
    setVisibility('visible');
    advance(1000);
    setVisibility('visible');
    stop();
    advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
