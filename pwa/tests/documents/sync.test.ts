import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentSync } from '../../src/documents/sync.js';
import { ApiError } from '../../src/api.js';
import { makeDoc } from './fixtures.js';

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => { setVisibility('visible'); });
afterEach(() => { vi.useRealTimers(); });

describe('DocumentSync', () => {
  it('pulls pages until one is empty and advances the cursor', async () => {
    const a = makeDoc({ seq: 1 });
    const b = makeDoc({ seq: 2 });
    const list = vi.fn()
      .mockResolvedValueOnce({ documents: [a], cursor: 1 })
      .mockResolvedValueOnce({ documents: [b], cursor: 2 })
      .mockResolvedValueOnce({ documents: [], cursor: 2 });
    const sync = new DocumentSync({ list });
    await sync.poll();
    expect(list.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(sync.all().map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(sync.loaded).toBe(true);
  });

  it('keeps the newer version of a document', async () => {
    const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
    const doc = makeDoc({ seq: 5, state: 'filing' });
    sync.upsert(doc);
    sync.upsert({ ...doc, seq: 4, state: 'needs_review' });
    expect(sync.all()[0]!.state).toBe('filing');
    sync.upsert({ ...doc, seq: 6, state: 'filed' });
    expect(sync.all()[0]!.state).toBe('filed');
  });

  it('notifies subscribers and stops notifying after unsubscribe', async () => {
    const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
    const fn = vi.fn();
    const off = sync.subscribe(fn);
    sync.upsert(makeDoc());
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    sync.upsert(makeDoc());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight poll', async () => {
    const list = vi.fn().mockResolvedValue({ documents: [], cursor: 0 });
    const sync = new DocumentSync({ list });
    await Promise.all([sync.poll(), sync.poll()]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('polls on an interval while visible, and not while hidden', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue({ documents: [], cursor: 0 });
    const sync = new DocumentSync({ list, intervalMs: 1000 });
    try {
      sync.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(list).toHaveBeenCalledTimes(2);
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(3000);
      expect(list).toHaveBeenCalledTimes(2);
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      sync.stop();
    }
  });

  it('drops a poll that was in flight when reset', async () => {
    let release!: (v: { documents: unknown[]; cursor: number }) => void;
    const list = vi.fn().mockReturnValueOnce(new Promise((r) => { release = r; }));
    const sync = new DocumentSync({ list });
    const pending = sync.poll();
    sync.reset();
    release({ documents: [makeDoc()], cursor: 1 });
    await pending;
    expect(sync.all()).toEqual([]);
  });

  it('records an error and keeps what it had', async () => {
    const doc = makeDoc();
    const list = vi.fn()
      .mockResolvedValueOnce({ documents: [doc], cursor: doc.seq })
      .mockResolvedValueOnce({ documents: [], cursor: doc.seq })
      .mockRejectedValueOnce(new TypeError('Load failed'));
    const sync = new DocumentSync({ list });
    await sync.poll();
    await sync.poll();
    expect(sync.error).toBeInstanceOf(TypeError);
    expect(sync.all()).toHaveLength(1);
  });

  it('calls onUnauthorized and stops on a 401', async () => {
    const onUnauthorized = vi.fn();
    const list = vi.fn().mockRejectedValue(new ApiError('not_authenticated', 401, 'not_authenticated'));
    const sync = new DocumentSync({ list, onUnauthorized });
    sync.start();
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    sync.stop();
  });

  it('reset forgets everything', async () => {
    const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
    sync.upsert(makeDoc());
    sync.reset();
    expect(sync.all()).toEqual([]);
    expect(sync.loaded).toBe(false);
  });
});
