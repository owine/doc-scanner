# Entrypoints (AI document filing, slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents reach the server from the PWA itself. An **Add** button and desktop drag-and-drop in the inbox feed a persistent upload queue that survives going offline and closing the app. The scanner posts finished scans as image-only PDFs instead of OCR-ing them on the phone. The old on-device OCR and the Saved scans screen are retired.

**Architecture:**
- **Upload queue.** A small IndexedDB-backed `UploadQueue` (`pwa/src/uploads/`) holds each file until the server answers `202`/`200` for it.
  - **Order:** one upload at a time, sent with XMLHttpRequest so progress can be shown.
  - **Failures:** transient ones (network, timeout, 409, 429, 5xx) retry with backoff, and a lost connection waits for the `online` event. Permanent ones (413, 400, a file that can't be read) stop and wait for the user. A file over 50 MB fails at once, without being sent.
  - **Sign-out:** a 401 pauses the queue until the next sign-in.
- **Inbox.** It gains an Add button, a drop target, an **Uploading** section and a one-time **Scans on this device** section for scans saved before this slice.
- **Scanner.** It ends by building an image-only PDF and queueing it. Each local scan is deleted once its upload is accepted. The PDF bytes are deterministic, so the server's duplicate check catches a scan sent twice.

**Tech Stack:** Preact 10, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `idb`, `ulid`, `@cantoo/pdf-lib`, Vitest, happy-dom, `fake-indexeddb`, `@testing-library/preact`.

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
- **Strict TypeScript:** `exactOptionalPropertyTypes` is on, so never pass `undefined` to an optional prop. `noUncheckedIndexedAccess` is on too. The typecheck covers `tests/` as well as `src/`.
- **Test environment quirks** (both are deliberate in `tests/setup.ts`; don't change it):
  - The global `Blob` is Node's, so `fake-indexeddb` can store it. happy-dom's `FormData.append` rejects that Blob, so a test that sends through `sendDocument` either passes a `File` (still happy-dom's) or stubs `FormData`. Each case is spelled out below.
  - IndexedDB is a fresh `fake-indexeddb` factory per test.
- **Teardown race:** every UI test must `await` the final state it caused. The PWA suite has a known happy-dom teardown race that surfaces as "document is not defined".
- **Fictional data only.** The repo is public.
- **Commits:** Conventional Commits, one per task unless a step says otherwise. Commits are signed automatically. `git add` only the task's own files, and never use `git stash`.
- **Privacy:** file names and document contents never go to the console or Sentry. A reported upload failure carries its HTTP status and error code, nothing else. Log an error's `name`, never the error itself, wherever it could quote a file.

## File map

| File | Responsibility |
|---|---|
| `pwa/src/pdf/build.ts` | `buildImagePdf(pages)`: one JPEG per page, no text layer, deterministic bytes |
| `pwa/src/uploads/types.ts` | `UploadItem`, `UploadSource` |
| `pwa/src/uploads/upload-store.ts` | IndexedDB persistence for queued uploads (`docscanner-uploads`) |
| `pwa/src/uploads/send.ts` | `sendDocument`: one multipart POST with progress and a timeout; `UploadError` |
| `pwa/src/uploads/queue.ts` | `UploadQueue` (order, retries, offline, 401 pause, size limit, scan claims) and the `useUploads` hook |
| `pwa/src/uploads/scans.ts` | `scanFileName`, `sendScanToInbox` (lazy-loads the PDF builder), the `useDeviceScans` hook |
| `pwa/src/scanner/scans-store.ts` | `open()` becomes idempotent (Task 4); PDF/OCR methods removed (Task 8) |
| `pwa/src/ui/inbox/UploadRows.tsx` | Uploading rows and device-scan rows |
| `pwa/src/ui/inbox/InboxScreen.tsx` | Add button, drop target, the two new sections |
| `pwa/src/ui/ScannerScreen.tsx` | Done hands the scan id to the app |
| `pwa/src/ui/App.tsx` | Owns the `UploadQueue` (Task 5); routes the scanner into it and removes saved/viewer routes (Task 7) |
| `pwa/src/scanner/{scanner-session,types}.ts` | PDF/OCR fields removed (Task 8); `Scan.pdfKey` stays, for deleting legacy PDFs |
| `pwa/tests/uploads/fake-xhr.ts` | A stand-in XMLHttpRequest shared by the sender and App tests |
| removed | `src/ocr/`, `src/ui/{SavedScansScreen,ScanViewerScreen}.tsx`, `src/ui/download.ts`, `scripts/copy-tesseract-assets.mjs`, `public/ocr/`, the Tesseract deps and their `allowBuilds` entry |

---

## Task 1: `buildImagePdf`

**Files:**
- Modify: `pwa/src/pdf/build.ts`
- Test: `pwa/tests/pdf/build.test.ts`

Add an image-only builder next to `buildSearchablePdf`. The old builder is removed with the rest of the OCR code in Task 8.

The output must be **byte-identical** for the same pages. pdf-lib stamps creation and modification dates by default, so two builds of one scan would differ. The server would then miss them as duplicates, because it compares sha256 hashes. `updateMetadata: false` turns the stamps off.

- [ ] **Step 1: Write the failing test.** In `pwa/tests/pdf/build.test.ts`, change the existing imports to these two lines. `PDFDocument` and the fixture helper `fixtureBlob()` are already in the file, so don't import them again.

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildSearchablePdf, buildImagePdf } from '../../src/pdf/build.js';
```

Then append:

```ts
describe('buildImagePdf', () => {
  it('makes one page per image, sized to the image at 144 dpi', async () => {
    const jpg = fixtureBlob();
    const pdf = await buildImagePdf([jpg, jpg]);
    expect(pdf.type).toBe('application/pdf');
    const doc = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(2 * 0.5); // 2×1 px at 72/144 pt per px
    expect(height).toBeCloseTo(1 * 0.5);
  });

  it('builds the same bytes from the same pages, whenever it runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
      const first = new Uint8Array(await (await buildImagePdf([fixtureBlob()])).arrayBuffer());
      vi.setSystemTime(new Date('2026-10-13T17:30:00Z'));
      const second = new Uint8Array(await (await buildImagePdf([fixtureBlob()])).arrayBuffer());
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
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
  // No creation or modification dates, so the same pages always make the same
  // bytes, and the server's duplicate check (sha256) catches a scan sent twice.
  const doc = await PDFDocument.create({ updateMetadata: false });
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
- Create: `pwa/src/uploads/types.ts`, `pwa/src/uploads/upload-store.ts`, `pwa/src/uploads/send.ts`, `pwa/tests/uploads/fake-xhr.ts`
- Test: `pwa/tests/uploads/upload-store.test.ts`, `pwa/tests/uploads/send.test.ts`

`fetch` can't report upload progress, so the sender uses XMLHttpRequest. Tests inject a fake XHR.

The request has a 15-minute timeout. An upload can stall without ever failing, for example when iOS suspends the page. Without a timeout, a stalled upload would hold the queue forever, and the file being sent can't be removed.

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

- [ ] **Step 2: The fake XHR.** `pwa/tests/uploads/fake-xhr.ts`. Task 7's App tests use it too.

```ts
/** A stand-in for XMLHttpRequest: it records the request, and the test answers it. */
export class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  withCredentials = false;
  timeout = 0;
  status = 0;
  responseText = '';
  body: FormData | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: FormData) {
    this.body = body;
  }

  respond(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}
```

- [ ] **Step 3: Write the failing tests.**

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
```

- [ ] **Step 4: Run them and see them fail.** The modules don't exist yet.

- [ ] **Step 5: Implement.**

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

/** Long enough for 50 MB on a slow uplink; ends an upload that stalled (say, iOS suspended the page). */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(code ?? `upload failed (${status})`);
    // Minification renames the class; error reports are titled with this.
    this.name = 'UploadError';
  }

  /** Worth retrying: the network or the server failed, not the file. */
  get transient(): boolean {
    if (this.code === 'unreadable') return false;
    // 409: the server was restarting an earlier failed copy at the same moment;
    // sending again gets the duplicate answer.
    return this.status === 0 || this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
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
    const form = new FormData();
    try {
      form.append('file', input.blob, input.name);
    } catch {
      // Not a Blob the browser can send. Sending again won't change that.
      reject(new UploadError(0, 'unreadable'));
      return;
    }
    form.append('source', input.source);
    form.append('originalName', input.name);

    const req = xhr();
    req.open('POST', '/api/documents');
    req.withCredentials = true;
    req.timeout = UPLOAD_TIMEOUT_MS;
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
    req.send(form);
  });
}
```

- [ ] **Step 6: Run both test files and the typecheck.** All pass.

- [ ] **Step 7: Commit.** `git commit -m "feat(pwa): persist uploads and send them with progress"`

---

## Task 3: `UploadQueue`

**Files:**
- Create: `pwa/src/uploads/queue.ts`
- Test: `pwa/tests/uploads/queue.test.ts`

**Rules:**
- **Order:** one upload at a time, oldest first.
- **Success** (`202`, or a `200` duplicate): `onUploaded` runs, then the item leaves the queue.
  - A scan stays "on its way" until `onUploaded` has deleted its local copy. Otherwise it would flash back under **Scans on this device**.
  - If storage fails to forget an accepted file, it still leaves the in-memory queue, so it isn't sent again in a loop. At the next start the stored copy is sent once more, and the server answers it as a duplicate.
- **Transient failure:** the item stays queued with backoff of 5 s, 15 s, 60 s, then 5 min.
- **Offline:** nothing is attempted until the `online` event fires. The queue tells its subscribers on both `online` and `offline`, so the rows can say "Waiting for a connection".
- **Permanent failure:** the item becomes `failed` with a plain-language reason and is reported, by status and code only. It waits for **Retry** or **Remove**.
  - A 413 means "too large" even without a code: a reverse proxy's own 413 page carries none.
  - Anything `send` throws that isn't an `UploadError` is a fault on this side. It counts as the permanent `unreadable`.
- **Size limit:** a file over 50 MB is added as `failed` at once and never sent, so a phone doesn't spend the data first. Retry doesn't send it either.
- **401:** the queue pauses and calls `onUnauthorized`. The next `start()`, at sign-in, resumes it.
- **Scans:** `addScan` claims the scan id before its PDF is built. A second call, or the device-scans list, then sees the scan as on its way while the PDF is still building. A build that fails releases the claim.
- **Ids:** `ulid()`, already a dependency. `crypto.randomUUID` doesn't exist outside secure contexts, such as a phone on plain-http LAN dev.
- **Progress:** the queue tells subscribers only when the shown percentage changes, because XHR progress events can come many times a second.

The item list is replaced, never mutated, on every change, so `list()` returns a stable reference between changes. This matches `DocumentSync`.

- [ ] **Step 1: Write the failing test.** `pwa/tests/uploads/queue.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and see it fail.** The module doesn't exist yet.

- [ ] **Step 3: Implement.** `pwa/src/uploads/queue.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';
import { ulid } from 'ulid';
import { sendDocument, UploadError, type SendInput, type SendResult } from './send.js';
import type { UploadItem, UploadSource } from './types.js';
import { UploadStore, type UploadStorage } from './upload-store.js';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/** The server's limit (spec §3). A bigger file fails here, before it costs any data. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const TOO_LARGE = 'Too large to upload (the limit is 50 MB).';

/** Plain-language reasons for permanent refusals. */
const REFUSALS: Record<string, string> = {
  payload_too_large: TOO_LARGE,
  empty_file: 'The file is empty.',
  missing_file: 'The file could not be read.',
  unreadable: 'The file could not be read.',
  invalid_source: 'The upload was refused.',
};

function refusal(e: UploadError): string {
  // A reverse proxy's own 413 page carries no code.
  if (e.status === 413) return TOO_LARGE;
  return (e.code && REFUSALS[e.code]) || `The server refused this file (${e.code ?? e.status}).`;
}

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
  /** Files over this many bytes fail at once. Defaults to the server's limit. */
  maxBytes?: number;
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
  /** Scans whose PDF is being built: on their way, though not queued yet. */
  private readonly claimed = new Set<string>();
  private readonly store: UploadStorage;
  private readonly send: NonNullable<UploadQueueOptions['send']>;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private loading: Promise<void> | null = null;
  private active: string | null = null;
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: UploadQueueOptions = {}) {
    this.store = o.store ?? new UploadStore();
    this.send = o.send ?? ((input, onProgress) => sendDocument(input, onProgress));
    // Read the clock on every call, so a test's fake clock applies whenever it was installed.
    this.now = o.now ?? (() => Date.now());
    this.maxBytes = o.maxBytes ?? MAX_UPLOAD_BYTES;
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

  /** Queued, being sent, or having its PDF built. */
  hasScan(scanId: string): boolean {
    return this.claimed.has(scanId) || this.items.some((i) => i.scanId === scanId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async add(files: readonly NewUpload[]): Promise<void> {
    await this.load();
    try {
      for (const f of files) {
        const now = this.now();
        const tooLarge = f.blob.size > this.maxBytes;
        const item: UploadItem = {
          id: ulid(),
          name: f.name,
          size: f.blob.size,
          blob: f.blob,
          source: f.source,
          scanId: f.scanId ?? null,
          createdAt: now,
          attempts: 0,
          state: tooLarge ? 'failed' : 'queued',
          error: tooLarge ? TOO_LARGE : null,
          nextAttemptAt: now,
        };
        await this.store.put(item);
        this.items = [...this.items, item];
      }
    } finally {
      this.emit();
      this.kick();
    }
  }

  /**
   * Queues a scan once. The claim is taken before `build` runs, so a second
   * call, or the device-scans list, sees the scan as on its way at once.
   */
  async addScan(scanId: string, build: () => Promise<Omit<NewUpload, 'scanId'>>): Promise<void> {
    if (this.hasScan(scanId)) return;
    this.claimed.add(scanId);
    this.emit();
    try {
      await this.add([{ ...(await build()), scanId }]);
    } finally {
      this.claimed.delete(scanId);
      this.emit();
    }
  }

  /** Sends a failed item again. Not one over the size limit: the server would refuse it again. */
  async retry(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || this.active === id || item.size > this.maxBytes) return;
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
      window.addEventListener('online', this.onConnection);
      window.addEventListener('offline', this.onConnection);
    }
    this.load().then(this.kick, (e: unknown) => console.error('could not read the upload queue', (e as Error)?.name));
  }

  stop(): void {
    this.running = false;
    window.removeEventListener('online', this.onConnection);
    window.removeEventListener('offline', this.onConnection);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Reads the stored queue once. A failed read is tried again by the next start() or add(). */
  private load(): Promise<void> {
    this.loading ??= this.store.all().then(
      (stored) => {
        const known = new Set(this.items.map((i) => i.id));
        this.items = [...stored.filter((i) => !known.has(i.id)), ...this.items];
        this.emit();
      },
      (err: unknown) => {
        this.loading = null;
        throw err;
      },
    );
    return this.loading;
  }

  /** Memory first: a storage failure must not leave the item due again at once. */
  private async save(item: UploadItem): Promise<void> {
    this.items = this.items.map((i) => (i.id === item.id ? item : i));
    this.emit();
    await this.store.put(item);
  }

  private readonly onConnection = (): void => {
    this.emit(); // the rows say whether they wait for a connection
    this.kick();
  };

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
    let result: SendResult | null = null;
    let failure: UploadError | null = null;
    try {
      result = await this.send({ blob: item.blob, name: item.name, source: item.source }, (fraction) =>
        this.setProgress(item.id, fraction),
      );
    } catch (err) {
      // Anything but an UploadError is a fault on this side; sending again won't help.
      failure = err instanceof UploadError ? err : new UploadError(0, 'unreadable');
    }
    try {
      if (result) await this.accepted(item, result);
      else if (failure) await this.refused(item, failure);
    } catch {
      // Storage failed while recording a refusal. The in-memory state is already right.
    } finally {
      this.active = null;
      this.progress.delete(item.id);
      this.emit();
      this.kick();
    }
  }

  private async accepted(item: UploadItem, result: SendResult): Promise<void> {
    try {
      await this.store.remove(item.id);
    } catch {
      // The stored copy is sent again at the next start; the server answers it as a duplicate.
    }
    try {
      await this.o.onUploaded?.(item, result);
    } catch {
      // The upload succeeded; a failing follow-up must not put it back.
    }
    // Only now: until its local copy is gone, a scan must still read as on its way.
    this.items = this.items.filter((i) => i.id !== item.id);
  }

  private async refused(item: UploadItem, e: UploadError): Promise<void> {
    if (e.status === 401) {
      this.paused = true;
      this.o.onUnauthorized?.();
    } else if (e.transient) {
      const attempts = item.attempts + 1;
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
      await this.save({ ...item, attempts, nextAttemptAt: this.now() + wait });
    } else {
      this.o.report?.(e);
      await this.save({ ...item, state: 'failed', error: refusal(e) });
    }
  }

  /** Tells subscribers only when the shown percentage changes: progress events can come many times a second. */
  private setProgress(id: string, fraction: number): void {
    const shown = Math.round((this.progress.get(id) ?? 0) * 100);
    this.progress.set(id, fraction);
    if (Math.round(fraction * 100) !== shown) this.emit();
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

- [ ] **Step 4: Run the test (5 times; it uses timers) and the typecheck.** All pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): queue uploads with retries, offline waits and a sign-in pause"`

---

## Task 4: Scans into the queue

**Files:**
- Create: `pwa/src/uploads/scans.ts`
- Modify: `pwa/src/scanner/scans-store.ts` (`open()` becomes idempotent)
- Test: `pwa/tests/uploads/scans.test.ts`, `pwa/tests/scanner/scans-store.test.ts`

Two details shape this task:
- **The PDF builder loads on demand.** pdf-lib is most of the bundle, and only a finished scan needs it. Task 8 gives it its own chunk.
- **`ScansStore.open()` becomes idempotent.** App opens the store at start, and the inbox's device-scan list must wait for that open, not race it. A list read before the open finishes would come back empty and stay empty.

- [ ] **Step 1: Write the failing tests.**

Add to the `describe('ScansStore')` block in `pwa/tests/scanner/scans-store.test.ts`:

```ts
  it('shares one open between every caller', async () => {
    const fresh = new ScansStore();
    const first = fresh.open();
    expect(fresh.open()).toBe(first);
    await first;
  });
```

`pwa/tests/uploads/scans.test.ts`. `buildImagePdf` needs real JPEG bytes; the scans-store tests use text blobs, so this file loads the PDF fixture instead:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';
import { UploadQueue } from '../../src/uploads/queue.js';
import { scanFileName, sendScanToInbox } from '../../src/uploads/scans.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';

const QUAD: Quad = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, bl: { x: 0, y: 100 }, br: { x: 100, y: 100 } };
const JPEG = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
const jpegBlob = () => new Blob([readFileSync(JPEG)], { type: 'image/jpeg' });

class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()]; }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

const idleQueue = () => new UploadQueue({ store: new MemoryStore(), send: () => new Promise(() => {}) });

let store: ScansStore;
beforeEach(async () => {
  store = new ScansStore();
  await store.open();
});

async function finishedScan(pages: number): Promise<string> {
  const id = await store.createInProgress();
  for (let i = 0; i < pages; i++) await store.appendPage(id, jpegBlob(), QUAD);
  await store.finish(id);
  return id;
}

describe('scanFileName', () => {
  it('names a scan by its local date and time', () => {
    expect(scanFileName(new Date(2026, 9, 12, 9, 5))).toBe('Scan 2026-10-12 09.05.pdf');
  });
});

describe('sendScanToInbox', () => {
  it('queues the scan as one image-only PDF, tied to its scan id', async () => {
    const id = await finishedScan(2);
    const queue = idleQueue();
    await sendScanToInbox(store, queue, id, new Date(2026, 9, 12, 9, 5));
    const [item] = queue.list();
    expect(item).toMatchObject({ source: 'scanner', scanId: id, name: 'Scan 2026-10-12 09.05.pdf' });
    expect(item!.blob.type).toBe('application/pdf');
  });

  it('does not queue the same scan twice', async () => {
    const id = await finishedScan(1);
    const queue = idleQueue();
    await sendScanToInbox(store, queue, id);
    await sendScanToInbox(store, queue, id);
    expect(queue.list()).toHaveLength(1);
  });

  it('does not queue the same scan twice when both sends start at once', async () => {
    const id = await finishedScan(1);
    const queue = idleQueue();
    await Promise.all([sendScanToInbox(store, queue, id), sendScanToInbox(store, queue, id)]);
    expect(queue.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** The scans module doesn't exist, and `open()` returns a new promise on every call.

- [ ] **Step 3: Make `open()` idempotent.** In `pwa/src/scanner/scans-store.ts`:
  - Rename the existing `async open(): Promise<void>` to `private async connect(): Promise<void>`. Leave its body unchanged.
  - Add this above it:

```ts
  private opening: Promise<void> | null = null;

  /** Idempotent: every caller shares one open (App's at start, and the inbox's device-scan list). */
  open(): Promise<void> {
    return (this.opening ??= this.connect());
  }
```

- [ ] **Step 4: Implement.** `pwa/src/uploads/scans.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';
import type { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';
import type { UploadQueue } from './queue.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** "Scan 2026-10-12 09.05.pdf", in local time. The analyzer names it properly. */
export function scanFileName(at: Date): string {
  return `Scan ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.pdf`;
}

/**
 * Queues a finished scan as one image-only PDF. Its local copy is deleted once
 * the server has it (App). If the PDF can't be built (say, its chunk can't load
 * while offline), the scan stays on the device and shows under "Scans on this
 * device".
 */
export async function sendScanToInbox(store: ScansStore, queue: UploadQueue, scanId: string, at = new Date()): Promise<void> {
  await queue.addScan(scanId, async () => {
    // Loaded on demand: pdf-lib is most of the bundle, and only a finished scan needs it.
    const { buildImagePdf } = await import('../pdf/build.js');
    const pages = await store.getPages(scanId);
    return { blob: await buildImagePdf(pages.map((p) => p.blob)), name: scanFileName(at), source: 'scanner' };
  });
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
      await store.open(); // App's open, shared: this waits for it rather than racing it
      setAll(await store.listCompleted());
    } catch {
      setAll([]);
    }
  };
  useEffect(() => {
    void reload();
    // Reload when the queue's items change (an upload finished, and its scan
    // was deleted), not on every progress tick.
    let seen = queue.list();
    return queue.subscribe(() => {
      if (queue.list() === seen) return;
      seen = queue.list();
      void reload();
    });
  }, [store, queue]);
  return { scans: all.filter((s) => !queue.hasScan(s.id)), reload };
}
```

`useDeviceScans` has no test of its own; Task 6 covers it through the inbox.

- [ ] **Step 5: Run both test files, the full PWA suite and the typecheck.** All pass. The full suite checks that the idempotent `open()` breaks no scanner test.

- [ ] **Step 6: Commit.** `git commit -m "feat(pwa): send finished scans to the inbox as PDFs"`

---

## Task 5: Add, drop, the Uploading section and the app's queue

**Files:**
- Create: `pwa/src/ui/inbox/UploadRows.tsx`
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`, `pwa/src/ui/App.tsx`, `pwa/src/theme/theme.css`
- Test: `pwa/tests/ui/InboxScreen.test.tsx`, `pwa/tests/ui/UploadRows.test.tsx`

The inbox's new props are required, so App wires the queue in this task, which keeps the typecheck and the App tests green.
- **Task 5:** App creates the queue, starts and stops it with the session, and passes it to the inbox.
- **Task 7:** the scanner's hand-off and the route clean-up.
- **Meanwhile:** the old `saved` route stays in place, unreachable from the inbox. The scanner's Done still goes there until Task 7.

- [ ] **Step 1: Write the failing tests.**

In `pwa/tests/ui/InboxScreen.test.tsx`:

**Imports.** Change the vitest import to add `afterEach`, and add these imports:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { UploadQueue, type UploadQueueOptions } from '../../src/uploads/queue.js';
import { UploadError } from '../../src/uploads/send.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
```

**Helpers.** Add these below the imports:

```ts
class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()]; }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

type Send = NonNullable<UploadQueueOptions['send']>;

const queues: UploadQueue[] = [];
/** An upload queue over memory whose sends never finish, unless the test passes `send`. Stopped after each test. */
function makeQueue(send: Send = () => new Promise(() => {})): UploadQueue {
  const q = new UploadQueue({ store: new MemoryStore(), send });
  queues.push(q);
  return q;
}

afterEach(() => {
  for (const q of queues.splice(0)) q.stop();
  Reflect.deleteProperty(navigator, 'onLine');
});

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
```

**`setup()`.** It gains an optional `send` and passes a started queue and a `ScansStore` that is not opened yet. The inbox opens the store itself (Task 4's shared open), so `setup()` stays synchronous. Replace its signature line and its last three lines:

```tsx
function setup(docs: DocumentView[], over: Partial<DocumentsApi> = {}, send?: Send) {
```

```tsx
  const uploads = makeQueue(send);
  uploads.start();
  const scans = new ScansStore();
  const props = { onScan: vi.fn(), onSettings: vi.fn(), onSignInAgain: vi.fn() };
  render(<InboxScreen sync={sync} documents={api} now={() => NOW} uploads={uploads} scans={scans} {...props} />);
  return { sync, api, props, uploads, scans };
```

**Direct renders.** Three tests render `InboxScreen` themselves rather than through `setup()`:
- "drops a discarded row once retention passes…"
- "says the server is unreachable…"
- "keeps the documents and warns…"

In each, replace `onSavedScans={vi.fn()}` with `uploads={makeQueue()} scans={new ScansStore()}`.

**The navigation test.** Replace "opens the scanner, settings and saved scans" with:

```tsx
  it('opens the scanner and settings, and has no saved scans any more', async () => {
    const { props } = setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(props.onScan).toHaveBeenCalled();
    expect(props.onSettings).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /saved scans/i })).toBeNull();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });
```

**New tests.** Append a second `describe` block. `fireEvent.change` with `target: { files }` and `drop` with `dataTransfer: { files }` both work under happy-dom. A `dragover` must pass `types` explicitly, because happy-dom derives `DataTransfer.types` from items that a test can't add:

```tsx
describe('InboxScreen uploads', () => {
  it('adds the files chosen with Add, and clears the picker for the next choice', async () => {
    const { uploads } = setup([]);
    const input = fileInput();
    const click = vi.spyOn(input, 'click');
    const cleared = vi.spyOn(input, 'value', 'set');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    const region = await screen.findByRole('region', { name: 'Uploading' });
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(2));
    expect(uploads.list().map((i) => i.source)).toEqual(['picker', 'picker']);
    expect(cleared).toHaveBeenCalledWith('');
  });

  it('adds files dropped on the inbox, with a hint while dragging', async () => {
    const { uploads } = setup([]);
    const main = screen.getByRole('main');
    fireEvent.dragOver(main, { dataTransfer: { types: ['Files'] } });
    expect(await screen.findByText('Drop files to add them')).toBeInTheDocument();
    fireEvent.drop(main, { dataTransfer: { files: [pdf('a.pdf')] } });
    await waitFor(() => expect(uploads.list()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Drop files to add them')).toBeNull());
  });

  it('shows the progress of the file being sent', async () => {
    let report!: (fraction: number) => void;
    setup([], {}, (_input, onProgress) => {
      report = onProgress;
      return new Promise(() => {});
    });
    fireEvent.change(fileInput(), { target: { files: [pdf('a.pdf')] } });
    await waitFor(() => expect(report).toBeDefined());
    act(() => report(0.5));
    expect(await screen.findByText('Uploading… 50%')).toBeInTheDocument();
  });

  it('explains a refused file and offers Retry and Remove', async () => {
    const { uploads } = setup([], {}, vi.fn().mockRejectedValue(new UploadError(413, 'payload_too_large')));
    const retry = vi.spyOn(uploads, 'retry');
    fireEvent.change(fileInput(), { target: { files: [pdf('big.pdf')] } });
    const region = await screen.findByRole('region', { name: 'Uploading' });
    expect(await within(region).findByText(/50 MB/)).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    // Refused again; then Remove takes the row away.
    fireEvent.click(await within(region).findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
  });

  it('says which files wait, and which wait for a connection, as it comes and goes', async () => {
    setup([]);
    fireEvent.change(fileInput(), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    expect(await screen.findByText('Waiting to upload')).toBeInTheDocument();
    expect(screen.getByText('Uploading… 0%')).toBeInTheDocument();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText('Waiting for a connection')).toBeInTheDocument();
    Reflect.deleteProperty(navigator, 'onLine');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByText('Waiting to upload')).toBeInTheDocument();
  });

  it('says so when the files cannot be kept for upload', async () => {
    const { uploads } = setup([]);
    vi.spyOn(uploads, 'add').mockRejectedValue(new Error('quota'));
    fireEvent.change(fileInput(), { target: { files: [pdf('a.pdf')] } });
    expect(await screen.findByText("Couldn't add the files. Try again.")).toBeInTheDocument();
  });
});
```

`pwa/tests/ui/UploadRows.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { DeviceScanRow, UploadRow } from '../../src/ui/inbox/UploadRows.js';
import { UploadQueue, MAX_UPLOAD_BYTES } from '../../src/uploads/queue.js';
import type { UploadItem } from '../../src/uploads/types.js';
import type { Scan } from '../../src/scanner/types.js';

const item = (over: Partial<UploadItem> = {}): UploadItem => ({
  id: 'u1', name: 'northwind-bill.pdf', size: 3, blob: new Blob(['abc']), source: 'picker', scanId: null,
  createdAt: 1, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0, ...over,
});
/** Never started, so it sends nothing; the rows only read it. */
const idle = () => new UploadQueue({ send: () => new Promise(() => {}) });
const scan: Scan = { id: 's1', status: 'completed', pageCount: 2, createdAt: 1, updatedAt: 1, thumbnailKey: null };

describe('UploadRow', () => {
  it('says a file is waiting, or retrying after a failure', async () => {
    const queue = idle();
    const { rerender } = render(<ul><UploadRow item={item()} queue={queue} /></ul>);
    expect(screen.getByText('Waiting to upload')).toBeInTheDocument();
    rerender(<ul><UploadRow item={item({ attempts: 1 })} queue={queue} /></ul>);
    await waitFor(() => expect(screen.getByText('Retrying soon')).toBeInTheDocument());
  });

  it('shows a refusal with Retry and Remove, each described by the file name', async () => {
    const queue = idle();
    const retry = vi.spyOn(queue, 'retry').mockResolvedValue();
    const remove = vi.spyOn(queue, 'remove').mockResolvedValue(true);
    render(<ul><UploadRow item={item({ state: 'failed', error: 'The file is empty.' })} queue={queue} /></ul>);
    expect(screen.getByText('The file is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAccessibleDescription('northwind-bill.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('u1'));
    expect(retry).toHaveBeenCalledWith('u1');
  });

  it('offers no Retry for a file over the limit', async () => {
    render(<ul><UploadRow item={item({ state: 'failed', error: 'Too large to upload (the limit is 50 MB).', size: MAX_UPLOAD_BYTES + 1 })} queue={idle()} /></ul>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument());
  });
});

describe('DeviceScanRow', () => {
  it('says when sending failed, and can be tried again', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('no pages'));
    render(<ul><DeviceScanRow scan={scan} onSend={onSend} onDelete={vi.fn()} /></ul>);
    expect(screen.getByText('Scan · 2 pages')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send to inbox' }));
    expect(await screen.findByText('Could not send this scan. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to inbox' })).toBeEnabled();
  });

  it('asks before deleting', async () => {
    const nativeConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValue(false);
    try {
      const onDelete = vi.fn();
      render(<ul><DeviceScanRow scan={scan} onSend={vi.fn()} onDelete={onDelete} /></ul>);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(window.confirm).toHaveBeenCalled());
      expect(onDelete).not.toHaveBeenCalled();
    } finally {
      window.confirm = nativeConfirm;
    }
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Rows.** `pwa/src/ui/inbox/UploadRows.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { MAX_UPLOAD_BYTES, type UploadQueue } from '../../uploads/queue.js';
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
      {item.state === 'failed' && item.size <= MAX_UPLOAD_BYTES && (
        <button type="button" class="btn btn-small" aria-describedby={nameId} onClick={() => void queue.retry(item.id)}>
          Retry
        </button>
      )}
      {item.state === 'failed' && (
        <button type="button" class="btn btn-secondary btn-small" aria-describedby={nameId} onClick={() => void queue.remove(item.id)}>
          Remove
        </button>
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
  - **Imports:** add `useRef` to the `preact/hooks` import, and add:

```ts
import type { ScansStore } from '../../scanner/scans-store.js';
import { useUploads, type UploadQueue } from '../../uploads/queue.js';
import { UploadRow } from './UploadRows.js';
```

  - **Props:** add these to `InboxScreenProps`, and remove `onSavedScans` from the props, the destructuring and the footer:

```ts
  /** Must be stable across renders, like `documents`. */
  uploads: UploadQueue;
  /** Must be stable. Task 6 lists its finished scans; the inbox shares App's open. */
  scans: ScansStore;
```

    Destructure `uploads` only; Task 6 starts using `scans`.
  - **State and the add helper**, after `useDocuments`:

```tsx
  const pending = useUploads(uploads);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addFiles = (files: ArrayLike<File> | null | undefined) => {
    const chosen = Array.from(files ?? []);
    if (chosen.length === 0) return;
    setAddError(null);
    uploads.add(chosen.map((f) => ({ blob: f, name: f.name, source: 'picker' as const }))).catch((e: unknown) => {
      // The error's name only: the files' names stay on this device.
      console.error('could not add files', (e as Error)?.name);
      setAddError("Couldn't add the files. Try again.");
    });
  };
```

  - **`<main>`, the overlay and the hidden input.** Replace the opening `<main class="inbox">` with:

```tsx
    <main
      class="inbox"
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault(); // allows the drop
        setDragging(true);
      }}
      onDragLeave={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !e.currentTarget.contains(to)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer?.files);
      }}
    >
      {dragging && (
        <div class="drop-overlay" aria-hidden="true">
          Drop files to add them
        </div>
      )}
      <input
        type="file"
        multiple
        ref={fileInput}
        class="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const input = e.currentTarget;
          addFiles(input.files);
          input.value = ''; // so choosing the same file again still fires change
        }}
      />
```

  - **Add button:** in the header's `.actions`, before **Scan**:

```tsx
          <button class="btn btn-secondary" onClick={() => fileInput.current?.click()}>
            Add
          </button>
```

  - **Add failure:** inside the `<div role="status">`, before the existing banners, add `{addError && <p class="warn">{addError}</p>}`.
  - **Uploading section:** above `<section aria-labelledby="h-review">`:

```tsx
      {pending.length > 0 && (
        <Section id="uploading" title="Uploading">
          {pending.map((item) => <UploadRow key={item.id} item={item} queue={uploads} />)}
        </Section>
      )}
```

  - **Footer:** delete the `<footer class="inbox-footer">` element. It held only Saved scans.

- [ ] **Step 5: App owns the queue.** In `pwa/src/ui/App.tsx`:
  - **Imports:**

```tsx
import { UploadQueue } from '../uploads/queue.js';
import { captureRequestFailure } from '../observability/sentry.js';
```

  - **The queue.** Move the `storeOpen` line up, right after `sync`, then add the queue after it:

```tsx
  // One open, shared: the in-progress lookup and the inbox's device scans wait on it.
  const [storeOpen] = useState(() => store.open());
  const [uploads] = useState(
    () =>
      new UploadQueue({
        onUploaded: async ({ scanId }) => {
          // The server has the scan; its copy on this device can go.
          if (scanId) await storeOpen.then(() => store.delete(scanId));
          void sync.poll();
        },
        onUnauthorized: () => {
          setEmail(null);
          setRoute({ kind: 'inbox' });
        },
        // Status and error code only (the code is the error's message); never the file's name.
        report: (err) =>
          captureRequestFailure(err, {
            operation: 'document-upload',
            path: '/api/documents',
            failure: err.status > 0 ? 'http' : 'network',
            ...(err.status > 0 ? { status: err.status } : {}),
          }),
      }),
  );
```

  - **Start and stop.** In the `[email]` effect, call `uploads.start()` right after `sync.start()`, and `uploads.stop()` first in its cleanup.
  - **The inbox.** In the `'inbox'` case, replace `onSavedScans={() => setRoute({ kind: 'saved' })}` with `uploads={uploads}` and `scans={store}`.

- [ ] **Step 6: Styles.** In `pwa/src/theme/theme.css`, delete the `.inbox-footer` rule and append:

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

- [ ] **Step 7: Run the InboxScreen, UploadRows and App tests 3 times, then the full PWA suite and the typecheck.** All pass.

- [ ] **Step 8: Commit.** `git commit -m "feat(pwa): add files to the inbox by picker or drag and drop"`

---

## Task 6: Scans on this device

**Files:**
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`
- Test: `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Write the failing tests.** In `InboxScreen.test.tsx`, add `beforeAll` to the vitest import, and add these imports:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
```

Then add these helpers next to the others. `setup()` passes the inbox a store it hasn't opened, so these tests also cover the inbox opening it itself:

```ts
const JPEG = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
const QUAD = { tl: { x: 0, y: 0 }, tr: { x: 2, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 2, y: 1 } };

/** A one-page scan finished before this slice, saved through a store of its own. */
async function savedScan(): Promise<string> {
  const store = new ScansStore();
  await store.open();
  const id = await store.createInProgress();
  await store.appendPage(id, new Blob([readFileSync(JPEG)], { type: 'image/jpeg' }), QUAD);
  await store.finish(id);
  return id;
}
```

Then append the block below. Its `beforeAll` matters. **Send to inbox** loads the PDF builder on demand, and that first load transforms pdf-lib. With other test files running in parallel, it takes longer than `findByRole`'s one-second wait, so without the warm-up the send test fails in the full suite while passing alone.

```tsx
describe('InboxScreen scans on this device', () => {
  beforeAll(async () => {
    await import('../../src/pdf/build.js');
  });

  it('lists a scan saved on the device', async () => {
    await savedScan();
    setup([]);
    const region = await screen.findByRole('region', { name: 'Scans on this device' });
    expect(within(region).getByText('Scan · 1 page')).toBeInTheDocument();
    expect(within(region).getByText(/saved before scans went straight to your inbox/i)).toBeInTheDocument();
  });

  it('sends a scan to the inbox', async () => {
    const id = await savedScan();
    const { uploads } = setup([]);
    const region = await screen.findByRole('region', { name: 'Scans on this device' });
    fireEvent.click(within(region).getByRole('button', { name: 'Send to inbox' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull());
    expect(await screen.findByRole('region', { name: 'Uploading' })).toBeInTheDocument();
    expect(uploads.list()).toMatchObject([{ source: 'scanner', scanId: id }]);
  });

  it('deletes a scan once the user confirms, and keeps it otherwise', async () => {
    const nativeConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      await savedScan();
      setup([]);
      const region = await screen.findByRole('region', { name: 'Scans on this device' });
      fireEvent.click(within(region).getByRole('button', { name: 'Delete' }));
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(within(region).getByText('Scan · 1 page')).toBeInTheDocument();
      fireEvent.click(within(region).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull());
    } finally {
      window.confirm = nativeConfirm;
    }
  });

  it('has no device section without saved scans', async () => {
    setup([]);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** In `InboxScreen.tsx`:
  - **Imports:** add the import below, and change the rows import to `import { DeviceScanRow, UploadRow } from './UploadRows.js';`.

```ts
import { sendScanToInbox, useDeviceScans } from '../../uploads/scans.js';
```

  - **Hook:** destructure `scans` as well, and add `const device = useDeviceScans(scans, uploads);` after `useUploads`.
  - **Section:** right after the **Uploading** section, add the block below. It is written out rather than using `Section`, because its note sits above the list:

```tsx
      {device.scans.length > 0 && (
        <section aria-labelledby="h-device">
          <h2 id="h-device">Scans on this device</h2>
          <p class="muted">Saved before scans went straight to your inbox. Send them or delete them.</p>
          <ul class="doc-list" role="list">
            {device.scans.map((s) => (
              <DeviceScanRow
                key={s.id}
                scan={s}
                onSend={() => sendScanToInbox(scans, uploads, s.id)}
                onDelete={async () => {
                  await scans.delete(s.id);
                  await device.reload();
                }}
              />
            ))}
          </ul>
        </section>
      )}
```

- [ ] **Step 4: Run the InboxScreen tests 3 times, the full PWA suite 3 times, and the typecheck.** All pass. The full-suite runs are what catch the timing of the first PDF-builder load.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): offer scans saved on the device to the inbox"`

---

## Task 7: Scanner hand-off and route clean-up

**Files:**
- Modify: `pwa/src/ui/ScannerScreen.tsx`, `pwa/src/ui/App.tsx`
- Test: `pwa/tests/ui/App.test.tsx`

- [ ] **Step 1: Write the failing tests** in `App.test.tsx`.
  - **Imports:** add these static imports at the top. They aren't mocked, so they don't need the file's `await import` pattern:

```tsx
import { UploadStore } from '../../src/uploads/upload-store.js';
import { FakeXhr } from '../uploads/fake-xhr.js';
```

  - **The saved-scans check:** in "opens on the inbox and goes to settings and back", after the first `findByText(/nothing to review/i)`, add:

```tsx
    expect(screen.queryByRole('button', { name: /saved scans/i })).toBeNull();
```

  - **The upload tests:** append this `describe` inside the top-level one. The queued file comes back from IndexedDB as Node's Blob, which happy-dom's `FormData` refuses, so the test stubs `FormData` along with `XMLHttpRequest`. The file's existing `afterEach(vi.unstubAllGlobals)` removes both stubs.

```tsx
  describe('uploads', () => {
    class FakeFormData {
      private readonly fields = new Map<string, unknown>();
      append(key: string, value: unknown) { this.fields.set(key, value); }
      get(key: string) { return this.fields.get(key) ?? null; }
    }

    /** Signs in with one file left in the queue from an earlier session, and returns its upload request. */
    async function signedInWithQueuedFile() {
      FakeXhr.last = null;
      vi.stubGlobal('XMLHttpRequest', FakeXhr);
      vi.stubGlobal('FormData', FakeFormData);
      await new UploadStore().put({
        id: 'old', name: 'northwind-bill.pdf', size: 1, blob: new Blob(['x']), source: 'picker', scanId: null,
        createdAt: 1, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0,
      });
      vi.stubGlobal(
        'fetch',
        route({
          '/api/auth/status': { email: 'user@example.test' },
          '/api/documents': { documents: [], cursor: 0 },
          '/api/folders': new Response('{"error":"folders_not_loaded"}', { status: 503 }),
        }),
      );
      render(<App />);
      expect(await screen.findByRole('region', { name: 'Uploading' })).toBeInTheDocument();
      await waitFor(() => expect(FakeXhr.last?.body).not.toBeNull());
      return FakeXhr.last!;
    }

    it('sends files left in the queue once signed in', async () => {
      const req = await signedInWithQueuedFile();
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/documents');
      req.respond(202, '{"id":"d1"}');
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
    });

    it('lands on the login screen when an upload finds the session gone', async () => {
      const req = await signedInWithQueuedFile();
      req.respond(401, '{"error":"not_authenticated"}');
      expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
  });
```

  These pass already, because Task 5 wired the queue. They pin the behaviour before the routes change. Run them once to confirm.

- [ ] **Step 2: Scanner.** In `ScannerScreen.tsx`:
  - Drop the `queue` prop and the `OcrQueue` import.
  - Change `onDone` to `(scanId: string) => void`.
  - In `done()`, replace `queue.enqueueAfterFinish(scanId); onDone();` with `onDone(scanId);`.

- [ ] **Step 3: App.** In `App.tsx`:
  - **Removals:** `OcrQueue`, `WorkerClient`, `buildSearchablePdf`, `SavedScansScreen`, `ScanViewerScreen`, their imports, the `queue` state, and the `saved` and `viewer` members of `Route` and their `case`s.
  - **First effect:** replace `storeOpen.then(() => queue.start()).catch(…)` with `storeOpen.catch((e) => console.error('open store', e));`.
  - **Import:** `import { sendScanToInbox } from '../uploads/scans.js';`.
  - **Scanner:** remove the `queue={queue}` prop, and change its `onDone`:

```tsx
        onDone={(scanId) => {
          setRoute({ kind: 'inbox' });
          // A scan whose PDF can't be built stays on the device and shows under "Scans on this device".
          sendScanToInbox(store, uploads, scanId).catch((e: unknown) => console.error('could not queue scan', (e as Error)?.name));
        }}
```

  - **Back:** the scanner's other callback, `onBack`, still goes to the inbox.

- [ ] **Step 4: Run the App tests 3 times, the full PWA suite, and the typecheck.** All pass.
  - The saved-scans files and their tests still exist and still compile; Task 8 removes them.
  - `App.test.tsx` still mocks `src/ocr/worker-client.js`. Nothing imports it any more, which is harmless; Task 8 drops the mock.

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): send finished scans through the upload queue"`

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
  - `pnpm-workspace.yaml`: remove the `tesseract.js: true` line from `allowBuilds`.
    - That block is the build-script allowlist. An entry for a package that is gone would let its install script run unreviewed if it ever came back as a transitive dependency.
    - pnpm doesn't warn about the stale entry, so nothing else will catch it.
    - Touch nothing else in the file.
  - `pnpm-lock.yaml`: via `pnpm install`.
  - `.gitignore`: remove the `# Vendored at build time by pwa/scripts/copy-tesseract-assets.mjs` comment and the three `pwa/public/ocr/*` lines under it.
  - `pwa/public/sw.js`:
    - Replace the `ocr-core` pattern with `/\/assets\/pdf-.*\.js$/`. The PDF builder's chunk is cached for offline scanning, as `ocr-core` was.
    - Remove the `/\/ocr\//` pattern.
    - Bump `CACHE_NAME` to `docscanner-scanner-v5` so phones drop the old cache.
  - `pwa/vite.config.ts`: replace the `ocr-core` line in `manualChunks` with the line below. `scans.ts` imports the builder on demand (Task 4). Without this line, deleting the `ocr-core` chunk would put pdf-lib in the entry chunk, growing it from about 155 kB to 720 kB.

```ts
          if (id.includes('/pdf/build') || id.includes('pdf-lib')) return 'pdf';
```

  - `pwa/src/pdf/build.ts`: remove `buildSearchablePdf`, `PageInput`, and the now-unused `rgb` and `OcrWord` imports.
  - `pwa/src/scanner/scans-store.ts`:
    - Remove `setPdfStatus`, `setPdfBlob`, `getPdf`, `setPageOcr`, `clearScanOcr`, `findPendingPdf`, and the unused type imports.
    - **Keep** the `pdfKey` deletion in `delete()`. Scans saved before this slice can point at a PDF in the `pdfs` store, and deleting the scan must delete that PDF, or it stays on the phone for good.
    - Keep the `pdfs` object store in the schema. IndexedDB stores can't be dropped without a version bump, and an unused store is harmless.
  - `pwa/src/scanner/scanner-session.ts`: `finish()` no longer calls `setPdfStatus`.
  - `pwa/src/scanner/types.ts`:
    - Remove `OcrWord`, `PdfStatus`, the `pdfStatus` and `ocrError` fields on `Scan`, and `ocrText`/`ocrWords` on `Page`.
    - Keep `PdfArtifact`, for the `pdfs` store.
    - Keep `pdfKey` on `Scan`, replacing its comment block with:

```ts
  /** Legacy (on-device OCR): a stored PDF that delete() must also remove. */
  pdfKey?: string | null;
```

  - `pwa/tests/pdf/build.test.ts`: drop the `buildSearchablePdf` cases, the `word` helper and the `OcrWord` import.
  - `pwa/tests/ui/App.test.tsx`: drop the `worker-client` mock and its comment.
  - `pwa/tests/scanner/scans-store-v2.test.ts`:
    - In the migration test, drop the `pdfStatus` and `ocrText` assertions, and the `getPdf('nonexistent')` line with its comment.
    - Drop the `findPendingPdf`, `setPageOcr` and `setPdfBlob` cases.
    - Replace "delete cascades the pdf as well as pages and thumbnail" with:

```ts
  it('delete also removes a PDF left by on-device OCR', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.finish(id);
    // What the retired OCR queue left behind: a pdfs row the scan points at.
    const raw = await openDB(DB_NAME, 2);
    await raw.put('pdfs', { id: 'legacy-pdf', blob: blob('pdf'), bytes: 3 });
    await raw.put('scans', { ...(await raw.get('scans', id)), pdfKey: 'legacy-pdf' });
    await store.delete(id);
    expect(await raw.get('pdfs', 'legacy-pdf')).toBeUndefined();
    raw.close();
  });
```

- [ ] **Step 1: Find every reference first.** Run this from the repo root:

```bash
grep -rn "ocr\|Ocr\|tesseract\|Tesseract\|SavedScans\|ScanViewer\|downloadPdf\|buildSearchablePdf\|pdfStatus\|pdfKey\|setPdf\|getPdf" pwa/src pwa/tests pwa/public/sw.js pwa/vite.config.ts pwa/package.json pnpm-workspace.yaml .gitignore
```

  Every hit must be gone afterwards, except these deliberate keeps. Say so in your report:
  - the `ocr` key in `src/observability/scrub.ts`, which still scrubs any such field;
  - `pdfKey` in `scans-store.ts` and `types.ts`, and the new cascade test.

- [ ] **Step 2: Delete and edit as listed.**
  - Use `git rm` for the deletions.
  - Then run `rm -rf pwa/public/ocr`. The copy script left ignored wasm and worker files there, and Vite would keep copying them into `dist`.

- [ ] **Step 3: Update the lockfile.** Run `pnpm install` from the repo root.
  - Only removals are expected: 13 packages, about 95 lockfile lines.
  - If pnpm reports anything other than removed packages, stop and report.
  - If pnpm fails with ENOEXEC, run it through Corepack (`corepack pnpm install`).

- [ ] **Step 4: Run the full PWA suite 3 times, the typecheck and the build.** All pass.
  - The build emits a `pdf-*.js` chunk of about 570 kB, and the entry chunk stays about 155 kB.
  - Vite still prints its ">500 kB" warning for the `pdf` chunk, as it did for `ocr-core`. That is expected; any other chunk over 500 kB is not.

- [ ] **Step 5: Commit.** `git commit -m "refactor(pwa): retire on-device OCR and the saved scans screen"`

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/observability.md`, `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`

- [ ] **Step 1: `CLAUDE.md`.**
  - In the PWA paragraph:
    - add `uploads/` (an IndexedDB upload queue: one at a time, with progress, retries with backoff, waits while offline, pauses on 401; scans go in as image-only PDFs);
    - drop `ocr/`;
    - change `pdf/` to "image-only PDFs from scans, loaded on demand".
  - Remove the sentence about Tesseract assets and the `predev`/`prebuild` script.
  - In the "What this is" paragraph, the phone no longer does OCR. Change "captures/crops pages" to "captures/crops pages, and accepts any file" only if it reads naturally.
- [ ] **Step 2: `README.md`.**
  - In the status paragraph, say that on-device OCR is retired: scans go to the server as image-only PDFs, and files can be added from the inbox.
  - In the `pwa/` bullet, replace "OCR (Tesseract.js, being replaced in Phase 5), searchable PDF assembly" with "an upload queue for added files and scans, image-only PDF assembly".
- [ ] **Step 3: `docs/observability.md`.**
  - **The table:** add a row after the `request(…, { reportAs })` row, following its format:

```
| PWA upload queue (`src/uploads/`) | A file the queue gives up on: a permanent refusal (4xx other than 401) or a file it could not read. Network failures and 5xx are retried, not reported. | `api.operation: document-upload`, `api.path`, `api.failure`, `api.status` (when there was a response), `network.online`. The exception message is the error code. |
```

  - **The paragraph:** replace the "**No PWA endpoint opts in yet.** …" paragraph with:

```
**Uploads don't use `reportAs`.** The upload queue retries network failures and 5xx itself, and reports only a file it gives up on, as `api.operation: document-upload`. The file's name, size and contents are never sent. Server-side, the intake route and the filing worker report their own failures.
```

- [ ] **Step 4: Spec.**
  - In "Delivery slices", mark slice 2 as merged (#263) and slice 4 with this plan's path.
  - Under §3, add a note: slice 4 put Add in the inbox, not on a separate screen, and offered scans saved before it once, under "Scans on this device".
- [ ] **Step 5: Commit.** `git commit -m "docs: describe the upload queue and the retired on-device OCR"`

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
  3. **Oversized file.** A file over 50 MB shows as failed with the 50 MB reason at once, with no upload in the network panel and no **Retry**. **Remove** clears it.
  4. **Drag and drop.** Drop a file onto the inbox. It is queued.
  5. **Scanner.** A scan can't be captured in Playwright, so seed one: write a finished scan into `ScansStore` through `browser_evaluate`. It appears under **Scans on this device**. **Send to inbox** uploads it, it reaches **Needs review** as a PDF, and the device row disappears.
- [ ] **Step 3: Open the PR.** Title: `feat(pwa): add files and send scans to the inbox (AI filing slice 4)`. The description gives the scope decisions above and the test results. Then follow the repo's PR workflow.
