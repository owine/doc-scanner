import { describe, it, expect, vi, afterEach } from 'vitest';
import { UploadQueue, type UploadQueueOptions } from '../../src/uploads/queue.js';
import { UploadError, type SendResult } from '../../src/uploads/send.js';
import type { UploadItem } from '../../src/uploads/types.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';

class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt); }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const file = (name: string) => ({ blob: new Blob(['x'], { type: 'application/pdf' }), name, source: 'picker' as const });

const made: UploadQueue[] = [];
/** A queue over memory. Each is stopped after its test, so no `online` listener outlives it. */
function make(o: UploadQueueOptions = {}): UploadQueue {
  const q = new UploadQueue({ store: new MemoryStore(), ...o });
  made.push(q);
  return q;
}

afterEach(() => {
  for (const q of made.splice(0)) q.stop();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'onLine');
});

describe('UploadQueue', () => {
  it('uploads one at a time, oldest first, and forgets each once accepted', async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const pending = [deferred<SendResult>(), deferred<SendResult>()];
    const send = vi.fn((input: { name: string }) => { calls.push(input.name); return pending[calls.length - 1]!.promise; });
    const onUploaded = vi.fn();
    const q = make({ store, send, onUploaded });
    q.start();
    await q.add([file('a.pdf'), file('b.pdf')]);
    await vi.waitFor(() => expect(calls).toEqual(['a.pdf']));
    pending[0]!.resolve({ id: 'd1', duplicate: false });
    await vi.waitFor(() => expect(calls).toEqual(['a.pdf', 'b.pdf']));
    pending[1]!.resolve({ id: 'd2', duplicate: false });
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    expect(store.items.size).toBe(0);
    expect(onUploaded).toHaveBeenCalledTimes(2);
  });

  it('shows progress for the item being sent, telling subscribers only when the percentage changes', async () => {
    const d = deferred<SendResult>();
    let report!: (f: number) => void;
    const q = make({ send: (_i, onProgress) => { report = onProgress; return d.promise; } });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(report).toBeDefined());
    const changed = vi.fn();
    q.subscribe(changed);
    report(0.5);
    report(0.501);
    expect(q.progressOf(q.list()[0]!.id)).toBe(0.501);
    expect(changed).toHaveBeenCalledTimes(1);
    d.resolve({ id: 'd1', duplicate: false });
    await vi.waitFor(() => expect(q.list()).toEqual([]));
  });

  it('retries a transient failure after a backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const send = vi.fn()
      .mockRejectedValueOnce(new UploadError(503, undefined))
      .mockResolvedValueOnce({ id: 'd1', duplicate: false });
    const q = make({ send });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.list()[0]).toMatchObject({ state: 'queued', attempts: 1 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.list()).toEqual([]);
  });

  it('stops on a permanent failure, explains it and reports it without the name', async () => {
    const report = vi.fn();
    const q = make({ send: vi.fn().mockRejectedValue(new UploadError(413, 'payload_too_large')), report });
    q.start();
    await q.add([file('northwind-bill.pdf')]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    expect(q.list()[0]!.error).toMatch(/50 MB/);
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain('northwind');
  });

  it('explains a 413 without a code, as a reverse proxy sends it', async () => {
    const q = make({ send: vi.fn().mockRejectedValue(new UploadError(413, undefined)) });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    expect(q.list()[0]!.error).toMatch(/50 MB/);
  });

  it('fails, and reports, a file it could not read', async () => {
    const report = vi.fn();
    const q = make({ send: vi.fn().mockRejectedValue(new TypeError('not a Blob')), report });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    expect(q.list()[0]!.error).toBe('The file could not be read.');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 0, code: 'unreadable' }));
  });

  it('fails a file over the size limit at once, without sending it, and Retry does not send it', async () => {
    const send = vi.fn();
    const q = make({ send, maxBytes: 2 });
    q.start();
    await q.add([{ blob: new Blob(['abc']), name: 'big.pdf', source: 'picker' }]);
    expect(q.list()[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/50 MB/) });
    await q.retry(q.list()[0]!.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).not.toHaveBeenCalled();
    expect(q.list()[0]!.state).toBe('failed');
  });

  it('retries a failed item when asked, and removes one when asked', async () => {
    const send = vi.fn().mockRejectedValueOnce(new UploadError(400, 'empty_file')).mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ send });
    q.start();
    await q.add([file('a.pdf'), file('b.pdf')]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    await vi.waitFor(() => expect(q.list()).toHaveLength(1)); // b went through
    const failed = q.list()[0]!;
    await q.retry(failed.id);
    await vi.waitFor(() => expect(q.list()).toEqual([]));
  });

  it('removes a failed item, but never the one being sent', async () => {
    const d = deferred<SendResult>();
    const send = vi.fn().mockRejectedValueOnce(new UploadError(400, 'empty_file')).mockReturnValueOnce(d.promise);
    const q = make({ send });
    q.start();
    await q.add([file('a.pdf'), file('b.pdf')]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const [failed, sending] = q.list();
    await expect(q.remove(sending!.id)).resolves.toBe(false);
    await expect(q.remove(failed!.id)).resolves.toBe(true);
    expect(q.list().map((i) => i.id)).toEqual([sending!.id]);
    d.resolve({ id: 'd2', duplicate: false });
    await vi.waitFor(() => expect(q.list()).toEqual([]));
  });

  it('waits for a connection while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const send = vi.fn().mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ send });
    q.start();
    await q.add([file('a.pdf')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, 'onLine');
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q.list()).toEqual([]));
  });

  it('tells subscribers when the connection comes and goes', () => {
    const q = make({ send: () => new Promise(() => {}) });
    q.start();
    const changed = vi.fn();
    q.subscribe(changed);
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('pauses on a 401 until started again', async () => {
    const onUnauthorized = vi.fn();
    const send = vi.fn().mockRejectedValueOnce(new UploadError(401, 'not_authenticated')).mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ send, onUnauthorized });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(q.list()[0]!.state).toBe('queued');
    q.stop();
    q.start();
    await vi.waitFor(() => expect(q.list()).toEqual([]));
  });

  it('picks up items left from an earlier session', async () => {
    const store = new MemoryStore();
    await store.put({ id: 'old', name: 'a.pdf', size: 1, blob: new Blob(['x']), source: 'picker', scanId: null, createdAt: 1, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0 });
    const send = vi.fn().mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ store, send });
    q.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('does not send an accepted file again when storage fails to forget it', async () => {
    const store = new MemoryStore();
    store.remove = () => Promise.reject(new Error('storage'));
    const send = vi.fn().mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ store, send });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps an accepted scan on its way until onUploaded has finished', async () => {
    const cleanup = deferred<void>();
    const onUploaded = vi.fn(() => cleanup.promise);
    const q = make({ send: vi.fn().mockResolvedValue({ id: 'd1', duplicate: false }), onUploaded });
    q.start();
    await q.add([{ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner', scanId: 's1' }]);
    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(q.hasScan('s1')).toBe(true);
    cleanup.resolve();
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    expect(q.hasScan('s1')).toBe(false);
  });

  it('knows which scans are already queued', async () => {
    const q = make({ send: () => new Promise(() => {}) });
    await q.add([{ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner', scanId: 's1' }]);
    expect(q.hasScan('s1')).toBe(true);
    expect(q.hasScan('s2')).toBe(false);
  });

  it('queues a scan once, even while its PDF is still being built', async () => {
    const q = make({ send: () => new Promise(() => {}) });
    const pdf = deferred<{ blob: Blob; name: string; source: 'scanner' }>();
    const build = vi.fn(() => pdf.promise);
    const first = q.addScan('s1', build);
    expect(q.hasScan('s1')).toBe(true);
    await q.addScan('s1', build);
    expect(build).toHaveBeenCalledTimes(1);
    pdf.resolve({ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner' });
    await first;
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]).toMatchObject({ scanId: 's1', source: 'scanner' });
  });

  it('lets a scan be queued again when building its PDF failed', async () => {
    const q = make({ send: () => new Promise(() => {}) });
    await expect(q.addScan('s1', () => Promise.reject(new Error('no pages')))).rejects.toThrow('no pages');
    expect(q.hasScan('s1')).toBe(false);
  });
});
