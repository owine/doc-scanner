import { describe, it, expect, vi, afterEach } from 'vitest';
import { MAX_UPLOAD_BYTES, UploadQueue, type UploadQueueOptions } from '../../src/uploads/queue.js';
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

  it('fails, for good and without sending it, a file the browser can no longer read', async () => {
    const report = vi.fn();
    const send = vi.fn().mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ send, report });
    q.start();
    // A picked file deleted or moved since, or a permission the browser dropped.
    const blob = new Blob(['x'], { type: 'application/pdf' });
    blob.slice = () => ({ arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) }) as unknown as Blob;
    await q.add([{ blob, name: 'a.pdf', source: 'picker' }]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    expect(q.list()[0]!.error).toBe('The file could not be read.');
    expect(send).not.toHaveBeenCalled();
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

  it("fails a file of the server's full 50 MiB at once: the multipart wrapper must fit too", async () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024 - 64 * 1024);
    const send = vi.fn();
    const q = make({ send });
    q.start();
    await q.add([{ blob: new Blob([new Uint8Array(50 * 1024 * 1024)]), name: 'big.pdf', source: 'picker' }]);
    expect(q.list()[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/50 MB/) });
    expect(send).not.toHaveBeenCalled();
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

  it('never sends, or stores again, an item removed while it becomes due', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = new MemoryStore();
    const forget = deferred<void>();
    const removeStored = store.remove.bind(store);
    store.remove = (id) => forget.promise.then(() => removeStored(id));
    const second = deferred<SendResult>();
    second.promise.catch(() => {}); // unused once the fix holds
    const send = vi.fn().mockRejectedValueOnce(new UploadError(503, undefined)).mockReturnValueOnce(second.promise);
    const q = make({ store, send });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.list()[0]).toMatchObject({ state: 'queued', attempts: 1 });
    const removed = q.remove(q.list()[0]!.id);
    await vi.advanceTimersByTimeAsync(5_000); // due again while storage is still removing it
    forget.resolve();
    await expect(removed).resolves.toBe(true);
    second.reject(new UploadError(503, undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.list()).toEqual([]);
    expect(store.items.size).toBe(0);
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

  it('sends a waiting item as soon as the connection comes back, without waiting out its backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const send = vi.fn()
      .mockRejectedValueOnce(new UploadError(0, 'network'))
      .mockResolvedValueOnce({ id: 'd1', duplicate: false });
    const q = make({ send });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.list()[0]).toMatchObject({ state: 'queued', attempts: 1 });
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(1_000);
    Reflect.deleteProperty(navigator, 'onLine');
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2); // 1 s in, not after the 5 s backoff
    expect(q.list()).toEqual([]);
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

  it('ignores a 401 from an upload started before the last sign-in, and sends the file again', async () => {
    const onUnauthorized = vi.fn();
    const first = deferred<SendResult>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ id: 'd1', duplicate: false });
    const q = make({ send, onUnauthorized });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Signed out and in again while it was on its way: the old session's answer arrives late.
    q.stop();
    q.start();
    first.reject(new UploadError(401, 'not_authenticated'));
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    expect(send).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
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

  it('keeps an accepted scan on its way for the rest of the session, and never queues it again', async () => {
    const cleanup = deferred<void>();
    const onUploaded = vi.fn(() => cleanup.promise);
    const q = make({ send: vi.fn().mockResolvedValue({ id: 'd1', duplicate: false }), onUploaded });
    q.start();
    await q.add([{ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner', scanId: 's1' }]);
    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(q.hasScan('s1')).toBe(true);
    cleanup.resolve();
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    // Its local copy may not be gone yet (a device-scan list read just before
    // the delete), or the delete failed: it must not show as left on the device.
    expect(q.hasScan('s1')).toBe(true);
    const build = vi.fn();
    await q.addScan('s1', build);
    expect(build).not.toHaveBeenCalled();
  });

  it('deletes the local scan before forgetting its upload, so a crash between sends it again rather than keeping both', async () => {
    const order: string[] = [];
    const store = new MemoryStore();
    const forget = store.remove.bind(store);
    store.remove = async (id) => {
      order.push('forget upload');
      await forget(id);
    };
    const onUploaded = vi.fn(async () => {
      order.push('delete scan');
    });
    const q = make({ store, send: vi.fn().mockResolvedValue({ id: 'd1', duplicate: false }), onUploaded });
    q.start();
    await q.add([{ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner', scanId: 's1' }]);
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    expect(order).toEqual(['delete scan', 'forget upload']);
    expect(store.items.size).toBe(0);
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
    // The second call waits on the first: it resolves once the scan is queued.
    const second = q.addScan('s1', build);
    expect(second).toBe(first);
    pdf.resolve({ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner' });
    await second;
    expect(build).toHaveBeenCalledTimes(1);
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]).toMatchObject({ scanId: 's1', source: 'scanner' });
  });

  it('fails a second send of a scan along with the first, then lets it be queued again', async () => {
    const q = make({ send: () => new Promise(() => {}) });
    const pdf = deferred<{ blob: Blob; name: string; source: 'scanner' }>();
    const first = q.addScan('s1', () => pdf.promise);
    const second = q.addScan('s1', vi.fn());
    pdf.reject(new Error('no pages'));
    await expect(first).rejects.toThrow('no pages');
    await expect(second).rejects.toThrow('no pages');
    await q.addScan('s1', async () => ({ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner' }));
    expect(q.list()).toHaveLength(1);
  });

  it('remembers why a scan could not be built until it is tried again', async () => {
    const q = make({ send: () => new Promise(() => {}) });
    const changed = vi.fn();
    q.subscribe(changed);
    await expect(q.addScan('s1', () => Promise.reject(new Error('no pages')))).rejects.toThrow('no pages');
    expect(q.buildErrorOf('s1')).toBe('Could not send this scan. Try again.');
    expect(q.buildErrorOf('s2')).toBeNull();
    changed.mockClear();
    const pdf = deferred<{ blob: Blob; name: string; source: 'scanner' }>();
    const again = q.addScan('s1', () => pdf.promise);
    expect(q.buildErrorOf('s1')).toBeNull();
    expect(changed).toHaveBeenCalled();
    pdf.resolve({ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner' });
    await again;
    expect(q.buildErrorOf('s1')).toBeNull();
  });

  it('lets a scan be queued again when building its PDF failed', async () => {
    const q = make({ send: () => new Promise(() => {}) });
    await expect(q.addScan('s1', () => Promise.reject(new Error('no pages')))).rejects.toThrow('no pages');
    expect(q.hasScan('s1')).toBe(false);
  });
});
