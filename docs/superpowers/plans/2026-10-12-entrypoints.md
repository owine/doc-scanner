# Entrypoints (AI document filing, slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents reach the server from the PWA itself. An **Add** button and desktop drag-and-drop in the inbox feed a persistent upload queue that survives going offline and closing the app. The scanner posts finished scans as image-only PDFs instead of OCR-ing them on the phone. The old on-device OCR and the Saved scans screen are retired.

**Architecture:**
- **Upload queue.** A small IndexedDB-backed `UploadQueue` (`pwa/src/uploads/`) holds each file until the server answers `202`/`200` for it.
  - **Order:** one upload at a time, sent with XMLHttpRequest so progress can be shown.
  - **Failures:** transient ones retry with backoff, and a lost connection waits for the `online` event. Permanent ones (413, 400) stop and wait for the user.
  - **Sign-out:** a 401 pauses the queue until the next sign-in.
- **Inbox.** It gains an Add button, a drop target, an **Uploading** section and a one-time **Scans on this device** section for scans saved before this slice.
- **Scanner.** It ends by building an image-only PDF and queueing it. Each local scan is deleted once its upload is accepted.

**Tech Stack:** Preact 10, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `idb`, `@cantoo/pdf-lib`, Vitest, happy-dom, `fake-indexeddb`, `@testing-library/preact`.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`, §3 "Intake" (PWA bullets) and "Delivery slices" item 4.

---

## Scope decisions (user, 2026-10-12)

- **Client OCR and Saved scans are retired.** This removes `src/ocr/`, the Tesseract dependencies and assets, `SavedScansScreen`, `ScanViewerScreen`, the PDF download, and the PDF/OCR fields of `ScansStore`.
  - Scans already saved on the phone appear once, in an inbox section **Scans on this device**, each with **Send to inbox** or **Delete**.
  - Nothing uploads without the user choosing it.
- **Adding happens in the inbox**, with no separate screen.
  - An **Add** button opens the multi-file picker, and on desktop files can be dropped anywhere on the inbox.
  - Uploads show in an **Uploading** section, with progress, until the server has them. They then turn into normal inbox items.
- **Slice 3 (server OCR) is not built yet.** Scans are filed as image-only PDFs, with no text layer, until it lands. The analyzer reads page images, so naming and filing still work.

## Conventions for every task

- **Node:** before any `pnpm`, run `export PATH="$HOME/.local/share/fnm/node-versions/v$(cat .nvmrc | tr -d v)/installation/bin:$PATH"` from the repo root.
- **Running checks:**
  - One PWA test file: `cd pwa && pnpm exec vitest run <file>`.
  - Full PWA suite: `pnpm --filter @doc-scanner/pwa test`.
  - Typecheck: `pnpm --filter @doc-scanner/pwa run typecheck`.
  - Build: `pnpm --filter @doc-scanner/pwa build`.
- **Strict TypeScript:** `exactOptionalPropertyTypes` is on, so never pass `undefined` to an optional prop. `noUncheckedIndexedAccess` is on too.
- **Teardown race:** every UI test must `await` the final state it caused. The PWA suite has a known happy-dom teardown race that surfaces as "document is not defined".
- **Fictional data only.** The repo is public.
- **Commits:** Conventional Commits, one per task unless a step says otherwise. Commits are signed automatically. `git add` only the task's own files, and never use `git stash`.
- **Privacy:** file names and document contents never go to the console or Sentry. A reported upload failure carries its HTTP status and server error code, nothing else.

## File map

| File | Responsibility |
|---|---|
| `pwa/src/pdf/build.ts` | `buildImagePdf(pages)`: one JPEG per page, no text layer |
| `pwa/src/uploads/types.ts` | `UploadItem`, `UploadSource` |
| `pwa/src/uploads/upload-store.ts` | IndexedDB persistence for queued uploads (`docscanner-uploads`) |
| `pwa/src/uploads/send.ts` | `sendDocument`: one multipart POST with progress; `UploadError` |
| `pwa/src/uploads/queue.ts` | `UploadQueue` (order, retries, offline, 401 pause) and the `useUploads` hook |
| `pwa/src/uploads/scans.ts` | `scanFileName`, `sendScanToInbox`, the `useDeviceScans` hook |
| `pwa/src/ui/inbox/UploadRows.tsx` | Uploading rows and device-scan rows |
| `pwa/src/ui/inbox/InboxScreen.tsx` | Add button, drop target, the two new sections |
| `pwa/src/ui/ScannerScreen.tsx` | Done hands the scan id to the app |
| `pwa/src/ui/App.tsx` | Owns the `UploadQueue`; routes the scanner into it; removes saved/viewer routes |
| `pwa/src/scanner/{scans-store,scanner-session,types}.ts` | PDF/OCR fields and methods removed |
| removed | `src/ocr/`, `src/ui/{SavedScansScreen,ScanViewerScreen}.tsx`, `src/ui/download.ts`, `scripts/copy-tesseract-assets.mjs`, `public/ocr/`, the Tesseract deps |

---

## Task 1: `buildImagePdf`

**Files:**
- Modify: `pwa/src/pdf/build.ts`
- Test: `pwa/tests/pdf/build.test.ts`

Add an image-only builder next to `buildSearchablePdf`. The old builder is removed with the rest of the OCR code in Task 8.

- [ ] **Step 1: Write the failing test.** Append to `pwa/tests/pdf/build.test.ts`. The file already loads the fixture `src/pdf/fixtures/2x1-red.jpg`; reuse its loader and blob helper.

```ts
import { buildImagePdf } from '../../src/pdf/build.js';
import { PDFDocument } from '@cantoo/pdf-lib';

