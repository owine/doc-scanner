import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drain } from '../src/outbox-drain.js';
import { ScansStore } from '../src/scanner/scans-store.js';
import type { Quad } from '../src/scanner/types.js';

const Q: Quad = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, bl: { x: 0, y: 100 }, br: { x: 100, y: 100 } };
function blobOf(text: string): Blob { return new Blob([text], { type: 'image/jpeg' }); }

let store: ScansStore;
beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

async function makePending(state: 'pending_classify' | 'pending_upload', extras?: { withPdf?: boolean }): Promise<string> {
  const id = await store.createInProgress();
  await store.appendPage(id, blobOf('p1'), Q);
  await store.finish(id);
  await store.setUploadStatus(id, 'pending_classify');
  if (state === 'pending_classify') return id;
  // walk through to pending_upload
  await store.setSuggestionAndOcr(id, undefined, undefined);
  await store.setUploadStatus(id, 'pending_upload', { finalName: 'My File', finalFolderLinkId: 'f1' });
  if (extras?.withPdf) {
    await store.setPdfBlob(id, new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }));
  }
  return id;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('outbox drain', () => {
  it('empty queue → no fetches, all-zero result', async () => {
    const fetchSpy = vi.fn();
    const r = await drain({ fetch: fetchSpy as unknown as typeof fetch, store });
    expect(r).toEqual({ processed: 0, succeeded: 0, needsAttention: 0, classifiedAwaitingConfirm: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('two pending_classify + one pending_upload → all called, in order', async () => {
    const c1 = await makePending('pending_classify');
    const c2 = await makePending('pending_classify');
    const u1 = await makePending('pending_upload', { withPdf: true });
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/classify') return Promise.resolve(jsonResponse(200, { suggestion: null }));
      if (url === '/api/upload') return Promise.resolve(jsonResponse(200, { driveNodeUid: 'n', driveWebUrl: 'u', finalName: 'My File' }));
      return Promise.reject(new Error('unexpected url'));
    });
    const r = await drain({ fetch: fetchSpy as unknown as typeof fetch, store });
    expect(r.processed).toBe(3);
    // findPending returns oldest-first by updatedAt; c1, c2 come before u1.
    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['/api/classify', '/api/classify', '/api/upload']);
    expect((await store.getScan(c1))?.uploadStatus).toBe('awaiting_confirm');
    expect((await store.getScan(c2))?.uploadStatus).toBe('awaiting_confirm');
    expect((await store.getScan(u1))?.uploadStatus).toBe('done');
  });

  it('classify failure → awaiting_confirm with empty suggestion (NOT needs_attention)', async () => {
    const id = await makePending('pending_classify');
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'oops' }));
    const r = await drain({ fetch: fetchSpy as unknown as typeof fetch, store });
    expect(r.classifiedAwaitingConfirm).toBe(1);
    expect(r.needsAttention).toBe(0);
    const scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('awaiting_confirm');
    expect(scan?.suggestion).toBeUndefined();
  });

  it('upload fails three times in 24h → needs_attention on the 4th drain', async () => {
    const id = await makePending('pending_upload', { withPdf: true });
    let now = 1_000_000_000_000;
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(502, { error: 'gateway' }));
    const drainOnce = () => drain({ fetch: fetchSpy as unknown as typeof fetch, store, now: () => now });

    // Three failures stay in pending_upload with bumped retryCount.
    await drainOnce(); now += 1000;
    await drainOnce(); now += 1000;
    await drainOnce(); now += 1000;
    let scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('pending_upload');
    expect(scan?.retryCount).toBe(3);

    // Fourth failure (count > MAX_RETRIES=3) → needs_attention.
    await drainOnce();
    scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('needs_attention');
    expect(scan?.uploadError).toMatch(/upload returned 502/);
  });

  it('upload succeeds on second attempt → done, retry counters cleared', async () => {
    const id = await makePending('pending_upload', { withPdf: true });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(502, { error: 'transient' }))
      .mockResolvedValueOnce(jsonResponse(200, { driveNodeUid: 'n9', driveWebUrl: 'u9', finalName: 'My File' }));

    await drain({ fetch: fetchSpy as unknown as typeof fetch, store });
    let scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('pending_upload');
    expect(scan?.retryCount).toBe(1);

    await drain({ fetch: fetchSpy as unknown as typeof fetch, store });
    scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('done');
    expect(scan?.driveNodeUid).toBe('n9');
    expect(scan?.retryCount).toBe(0);
  });
});
