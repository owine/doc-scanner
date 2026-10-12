import { beforeEach, describe, it, expect, vi } from 'vitest';
import { sendDocument, UploadError, UPLOAD_TIMEOUT_MS } from '../../src/uploads/send.js';
import { FakeXhr } from './fake-xhr.js';

const xhr = () => new FakeXhr() as unknown as XMLHttpRequest;
// happy-dom's FormData takes only happy-dom's own Blob, and tests/setup.ts
// makes the global Blob Node's. File is still happy-dom's, so it is accepted.
const input = { blob: new File(['%PDF'], 'x.pdf', { type: 'application/pdf' }), name: 'northwind-bill.pdf', source: 'picker' as const };
const req = () => FakeXhr.last!;

beforeEach(() => {
  FakeXhr.last = null;
});

describe('sendDocument', () => {
  it('posts the file as multipart and resolves with the document id', async () => {
    const done = sendDocument(input, () => {}, xhr);
    expect(req().method).toBe('POST');
    expect(req().url).toBe('/api/documents');
    expect(req().timeout).toBe(UPLOAD_TIMEOUT_MS);
    const body = req().body!;
    expect(body.get('source')).toBe('picker');
    expect(body.get('originalName')).toBe('northwind-bill.pdf');
    expect(body.get('file')).toBeInstanceOf(File);
    req().respond(202, '{"id":"d1"}');
    await expect(done).resolves.toEqual({ id: 'd1', duplicate: false });
  });

  it('treats a duplicate as accepted', async () => {
    const done = sendDocument(input, () => {}, xhr);
    req().respond(200, '{"id":"d0","duplicate":true}');
    await expect(done).resolves.toEqual({ id: 'd0', duplicate: true });
  });

  it('reports progress', async () => {
    const onProgress = vi.fn();
    const done = sendDocument(input, onProgress, xhr);
    req().upload.onprogress!({ lengthComputable: true, loaded: 1, total: 4 });
    expect(onProgress).toHaveBeenCalledWith(0.25);
    req().respond(202, '{"id":"d1"}');
    await done;
  });

  it('rejects with the status and server code', async () => {
    const done = sendDocument(input, () => {}, xhr);
    req().respond(413, '{"error":"payload_too_large"}');
    await expect(done).rejects.toMatchObject({ status: 413, code: 'payload_too_large', transient: false, name: 'UploadError' });
  });

  it('treats a proxy error page, a conflict, a dropped connection and a timeout as transient', async () => {
    const a = sendDocument(input, () => {}, xhr);
    req().respond(502, '<html>Bad gateway</html>');
    await expect(a).rejects.toMatchObject({ status: 502, transient: true });
    const b = sendDocument(input, () => {}, xhr);
    req().respond(409, '{"error":"conflict"}');
    await expect(b).rejects.toMatchObject({ status: 409, code: 'conflict', transient: true });
    const c = sendDocument(input, () => {}, xhr);
    req().onerror!();
    await expect(c).rejects.toBeInstanceOf(UploadError);
    await expect(c).rejects.toMatchObject({ status: 0, transient: true });
    const d = sendDocument(input, () => {}, xhr);
    req().ontimeout!();
    await expect(d).rejects.toMatchObject({ status: 0, code: 'timeout', transient: true });
  });

  it('refuses, for good, a file it cannot read', async () => {
    // Node's Blob (the global here) is not one happy-dom's FormData takes. It
    // stands in for a file the browser can no longer read.
    const done = sendDocument({ ...input, blob: new Blob(['%PDF']) }, () => {}, xhr);
    await expect(done).rejects.toMatchObject({ status: 0, code: 'unreadable', transient: false });
    expect(FakeXhr.last).toBeNull();
  });
});