describe('buildImagePdf', () => {
  it('makes one page per image, sized to the image at 144 dpi', async () => {
    const jpg = await fixtureJpegBlob(); // the file's existing fixture helper; adapt the name
    const pdf = await buildImagePdf([jpg, jpg]);
    expect(pdf.type).toBe('application/pdf');
    const doc = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(2 * 0.5); // 2×1 px at 72/144 pt per px
    expect(height).toBeCloseTo(1 * 0.5);
  });

  it('refuses an empty scan', async () => {
    await expect(buildImagePdf([])).rejects.toThrow(/no pages/);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** `cd pwa && pnpm exec vitest run tests/pdf/build.test.ts`. Expected: `buildImagePdf` is not exported.

- [ ] **Step 3: Implement.** Add to `pwa/src/pdf/build.ts`:

```ts
/**
 * An image-only PDF: each page is one scanned JPEG, with no text layer.
 * The server adds the text layer (spec §4, slice 3).
 */
export async function buildImagePdf(pages: readonly Blob[]): Promise<Blob> {
  if (pages.length === 0) throw new Error('a scan with no pages has nothing to build');
  const doc = await PDFDocument.create();
  for (const blob of pages) {
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const widthPt = image.width * PT_PER_PX;
    const heightPt = image.height * PT_PER_PX;
    doc.addPage([widthPt, heightPt]).drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  const out = await doc.save();
  return new Blob([out.buffer as ArrayBuffer], { type: 'application/pdf' });
}
```

- [ ] **Step 4: Run the test and the typecheck.** Both pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): build image-only PDFs from scanned pages"`

---

## Task 2: Upload store and sender

**Files:**
- Create: `pwa/src/uploads/types.ts`, `pwa/src/uploads/upload-store.ts`, `pwa/src/uploads/send.ts`
- Test: `pwa/tests/uploads/upload-store.test.ts`, `pwa/tests/uploads/send.test.ts`

`fetch` can't report upload progress, so the sender uses XMLHttpRequest. Tests inject a fake XHR.

- [ ] **Step 1: Types.** `pwa/src/uploads/types.ts`:

```ts
export type UploadSource = 'picker' | 'scanner';

/** A file waiting to reach the server. Kept in IndexedDB until the server has it. */
export interface UploadItem {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  source: UploadSource;
  /** For a scan: the local scan to delete once the server has accepted the upload. */
  scanId: string | null;
  createdAt: number;
  attempts: number;
  /** 'failed' is permanent (the server refused the file) until the user retries. */
  state: 'queued' | 'failed';
  /** Shown to the user when failed. Never a file name. */
  error: string | null;
  nextAttemptAt: number;
}
```

- [ ] **Step 2: Write the failing tests.**

`pwa/tests/uploads/upload-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { UploadStore } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';

const item = (id: string, createdAt: number): UploadItem => ({
  id, name: `${id}.pdf`, size: 3, blob: new Blob(['abc'], { type: 'application/pdf' }), source: 'picker',
  scanId: null, createdAt, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0,
});

describe('UploadStore', () => {
  it('keeps items, oldest first, until removed', async () => {
    const store = new UploadStore();
    await store.put(item('b', 2));
    await store.put(item('a', 1));
    expect((await store.all()).map((i) => i.id)).toEqual(['a', 'b']);
    await store.remove('a');
    expect((await store.all()).map((i) => i.id)).toEqual(['b']);
  });

  it('keeps the file bytes', async () => {
    const store = new UploadStore();
    await store.put(item('a', 1));
    const [got] = await store.all();
    expect(await got!.blob.text()).toBe('abc');
  });
});
```

`pwa/tests/uploads/send.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { sendDocument, UploadError } from '../../src/uploads/send.js';

class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  withCredentials = false;
  status = 0;
  responseText = '';
  body: FormData | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  send(body: FormData) { this.body = body; }
  respond(status: number, text: string) { this.status = status; this.responseText = text; this.onload?.(); }
}
const xhr = () => new FakeXhr() as unknown as XMLHttpRequest;
const input = { blob: new Blob(['%PDF'], { type: 'application/pdf' }), name: 'northwind-bill.pdf', source: 'picker' as const };

describe('sendDocument', () => {
  it('posts the file as multipart and resolves with the document id', async () => {
    const done = sendDocument(input, () => {}, xhr);
    const req = FakeXhr.last;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/documents');
    expect(req.body!.get('source')).toBe('picker');
    expect(req.body!.get('originalName')).toBe('northwind-bill.pdf');
    expect(req.body!.get('file')).toBeInstanceOf(Blob);
    req.respond(202, '{"id":"d1"}');
    await expect(done).resolves.toEqual({ id: 'd1', duplicate: false });
  });

  it('treats a duplicate as accepted', async () => {
    const done = sendDocument(input, () => {}, xhr);
    FakeXhr.last.respond(200, '{"id":"d0","duplicate":true}');
    await expect(done).resolves.toEqual({ id: 'd0', duplicate: true });
  });

  it('reports progress', async () => {
    const onProgress = vi.fn();
    const done = sendDocument(input, onProgress, xhr);
    FakeXhr.last.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 4 });
    expect(onProgress).toHaveBeenCalledWith(0.25);
    FakeXhr.last.respond(202, '{"id":"d1"}');
    await done;
  });

  it('rejects with the status and server code', async () => {
    const done = sendDocument(input, () => {}, xhr);
    FakeXhr.last.respond(413, '{"error":"payload_too_large"}');
    await expect(done).rejects.toMatchObject({ status: 413, code: 'payload_too_large', transient: false });
  });

  it('treats a proxy error page and a dropped connection as transient', async () => {
    const a = sendDocument(input, () => {}, xhr);
    FakeXhr.last.respond(502, '<html>Bad gateway</html>');
    await expect(a).rejects.toMatchObject({ status: 502, transient: true });
    const b = sendDocument(input, () => {}, xhr);
    FakeXhr.last.onerror!();
    await expect(b).rejects.toBeInstanceOf(UploadError);
    await expect(b).rejects.toMatchObject({ status: 0, transient: true });
  });
});
```

- [ ] **Step 3: Run them and see them fail.**

- [ ] **Step 4: Implement.**

`pwa/src/uploads/upload-store.ts`:

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { UploadItem } from './types.js';

interface UploadsSchema extends DBSchema {
  uploads: { key: string; value: UploadItem };
}

/** Its own database, so it never shares a schema version with the scans store. */
const DB_NAME = 'docscanner-uploads';

export interface UploadStorage {
  all(): Promise<UploadItem[]>;
  put(item: UploadItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export class UploadStore implements UploadStorage {
  private db: Promise<IDBPDatabase<UploadsSchema>> | null = null;

  private get d(): Promise<IDBPDatabase<UploadsSchema>> {
    this.db ??= openDB<UploadsSchema>(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('uploads', { keyPath: 'id' });
      },
    });
    return this.db;
  }

  async all(): Promise<UploadItem[]> {
    return (await (await this.d).getAll('uploads')).sort((a, b) => a.createdAt - b.createdAt);
  }

  async put(item: UploadItem): Promise<void> {
    await (await this.d).put('uploads', item);
  }

  async remove(id: string): Promise<void> {
    await (await this.d).delete('uploads', id);
  }
}
```

`pwa/src/uploads/send.ts`:

```ts
import type { UploadSource } from './types.js';

export interface SendInput {
  blob: Blob;
  name: string;
  source: UploadSource;
}

export interface SendResult {
  id: string;
  duplicate: boolean;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(code ?? `upload failed (${status})`);
  }

  /** Worth retrying: the network or the server failed, not the file. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export type XhrFactory = () => XMLHttpRequest;

/** One multipart POST to /api/documents. XMLHttpRequest, not fetch, for upload progress. */
export function sendDocument(
  input: SendInput,
  onProgress: (fraction: number) => void,
  xhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const req = xhr();
    req.open('POST', '/api/documents');
    req.withCredentials = true;
    req.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    req.onload = () => {
      let body: { id?: unknown; duplicate?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse(req.responseText) as typeof body;
      } catch {
        // A reverse proxy's HTML error page: classify on the status alone.
      }
      if ((req.status === 200 || req.status === 202) && typeof body.id === 'string') {
        resolve({ id: body.id, duplicate: body.duplicate === true });
      } else {
        reject(new UploadError(req.status, typeof body.error === 'string' ? body.error : undefined));
      }
    };
    req.onerror = () => reject(new UploadError(0, 'network'));
    req.ontimeout = () => reject(new UploadError(0, 'timeout'));
    const form = new FormData();
    form.append('file', input.blob, input.name);
    form.append('source', input.source);
    form.append('originalName', input.name);
    req.send(form);
  });
}
```

- [ ] **Step 5: Run both test files and the typecheck.** All pass.

- [ ] **Step 6: Commit.** `git commit -m "feat(pwa): persist uploads and send them with progress"`

---

## Task 3: `UploadQueue`

**Files:**
- Create: `pwa/src/uploads/queue.ts`
- Test: `pwa/tests/uploads/queue.test.ts`

**Rules:**
- **Order:** one upload at a time, oldest first.
- **Success** (`202`, or a `200` duplicate): the item leaves the queue and `onUploaded` runs.
- **Transient failure:** the item stays queued with backoff of 5 s, 15 s, 60 s, then 5 min.
- **Offline:** nothing is attempted until the `online` event fires.
- **Permanent failure:** the item becomes `failed` with a plain-language reason and is reported, by status and code only. It waits for **Retry** or **Remove**.
- **401:** the queue pauses and calls `onUnauthorized`. The next `start()`, at sign-in, resumes it.

The item list is replaced, never mutated, on every change, so `list()` returns a stable reference between changes. This matches `DocumentSync`.

- [ ] **Step 1: Write the failing test.** `pwa/tests/uploads/queue.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { UploadQueue } from '../../src/uploads/queue.js';
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

afterEach(() => { vi.useRealTimers(); });

describe('UploadQueue', () => {
  it('uploads one at a time, oldest first, and forgets each once accepted', async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const pending = [deferred<SendResult>(), deferred<SendResult>()];
    const send = vi.fn((input: { name: string }) => { calls.push(input.name); return pending[calls.length - 1]!.promise; });
    const onUploaded = vi.fn();
    const q = new UploadQueue({ store, send, onUploaded });
    q.start();
    await q.add([file('a.pdf'), file('b.pdf')]);
    await vi.waitFor(() => expect(calls).toEqual(['a.pdf']));
    pending[0]!.resolve({ id: 'd1', duplicate: false });
    await vi.waitFor(() => expect(calls).toEqual(['a.pdf', 'b.pdf']));
    pending[1]!.resolve({ id: 'd2', duplicate: false });
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    expect(store.items.size).toBe(0);
    expect(onUploaded).toHaveBeenCalledTimes(2);
    q.stop();
  });

  it('shows progress for the item being sent', async () => {
    const d = deferred<SendResult>();
    let report!: (f: number) => void;
    const q = new UploadQueue({ store: new MemoryStore(), send: (_i, onProgress) => { report = onProgress; return d.promise; } });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(report).toBeDefined());
    report(0.5);
    expect(q.progressOf(q.list()[0]!.id)).toBe(0.5);
    d.resolve({ id: 'd1', duplicate: false });
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    q.stop();
  });

  it('retries a transient failure after a backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const send = vi.fn()
      .mockRejectedValueOnce(new UploadError(503, undefined))
      .mockResolvedValueOnce({ id: 'd1', duplicate: false });
    const q = new UploadQueue({ store: new MemoryStore(), send });
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
    q.stop();
  });

  it('stops on a permanent failure, explains it and reports it without the name', async () => {
    const report = vi.fn();
    const q = new UploadQueue({ store: new MemoryStore(), send: vi.fn().mockRejectedValue(new UploadError(413, 'payload_too_large')), report });
    q.start();
    await q.add([file('northwind-bill.pdf')]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    expect(q.list()[0]!.error).toMatch(/50 MB/);
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain('northwind');
    q.stop();
  });

  it('retries a failed item when asked, and removes one when asked', async () => {
    const send = vi.fn().mockRejectedValueOnce(new UploadError(400, 'empty_file')).mockResolvedValue({ id: 'd1', duplicate: false });
    const q = new UploadQueue({ store: new MemoryStore(), send });
    q.start();
    await q.add([file('a.pdf'), file('b.pdf')]);
    await vi.waitFor(() => expect(q.list()[0]?.state).toBe('failed'));
    await vi.waitFor(() => expect(q.list()).toHaveLength(1)); // b went through
    const failed = q.list()[0]!;
    await q.retry(failed.id);
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    q.stop();
  });

  it('removes a failed item, but never the one being sent', async () => {
    const d = deferred<SendResult>();
    const send = vi.fn().mockRejectedValueOnce(new UploadError(400, 'empty_file')).mockReturnValueOnce(d.promise);
    const q = new UploadQueue({ store: new MemoryStore(), send });
    q.start();
    await q.add([file('a.pdf'), file('b.pdf')]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const [failed, sending] = q.list();
    await expect(q.remove(sending!.id)).resolves.toBe(false);
    await expect(q.remove(failed!.id)).resolves.toBe(true);
    expect(q.list().map((i) => i.id)).toEqual([sending!.id]);
    d.resolve({ id: 'd2', duplicate: false });
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    q.stop();
  });

  it('waits for a connection while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      const send = vi.fn().mockResolvedValue({ id: 'd1', duplicate: false });
      const q = new UploadQueue({ store: new MemoryStore(), send });
      q.start();
      await q.add([file('a.pdf')]);
      await new Promise((r) => setTimeout(r, 0));
      expect(send).not.toHaveBeenCalled();
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(q.list()).toEqual([]));
      q.stop();
    } finally {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    }
  });

  it('pauses on a 401 until started again', async () => {
    const onUnauthorized = vi.fn();
    const send = vi.fn().mockRejectedValueOnce(new UploadError(401, 'not_authenticated')).mockResolvedValue({ id: 'd1', duplicate: false });
    const q = new UploadQueue({ store: new MemoryStore(), send, onUnauthorized });
    q.start();
    await q.add([file('a.pdf')]);
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(q.list()[0]!.state).toBe('queued');
    q.stop();
    q.start();
    await vi.waitFor(() => expect(q.list()).toEqual([]));
    q.stop();
  });

  it('picks up items left from an earlier session', async () => {
    const store = new MemoryStore();
    await store.put({ id: 'old', name: 'a.pdf', size: 1, blob: new Blob(['x']), source: 'picker', scanId: null, createdAt: 1, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0 });
    const send = vi.fn().mockResolvedValue({ id: 'd1', duplicate: false });
    const q = new UploadQueue({ store, send });
    q.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    q.stop();
  });

  it('knows which scans are already queued', async () => {
    const q = new UploadQueue({ store: new MemoryStore(), send: () => new Promise(() => {}) });
    await q.add([{ blob: new Blob(['x']), name: 'Scan.pdf', source: 'scanner', scanId: 's1' }]);
    expect(q.hasScan('s1')).toBe(true);
    expect(q.hasScan('s2')).toBe(false);
  });
});
```
- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement.** `pwa/src/uploads/queue.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';
import { sendDocument, UploadError, type SendInput, type SendResult } from './send.js';
import type { UploadItem, UploadSource } from './types.js';
import { UploadStore, type UploadStorage } from './upload-store.js';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/** Plain-language reasons for the server's permanent refusals. */
const REFUSALS: Record<string, string> = {
  payload_too_large: 'Too large to upload (the limit is 50 MB).',
  empty_file: 'The file is empty.',
  missing_file: 'The file could not be read.',
  invalid_source: 'The upload was refused.',
};

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
  private readonly store: UploadStorage;
  private readonly send: NonNullable<UploadQueueOptions['send']>;
  private readonly now: () => number;
  private loading: Promise<void> | null = null;
  private active: string | null = null;
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: UploadQueueOptions = {}) {
    this.store = o.store ?? new UploadStore();
    this.send = o.send ?? ((input, onProgress) => sendDocument(input, onProgress));
    this.now = o.now ?? Date.now;
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

  hasScan(scanId: string): boolean {
    return this.items.some((i) => i.scanId === scanId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async add(files: readonly NewUpload[]): Promise<void> {
    await this.load();
    for (const f of files) {
      const now = this.now();
      const item: UploadItem = {
        id: crypto.randomUUID(),
        name: f.name,
        size: f.blob.size,
        blob: f.blob,
        source: f.source,
        scanId: f.scanId ?? null,
        createdAt: now,
        attempts: 0,
        state: 'queued',
        error: null,
        nextAttemptAt: now,
      };
      await this.store.put(item);
      this.items = [...this.items, item];
    }
    this.emit();
    this.kick();
  }

  async retry(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    await this.save({ ...item, state: 'queued', error: null, attempts: 0, nextAttemptAt: this.now() });
    this.kick();
  }

  /** Not while it is being sent: the server may already have it. */
  async remove(id: string): Promise<boolean> {
    if (this.active === id) return false;
    await this.store.remove(id);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
    return true;
  }

  start(): void {
    this.paused = false;
    if (!this.running) {
      this.running = true;
      window.addEventListener('online', this.kick);
    }
    void this.load().then(this.kick);
  }

  stop(): void {
    this.running = false;
    window.removeEventListener('online', this.kick);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private load(): Promise<void> {
    this.loading ??= this.store.all().then((stored) => {
      const known = new Set(this.items.map((i) => i.id));
      this.items = [...stored.filter((i) => !known.has(i.id)), ...this.items];
      this.emit();
    });
    return this.loading;
  }

  private async save(item: UploadItem): Promise<void> {
    await this.store.put(item);
    this.items = this.items.map((i) => (i.id === item.id ? item : i));
    this.emit();
  }

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
    this.active = item.id;
    this.progress.set(item.id, 0);
    this.emit();
    try {
      const result = await this.send({ blob: item.blob, name: item.name, source: item.source }, (fraction) => {
        this.progress.set(item.id, fraction);
        this.emit();
      });
      await this.store.remove(item.id);
      this.items = this.items.filter((i) => i.id !== item.id);
      try {
        await this.o.onUploaded?.(item, result);
      } catch {
        // The upload succeeded; a failing follow-up must not put it back.
      }
    } catch (err) {
      const e = err instanceof UploadError ? err : new UploadError(0, 'network');
      if (e.status === 401) {
        this.paused = true;
        this.o.onUnauthorized?.();
      } else if (e.transient) {
        const attempts = item.attempts + 1;
        const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
        await this.save({ ...item, attempts, nextAttemptAt: this.now() + wait });
      } else {
        await this.save({ ...item, state: 'failed', error: (e.code && REFUSALS[e.code]) || `The server refused this file (${e.code ?? e.status}).` });
        this.o.report?.(e);
      }
    } finally {
      this.active = null;
      this.progress.delete(item.id);
      this.emit();
      this.kick();
    }
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
```

`kick` is an arrow property, but `start()` uses it before the constructor body would have defined it in source order. Class fields are initialised before the constructor body runs, so this is fine. Declare `kick` above `start` if a linter objects.

- [ ] **Step 4: Run the test (5 times; it uses timers) and the typecheck.** All pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): queue uploads with retries, offline waits and a sign-in pause"`

---

## Task 4: Scans into the queue

**Files:**
- Create: `pwa/src/uploads/scans.ts`
- Test: `pwa/tests/uploads/scans.test.ts`

- [ ] **Step 1: Write the failing test.** `pwa/tests/uploads/scans.test.ts`. It uses the real `ScansStore` on `fake-indexeddb`, as `tests/scanner/scans-store.test.ts` does; copy its setup and its JPEG/quad helpers.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ScansStore } from '../../src/scanner/scans-store.js';
import { UploadQueue } from '../../src/uploads/queue.js';
import { scanFileName, sendScanToInbox } from '../../src/uploads/scans.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';

class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()]; }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

let store: ScansStore;
beforeEach(async () => {
  store = new ScansStore();
  await store.open();
});

describe('scanFileName', () => {
  it('names a scan by its local date and time', () => {
    expect(scanFileName(new Date(2026, 9, 12, 9, 5))).toBe('Scan 2026-10-12 09.05.pdf');
  });
});

describe('sendScanToInbox', () => {
  it('queues the scan as one image-only PDF, tied to its scan id', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, await jpegBlob(), QUAD);   // the scans-store test's helpers
    await store.appendPage(id, await jpegBlob(), QUAD);
    await store.finish(id);
    const queue = new UploadQueue({ store: new MemoryStore(), send: () => new Promise(() => {}) });
    await sendScanToInbox(store, queue, id, new Date(2026, 9, 12, 9, 5));
    const [item] = queue.list();
    expect(item).toMatchObject({ source: 'scanner', scanId: id, name: 'Scan 2026-10-12 09.05.pdf' });
    expect(item!.blob.type).toBe('application/pdf');
  });

  it('does not queue the same scan twice', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, await jpegBlob(), QUAD);
    await store.finish(id);
    const queue = new UploadQueue({ store: new MemoryStore(), send: () => new Promise(() => {}) });
    await sendScanToInbox(store, queue, id);
    await sendScanToInbox(store, queue, id);
    expect(queue.list()).toHaveLength(1);
  });
});
```

`buildImagePdf` needs real JPEG bytes. If the scans-store test's blobs are not JPEGs, load `src/pdf/fixtures/2x1-red.jpg` the way `tests/pdf/build.test.ts` does.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement.** `pwa/src/uploads/scans.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';
import { buildImagePdf } from '../pdf/build.js';
import type { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';
import type { UploadQueue } from './queue.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** "Scan 2026-10-12 09.05.pdf", in local time. The analyzer names it properly. */
export function scanFileName(at: Date): string {
  return `Scan ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.pdf`;
}

/** Queues a finished scan as one image-only PDF. Its local copy is deleted once the server has it (App). */
export async function sendScanToInbox(store: ScansStore, queue: UploadQueue, scanId: string, at = new Date()): Promise<void> {
  if (queue.hasScan(scanId)) return;
  const pages = await store.getPages(scanId);
  const pdf = await buildImagePdf(pages.map((p) => p.blob));
  await queue.add([{ blob: pdf, name: scanFileName(at), source: 'scanner', scanId }]);
}

/**
 * Finished scans still on this device that are not already on their way:
 * saved before scans went to the server, or left behind when building their
 * PDF failed.
 */
export function useDeviceScans(store: ScansStore, queue: UploadQueue): { scans: Scan[]; reload: () => Promise<void> } {
  const [all, setAll] = useState<Scan[]>([]);
  const reload = async () => {
    try {
      setAll(await store.listCompleted());
    } catch {
      setAll([]);
    }
  };
  useEffect(() => {
    void reload();
    // Reload when an upload finishes: its scan may have been deleted.
    return queue.subscribe(() => void reload());
  }, [store, queue]);
  return { scans: all.filter((s) => !queue.hasScan(s.id)), reload };
}
```

`useDeviceScans` has no test of its own; Task 6 covers it through the inbox. The `queue.subscribe` reload runs on every progress tick. If that makes the tests slow, reload only when the number of queued items changes, and explain the change in your report.

- [ ] **Step 4: Run the test and the typecheck.** Both pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): send finished scans to the inbox as PDFs"`

---

## Task 5: Add, drop and the Uploading section

**Files:**
- Create: `pwa/src/ui/inbox/UploadRows.tsx`
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`, `pwa/src/theme/theme.css`
- Test: `pwa/tests/ui/InboxScreen.test.tsx` (update the setup helper), `pwa/tests/ui/UploadRows.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Setup:** update the `setup()` helper in `InboxScreen.test.tsx` to also build an `UploadQueue` over an in-memory store, with `send` a never-resolving function unless a test overrides it, and to pass it as `uploads`. Also pass a real `ScansStore` (opened) as `scans` for Task 6. Existing tests must keep passing.
  - **New `InboxScreen` tests:**
    - **Add button:** choosing two files on the hidden `input[type=file][multiple]` (find it via `container.querySelector`, then `fireEvent.change` with `target: { files: [...] }`) adds two `picker` items. They show under a region named **Uploading**, and the input is cleared after.
    - **Drop:** a `drop` event on the main element with `dataTransfer: { files: [file] }` adds one item. A `dragover` shows the "Drop files to add them" overlay, and a `drop` hides it.
    - **Progress:** the item being sent shows "Uploading… 50%" when the fake `send` reports 0.5.
    - **Failed item:** shows the reason and **Retry** / **Remove**. Retry calls `queue.retry`, and Remove takes the row away.
    - **Waiting items:** a queued item that isn't being sent reads "Waiting to upload". When `navigator.onLine` is false it reads "Waiting for a connection".
    - **Saved scans gone:** there is no **Saved scans** button any more.
  - **`UploadRows.test.tsx`:** the rows on their own, for each state above.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Rows.** `pwa/src/ui/inbox/UploadRows.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { UploadQueue } from '../../uploads/queue.js';
import type { UploadItem } from '../../uploads/types.js';
import type { Scan } from '../../scanner/types.js';

function status(item: UploadItem, queue: UploadQueue): string {
  if (item.state === 'failed') return item.error ?? 'The upload failed.';
  if (queue.isSending(item.id)) return `Uploading… ${Math.round((queue.progressOf(item.id) ?? 0) * 100)}%`;
  if (navigator.onLine === false) return 'Waiting for a connection';
  return item.attempts > 0 ? 'Retrying soon' : 'Waiting to upload';
}

export function UploadRow({ item, queue }: { item: UploadItem; queue: UploadQueue }) {
  const nameId = `upload-name-${item.id}`;
  const sending = queue.isSending(item.id);
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name" id={nameId}>
          {item.name}
        </div>
        <div class={item.state === 'failed' ? 'error-text' : 'muted'}>{status(item, queue)}</div>
        {sending && <progress max={1} value={queue.progressOf(item.id) ?? 0} aria-describedby={nameId} />}
      </div>
      {item.state === 'failed' && (
        <>
          <button type="button" class="btn btn-small" aria-describedby={nameId} onClick={() => void queue.retry(item.id)}>
            Retry
          </button>
          <button type="button" class="btn btn-secondary btn-small" aria-describedby={nameId} onClick={() => void queue.remove(item.id)}>
            Remove
          </button>
        </>
      )}
    </li>
  );
}

export function DeviceScanRow({ scan, onSend, onDelete }: { scan: Scan; onSend: () => Promise<void>; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const nameId = `scan-name-${scan.id}`;
  async function run(action: () => Promise<void>, what: string) {
    setBusy(true);
    setFailed(null);
    try {
      await action();
    } catch {
      setFailed(what);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name" id={nameId}>
          Scan · {scan.pageCount} {scan.pageCount === 1 ? 'page' : 'pages'}
        </div>
        <div class="muted">{new Date(scan.updatedAt).toLocaleString()}</div>
        {failed && <div class="error-text">{failed}</div>}
      </div>
      <button type="button" class="btn btn-small" disabled={busy} aria-describedby={nameId} onClick={() => void run(onSend, 'Could not send this scan. Try again.')}>
        Send to inbox
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-small"
        disabled={busy}
        aria-describedby={nameId}
        onClick={() => {
          if (window.confirm('Delete this scan from this device? It has not been sent anywhere.')) void run(onDelete, 'Could not delete this scan.');
        }}
      >
        Delete
      </button>
    </li>
  );
}
```

- [ ] **Step 4: Inbox.** In `InboxScreen.tsx`:
  - **Props:** add `uploads: UploadQueue` and `scans: ScansStore` (stable, like `documents`), and remove `onSavedScans` along with its footer button.
  - **Queue items:** read them with `const pending = useUploads(uploads);`.
  - **Add:** a hidden `<input type="file" multiple ref={fileInput} class="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={…}>`. The **Add** button in the header, before **Scan**, calls `fileInput.current?.click()`. In `onChange`, queue every chosen file as `{ blob: f, name: f.name, source: 'picker' }` and then set `input.value = ''`.
  - **Drop:** on `<main>`, `onDragOver` calls `preventDefault()` and sets `dragging` when `e.dataTransfer?.types.includes('Files')`. `onDragLeave` clears `dragging` only when `e.relatedTarget` is null or outside `<main>`. `onDrop` calls `preventDefault()`, clears `dragging`, and queues `e.dataTransfer.files`. While `dragging`, render `<div class="drop-overlay" aria-hidden="true">Drop files to add them</div>`.
  - **Uploading section:** when `pending.length > 0`, render `<Section id="uploading" title="Uploading">` above **Needs review**, with one `UploadRow` per item.

- [ ] **Step 5: Styles.** Append to `pwa/src/theme/theme.css`:

```css
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.inbox { position: relative; }
.drop-overlay {
  position: fixed; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border: 3px dashed var(--accent);
  font-size: 20px; font-weight: 600; pointer-events: none;
}
.doc-main progress { width: 100%; height: 6px; margin-top: 4px; accent-color: var(--accent); }
```

- [ ] **Step 6: Run the tests 3 times, then the typecheck.** All pass.

- [ ] **Step 7: Commit.** `git commit -m "feat(pwa): add files to the inbox by picker or drag and drop"`

---

## Task 6: Scans on this device

**Files:**
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`
- Test: `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Section shown:** with one finished scan in the test's `ScansStore`, a region **Scans on this device** lists "Scan · 1 page".
  - **Send to inbox:** the scan moves to **Uploading** as a `scanner` item and disappears from the device section.
  - **Delete:** with `confirm` returning true, it deletes the scan and the section disappears. With `confirm` returning false, nothing happens.
  - **No scans:** with no finished scans, the section is absent.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** In `InboxScreen.tsx`:
  - Add `const device = useDeviceScans(scans, uploads);`.
  - When `device.scans.length > 0`, render `<Section id="device" title="Scans on this device">` right after **Uploading**. Give it one `DeviceScanRow` per scan:
    - `onSend={() => sendScanToInbox(scans, uploads, s.id)}`
    - `onDelete={async () => { await scans.delete(s.id); await device.reload(); }}`
  - Above the list, add one muted line: "Saved before scans went straight to your inbox. Send them or delete them."

- [ ] **Step 4: Run the tests 3 times and the typecheck.** All pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): offer scans saved on the device to the inbox"`

