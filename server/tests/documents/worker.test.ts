import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness } from './harness.js';
import { DocumentWorker, MAX_ATTEMPTS } from '../../src/documents/worker.js';
import type { DocumentRow } from '../../src/documents/types.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => {
  vi.restoreAllMocks();
  h.cleanup();
});

/** Runs `fn` after `depth` further microtask hops. */
function afterMicrotasks(depth: number, fn: () => void): void {
  queueMicrotask(() => (depth === 0 ? fn() : afterMicrotasks(depth - 1, fn)));
}

describe('DocumentWorker', () => {
  it('takes a document from received to filed when it can auto-file', async () => {
    h = makeHarness();
    const doc = h.add();
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('stops at review when auto-filing is off', async () => {
    h = makeHarness({ settings: { autoFileEnabled: false } });
    const doc = h.add();
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('retries a failing stage with backoff, then fails it and reports once', async () => {
    h = makeHarness();
    h.analyze.mockRejectedValue(new Error('overloaded'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)).toMatchObject({ attempts: 1, error: 'overloaded' });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      h.advance(10 * 60_000);
      await w.wake();
    }
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls[0][1]).toBe('analyze');
  });

  it('applies a discard that arrived while the document waited out a backoff', async () => {
    h = makeHarness();
    h.analyze.mockRejectedValueOnce(new Error('overloaded'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'analyzing', attempts: 1 });
    expect(h.repo.requestDiscard(doc.id)).toBe('requested');
    h.advance(10 * 60_000);
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('applies a discard during a backoff on the next wake, without waiting the backoff out', async () => {
    h = makeHarness();
    h.analyze.mockRejectedValueOnce(new Error('overloaded'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'analyzing', attempts: 1 });
    expect(h.repo.requestDiscard(doc.id)).toBe('requested');
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('keeps retrying an upload that may have happened, even if a discard arrives', async () => {
    h = makeHarness();
    h.drive.uploadFile.mockRejectedValueOnce(new Error('network down'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    // The failed attempt left a filing target: the upload may have reached Drive.
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filing', attempts: 1, filingTarget: expect.anything() });
    expect(h.repo.requestDiscard(doc.id)).toBe('requested');
    h.advance(10 * 60_000);
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('on login: refreshes the folder tree and files what was waiting', async () => {
    h = makeHarness();
    h.setLive(undefined);
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('awaiting_login');
    h.setLive({ sid: 's', driveClient: h.drive } as never);
    await w.onLogin();
    expect(h.drive.walkFolderTree).toHaveBeenCalled();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('fails a document at once when its inbox blob is missing', async () => {
    h = makeHarness();
    const doc = h.add();
    h.inbox.deleteAll(doc.id);
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
  });

  it('sweeps orphaned inbox blobs: no row, or already filed', async () => {
    h = makeHarness();
    h.inbox.put('ghost123', 'original', new Uint8Array([1]));
    const filed = h.add();
    h.repo.transition(filed.id, 'received', 'filed');
    const pending = h.add();
    new DocumentWorker(h.ctx).purgeDiscarded();
    expect(h.inbox.listIds().sort()).toEqual([pending.id].sort());
  });

  it('shares one folder walk between concurrent refreshes', async () => {
    h = makeHarness();
    const w = new DocumentWorker(h.ctx);
    await Promise.all([w.refreshFolderCache(), w.refreshFolderCache(), w.refreshFolderCache()]);
    expect(h.drive.walkFolderTree).toHaveBeenCalledTimes(1);
  });

  it('purges documents discarded more than seven days ago, blobs included', async () => {
    h = makeHarness();
    const doc = h.add();
    h.repo.requestDiscard(doc.id);
    const w = new DocumentWorker(h.ctx);
    h.advance(6 * 24 * 3600_000);
    w.purgeDiscarded();
    expect(h.repo.get(doc.id)).not.toBeNull();
    h.advance(2 * 24 * 3600_000);
    w.purgeDiscarded();
    expect(h.repo.get(doc.id)).toBeNull();
    expect(h.inbox.has(doc.id, 'original')).toBe(false);
  });

  // Each depth lands the wake-up at a different point while the drain winds
  // down; one of them used to fall between the drain's last check and its
  // reset, and was lost until the next poll.
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('honours a wake-up that arrives while a drain is finishing (depth %i)', async (depth) => {
    h = makeHarness();
    const w = new DocumentWorker(h.ctx);
    const next = h.repo.nextWorkable.bind(h.repo);
    let lateDoc: DocumentRow | undefined;
    let late: Promise<void> | undefined;
    let armed = true;
    vi.spyOn(h.repo, 'nextWorkable').mockImplementation(() => {
      const row = next();
      if (!row && armed) {
        armed = false;
        afterMicrotasks(depth, () => {
          lateDoc = h.add();
          late = w.wake();
        });
      }
      return row;
    });
    await w.wake();
    await new Promise((r) => setImmediate(r));
    await late;
    expect(h.repo.get(lateDoc!.id)?.state).toBe('filed');
  });

  it('never rejects a wake-up when the queue itself fails, and carries on next time', async () => {
    h = makeHarness();
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    vi.spyOn(h.repo, 'nextWorkable').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    await expect(w.wake()).resolves.toBeUndefined();
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('never rejects a wake-up when handling a failure fails too', async () => {
    h = makeHarness();
    h.report.mockImplementation(() => {
      throw new Error('reporting down');
    });
    const doc = h.add();
    h.inbox.deleteAll(doc.id);
    await expect(new DocumentWorker(h.ctx).wake()).resolves.toBeUndefined();
    expect(h.repo.get(doc.id)?.state).toBe('failed');
  });

  it('postpones a row whose failure could not be recorded, so it cannot stall the queue', async () => {
    h = makeHarness();
    h.analyze.mockRejectedValue(new Error('overloaded'));
    const stuck = h.add();
    const w = new DocumentWorker(h.ctx);
    const transition = h.repo.transition.bind(h.repo);
    // Recording the retry fails once; the postponement still goes through.
    let failNext = true;
    vi.spyOn(h.repo, 'transition').mockImplementation((...args) => {
      if (failNext && args[1] === 'analyzing' && args[3]?.attempts !== undefined) {
        failNext = false;
        throw new Error('database is locked');
      }
      return transition(...args);
    });
    await expect(w.wake()).resolves.toBeUndefined();
    expect(Date.parse(h.repo.get(stuck.id)!.nextAttemptAt)).toBeGreaterThan(h.ctx.now().getTime());
  });

  it('starts its timers once, and stop clears them', async () => {
    h = makeHarness();
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const w = new DocumentWorker(h.ctx);
    w.start();
    w.start();
    await w.wake();
    expect(set).toHaveBeenCalledTimes(3);
    w.stop();
    expect(clear).toHaveBeenCalledTimes(3);
  });
});