---

## Task 7: Scanner and app wiring

**Files:**
- Modify: `pwa/src/ui/ScannerScreen.tsx`, `pwa/src/ui/App.tsx`
- Test: `pwa/tests/ui/App.test.tsx`

- [ ] **Step 1: Write the failing tests** in `App.test.tsx`:
  - **Uploads start after sign-in.** Seed the upload database with a queued item. Note that `fake-indexeddb` is reset per test by `tests/setup.ts`, so seed through `new UploadStore().put(...)` before rendering. After sign-in, a `POST /api/documents` is sent.
  - **A 401 from an upload lands on the login screen.**
  - **The Saved scans route is gone**: the inbox has no **Saved scans** button.

  The fake `fetch` in this file handles `/api/*`. Uploads use XMLHttpRequest, so stub `XMLHttpRequest` with the `FakeXhr` from Task 2's test. Move it to `pwa/tests/uploads/fake-xhr.ts` and import it in both files. Use `vi.stubGlobal('XMLHttpRequest', FakeXhr)`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Scanner.** In `ScannerScreen.tsx`:
  - Drop the `queue` prop and the `OcrQueue` import.
  - Change `onDone` to `(scanId: string) => void`.
  - In `done()`, replace `queue.enqueueAfterFinish(scanId); onDone();` with `onDone(scanId);`.

- [ ] **Step 4: App.** In `App.tsx`:
  - Remove `OcrQueue`, `WorkerClient`, `buildSearchablePdf`, the `saved` and `viewer` routes, and their imports.
  - Create the queue next to the sync:

```tsx
  const [uploads] = useState(
    () =>
      new UploadQueue({
        onUploaded: async (item) => {
          // The server has the scan; its copy on this device can go.
          if (item.scanId) await storeOpen.then(() => store.delete(item.scanId!));
          void sync.poll();
        },
        onUnauthorized: () => {
          setEmail(null);
          setRoute({ kind: 'inbox' });
        },
        report: (err) =>
          captureRequestFailure(err, { operation: 'document-upload', path: '/api/documents', failure: 'http', status: err.status }),
      }),
  );
```

  `storeOpen` must be declared before this `useState`; move its line up.
  - In the `[email]` effect, call `uploads.start()` next to `sync.start()`, and `uploads.stop()` in its cleanup.
  - The scanner's `onDone`:

```tsx
        onDone={(scanId) => {
          setRoute({ kind: 'inbox' });
          // A scan whose PDF can't be built stays on the device and shows under "Scans on this device".
          sendScanToInbox(store, uploads, scanId).catch((e: unknown) => console.error('could not queue scan', (e as Error)?.name));
        }}
```

  - Pass `uploads={uploads}` and `scans={store}` to `InboxScreen`, and drop `onSavedScans`.
  - The scanner's other callback, `onBack`, still goes to the inbox.

- [ ] **Step 5: Run the App tests 3 times, the full PWA suite, and the typecheck.** Tests that still reference the saved/viewer screens or `OcrQueue` belong to Task 8. If the suite fails only on those, say so in your report and leave the fix to Task 8. Don't delete the files yet.

- [ ] **Step 6: Commit.** `git commit -m "feat(pwa): send scans and added files through the upload queue"`

---

## Task 8: Retire on-device OCR and Saved scans

**Files:**
- Delete:
  - `pwa/src/ocr/` (all files)
  - `pwa/src/ui/SavedScansScreen.tsx`, `pwa/src/ui/ScanViewerScreen.tsx`, `pwa/src/ui/download.ts`
  - `pwa/scripts/copy-tesseract-assets.mjs`
  - `pwa/public/ocr/README.md`, `pwa/public/ocr/eng.traineddata.gz`
  - `pwa/tests/ocr/queue.test.ts`, `pwa/tests/ui/SavedScansScreen.test.tsx`
- Modify:
  - `pwa/package.json`: remove `predev`, `prebuild`, `tesseract.js` and `tesseract.js-core`.
  - `pnpm-lock.yaml`: via `pnpm install`.
  - `.gitignore`: remove the three `pwa/public/ocr/*` lines.
  - `pwa/public/sw.js`: remove the `ocr-core` and `/ocr/` patterns, and bump `CACHE_NAME` to `docscanner-scanner-v5` so phones drop the old cache.
  - `pwa/vite.config.ts`: remove the `ocr-core` chunk.
  - `pwa/src/pdf/build.ts`: remove `buildSearchablePdf` and `PageInput`.
  - `pwa/src/scanner/scans-store.ts`: remove `setPdfStatus`, `setPdfBlob`, `getPdf`, `setPageOcr`, `clearScanOcr`, `findPendingPdf`, and the `pdfKey` deletion in `delete`. Keep the `pdfs` object store in the schema; IndexedDB stores can't be dropped without a version bump, and an unused empty store is harmless.
  - `pwa/src/scanner/scanner-session.ts`: `finish()` no longer calls `setPdfStatus`.
  - `pwa/src/scanner/types.ts`: remove `OcrWord`, `PdfStatus`, `PdfArtifact`, the `pdfStatus`/`pdfKey`/`ocrError` fields on `Scan` and `ocrText`/`ocrWords` on `Page`. If you keep the store's `pdfs` schema entry, keep a minimal type for it.
  - `pwa/tests/scanner/scans-store*.test.ts` and `pwa/tests/pdf/build.test.ts`: drop the cases for removed methods. `App.test.tsx`: drop the `worker-client` mock.

- [ ] **Step 1: Find every reference first.** Run `grep -rn "ocr\|Ocr\|tesseract\|Tesseract\|SavedScans\|ScanViewer\|downloadPdf\|buildSearchablePdf\|pdfStatus\|pdfKey\|setPdf\|getPdf" pwa/src pwa/tests pwa/public/sw.js pwa/vite.config.ts pwa/package.json .gitignore`. Every hit must be gone, or deliberately kept and explained in your report.

- [ ] **Step 2: Delete and edit as listed.** Use `git rm` for the deletions.

- [ ] **Step 3: Update the lockfile.** `pnpm install` from the repo root. Only removals are expected. If pnpm reports anything other than removed packages, stop and report. If pnpm fails with ENOEXEC, run it through Corepack (`corepack pnpm install`).

- [ ] **Step 4: Run the full PWA suite 3 times, the typecheck and the build.** All pass. The build should no longer warn about a 500 kB OCR chunk.

- [ ] **Step 5: Commit.** `git commit -m "refactor(pwa): retire on-device OCR and the saved scans screen"`

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/observability.md`, `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`

- [ ] **Step 1: `CLAUDE.md`.**
  - In the PWA paragraph:
    - add `uploads/` (an IndexedDB upload queue: one at a time, with progress, retries with backoff, waits while offline, pauses on 401; scans go in as image-only PDFs);
    - drop `ocr/`;
    - change `pdf/` to "image-only PDFs from scans".
  - Remove the sentence about Tesseract assets and the `predev`/`prebuild` script.
  - In the "What this is" paragraph, the phone no longer does OCR. Change "captures/crops pages" to "captures/crops pages, and accepts any file" only if it reads naturally.
- [ ] **Step 2: `docs/observability.md`.** Add the PWA upload reporting: a permanent refusal is reported as `api.operation: document-upload` with its status. Name, size and contents are never sent. Follow the existing PWA rows.
- [ ] **Step 3: Spec.**
  - In "Delivery slices", mark slice 2 as merged (#263) and slice 4 with this plan's path.
  - Under §3, add a note: slice 4 put Add in the inbox, not on a separate screen, and offered scans saved before it once, under "Scans on this device".
- [ ] **Step 4: Commit.** `git commit -m "docs: describe the upload queue and the retired on-device OCR"`

---

## Task 10: Verify end to end, then open the PR

- [ ] **Step 1: Full checks.** `cd server && pnpm test && pnpm run typecheck`, then `cd ../pwa && pnpm test && pnpm run typecheck && pnpm build`. All pass.
- [ ] **Step 2: Browser run (Playwright, with the user).** Same setup as slice 2:
  - A throwaway `DB_PATH`, the server on `:3000` and `pnpm dev`.
  - The user signs in inside the Playwright window. Credentials come from 1Password and never pass through the transcript.
  - Ask before anything is filed into the real Drive.
  - Test files: fictional PDFs generated into the repo's locally excluded `.playwright-mcp/`.
  1. **Add (two files).** **Add** opens the file chooser. Choose two files. They show under **Uploading** with progress, then move to **In progress** and then **Needs review**.
  2. **Offline.** In devtools, go offline and **Add** a file. It shows "Waiting for a connection". Go back online and it uploads.
  3. **Oversized file.** A file over 50 MB shows as failed with the 50 MB reason. **Remove** clears it.
  4. **Drag and drop.** Drop a file onto the inbox. It is queued.
  5. **Scanner.** A scan can't be captured in Playwright, so seed one: write a finished scan into `ScansStore` through `browser_evaluate`. It appears under **Scans on this device**. **Send to inbox** uploads it, it reaches **Needs review** as a PDF, and the device row disappears.
- [ ] **Step 3: Open the PR.** Title: `feat(pwa): add files and send scans to the inbox (AI filing slice 4)`. The description gives the scope decisions above and the test results. Then follow the repo's PR workflow.
