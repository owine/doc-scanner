# Phase 4: OCR & Searchable PDF Assembly — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-OCR every saved scan in a single Tesseract.js Web Worker (FIFO queue), assemble searchable PDFs with `pdf-lib`, and expose a Download action on the SavedScansScreen row when ready.

**Architecture:** Two new module groups (`pwa/src/ocr/`, `pwa/src/pdf/`). One `OcrQueue` singleton owns the queue + drives the Web Worker via a Promise-based client. `pdf-lib` assembles the final PDF (image layer + invisible text layer aligned to per-word boxes). IndexedDB schema bumps to v2 with additive changes (no data mutation) plus a new `pdfs` object store. PWA-only; zero server changes.

**Tech Stack:** Phase 1+2+3 stack + new PWA deps: `tesseract.js` (browser OCR engine), `pdf-lib` (pure-JS PDF assembly). Vendored asset: `pwa/public/ocr/eng.traineddata.gz` (~10 MB).

**Spec:** [`docs/superpowers/specs/2026-04-30-phase-4-ocr-pdf-design.md`](../specs/2026-04-30-phase-4-ocr-pdf-design.md)

---

## File Structure

**New files:**
```
pwa/src/ocr/types.ts                   OcrWord, OcrResult, WorkerInput, WorkerOutput
pwa/src/ocr/tesseract-worker.ts        Web Worker entry; no tests (wasm boundary)
pwa/src/ocr/worker-client.ts           Main-thread Promise wrapper around the Web Worker
pwa/src/ocr/queue.ts                   OcrQueue singleton — orchestrates everything
pwa/src/pdf/build.ts                   Searchable-PDF assembly via pdf-lib
pwa/src/ui/download.ts                 Shared PDF download helper (used by SavedScansScreen + ScanViewerScreen)
pwa/public/ocr/eng.traineddata.gz      Vendored Tesseract English language data (~10 MB)
pwa/tests/ocr/queue.test.ts            Queue orchestration tests with a fake worker-client
pwa/tests/pdf/build.test.ts            pdf-lib round-trip tests with fixture JPEGs
pwa/tests/scanner/scans-store-v2.test.ts  v1 → v2 migration + new fields/store tests
```

**Modified files:**
```
pwa/package.json                       new deps: tesseract.js, pdf-lib
pwa/src/scanner/types.ts               add OcrWord re-export; extend Scan, Page interfaces
pwa/src/scanner/scans-store.ts         v2 migration; new "pdfs" store; setters for pdf state + page OCR; getPdf()
pwa/src/scanner/scanner-session.ts     finish() notifies the queue
pwa/src/ui/App.tsx                     instantiate OcrQueue + pass through to routes
pwa/src/ui/SavedScansScreen.tsx        per-row OCR progress + Retry + Download
pwa/src/ui/ScanViewerScreen.tsx        Download button when pdfStatus is 'done' or 'partial'
pwa/tests/ui/SavedScansScreen.test.tsx  cases for pending/running/partial/done/failed/retry
pwa/public/sw.js                       cache patterns include /ocr/* and /assets/ocr-core-*; bump CACHE_NAME to v3
pwa/vite.config.ts                     manualChunks adds 'ocr-core' entry
package-lock.json                      refreshed
```

**Constants pinned in this plan** (per spec):
- `OCR_LANGUAGE = 'eng'`
- `OCR_MIN_WORD_CONFIDENCE = 30`
- `PDF_PAGE_DPI = 144`
- `WORKER_RECOGNIZE_TIMEOUT_MS = 30_000` — measured *after* worker reports `ready` (excludes cold-start wasm compile, which can be 15+ s on iPhone)

**Open spec questions resolved here:**
- **Queue wiring:** `OcrQueue` is a class instantiated in `App.tsx`'s mount effect (`new OcrQueue(store)`), passed as a prop to `ScannerScreen`, `SavedScansScreen`, `ScanViewerScreen`. `scanner-session` does NOT hold a queue reference; ScannerScreen calls `queue.enqueueAfterFinish(scanId)` after `session.finish()` resolves.
- **PDF invisible-text mode:** use pdf-lib's `drawText({ opacity: 0 })` (simpler than rendering-mode acrobatics; verified searchable in Apple Preview, Chrome, Acrobat during smoke).
- **Worker lifecycle:** keep the Tesseract worker warm between jobs (no terminate-after-each); only terminate on cancel-during-flight or fatal error. Sub-second startup on subsequent jobs.
- **Vendored asset path:** `pwa/public/ocr/eng.traineddata.gz`. Tesseract.js v6+ accepts `langPath` so we point at this directory.

---

## Task 1: Install dependencies and vendor traineddata

**Files:**
- Modify: `pwa/package.json`
- Create: `pwa/public/ocr/eng.traineddata.gz`
- Modify: `package-lock.json` (auto)

- [ ] **Step 1: Add deps to `pwa/package.json`**

```jsonc
"dependencies": {
  "preact": "10.29.1",
  "idb": "8.0.3",
  "ulid": "3.0.0",
  "tesseract.js": "6.0.1",
  "pdf-lib": "1.17.1"
},
```

Notes:
- `tesseract.js` is a runtime dep this time (not lazy-vendored like jscanify) because Vite handles its browser bundle correctly — the package's `main` points at the browser entry. The wasm chunk is auto-loaded from `node_modules/tesseract.js-core` and Vite copies it into `dist/assets/`.
- `pdf-lib` is pure JS, no native deps, very stable.
- Pin minor versions for Renovate.

- [ ] **Step 2: Vendor `eng.traineddata.gz`**

```bash
mkdir -p pwa/public/ocr
curl -fsSL --output pwa/public/ocr/eng.traineddata.gz \
  https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
# Compress for transit (Tesseract reads .gz natively):
gzip -9 pwa/public/ocr/eng.traineddata
ls -lh pwa/public/ocr/eng.traineddata.gz   # expect ~5-10 MB
```

If the upstream raw file is already gzipped (filename varies), skip the `gzip` step. Sanity check the file is readable: `gunzip -t pwa/public/ocr/eng.traineddata.gz` should exit zero.

- [ ] **Step 3: Install + verify**

```bash
eval "$(fnm env)" && fnm use 24.15.0
npm install
npm --prefix pwa run typecheck
```

Expected: lockfile updates, typecheck clean.

- [ ] **Step 4: Add a README to the vendored dir**

Create `pwa/public/ocr/README.md`:

```markdown
# Vendored OCR assets

`eng.traineddata.gz` is the English language data for Tesseract OCR
(Apache 2.0 licensed, sourced from `tesseract-ocr/tessdata_fast`).

We vendor it same-origin so the Service Worker's same-origin guard
can cache it (the SW intercepts only same-origin requests). The
~10 MB asset is fetched once on the OcrQueue's first job and
cached thereafter for offline reuse.

## Updating

When tessdata ships a new build:

    curl -fsSL --output eng.traineddata.gz \
      https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
    gzip -9 eng.traineddata

Verify with `gunzip -t`. Retest on a real device, commit.
```

- [ ] **Step 5: Commit**

```bash
git add pwa/package.json package-lock.json pwa/public/ocr
git commit -m "chore(pwa): add tesseract.js + pdf-lib; vendor eng.traineddata.gz"
```

---

## Task 2: Schema migration — scans-store v2

**Files:**
- Modify: `pwa/src/scanner/types.ts`
- Modify: `pwa/src/scanner/scans-store.ts`
- Create: `pwa/tests/scanner/scans-store-v2.test.ts`

### Step 1: Extend types

- [ ] Edit `pwa/src/scanner/types.ts` to add the new fields. Keep all existing exports.

```ts
// add at top with existing types
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export type PdfStatus = 'pending' | 'running' | 'done' | 'failed' | 'partial';

// extend existing Scan
export interface Scan {
  id: string;
  status: ScanStatus;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  thumbnailKey: string | null;
  // NEW (Phase 4)
  pdfStatus?: PdfStatus;       // undefined = legacy Phase 3 scan; treated as 'pending'
  pdfKey?: string | null;
  ocrError?: string | null;
}

// extend existing Page
export interface Page {
  scanId: string;
  ordinal: number;
  blob: Blob;
  quad: Quad;
  capturedAt: number;
  // NEW
  ocrText?: string | null;
  ocrWords?: OcrWord[] | null;
}

// new
export interface PdfArtifact {
  id: string;
  blob: Blob;
  bytes: number;
}
```

### Step 2: Write failing migration test

- [ ] Create `pwa/tests/scanner/scans-store-v2.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB } from 'idb';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

const DB_NAME = 'docscanner';
const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });

beforeEach(() => { indexedDB.deleteDatabase(DB_NAME); });

describe('ScansStore v2 migration', () => {
  it('preserves Phase 3 data when bumping from v1 to v2', async () => {
    // Seed a v1 database with the Phase 3 schema
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const scans = db.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('by_status', 'status');
        scans.createIndex('by_updatedAt', 'updatedAt');
        const pages = db.createObjectStore('pages', { keyPath: ['scanId', 'ordinal'] });
        pages.createIndex('by_scan', 'scanId');
        db.createObjectStore('thumbs', { keyPath: 'id' });
      },
    });
    await v1.put('scans', {
      id: 'legacy-scan-1', status: 'completed', pageCount: 1,
      createdAt: 1000, updatedAt: 2000, thumbnailKey: 'thumb-1',
    });
    await v1.put('pages', { scanId: 'legacy-scan-1', ordinal: 0, blob: blob('p1'), quad: Q, capturedAt: 1500 });
    await v1.put('thumbs', { id: 'thumb-1', blob: blob('t') });
    v1.close();

    // Open at v2 via ScansStore — runs the migration
    const store = new ScansStore();
    await store.open();

    const completed = await store.listCompleted();
    expect(completed.length).toBe(1);
    expect(completed[0]!.id).toBe('legacy-scan-1');
    expect(completed[0]!.pdfStatus).toBeUndefined();   // legacy = undefined

    const pages = await store.getPages('legacy-scan-1');
    expect(pages.length).toBe(1);
    expect(await pages[0]!.blob.text()).toBe('p1');
    expect(pages[0]!.ocrText).toBeUndefined();

    // pdfs object store should now exist
    expect(await store.getPdf('nonexistent')).toBeNull();
  });

  it('findPendingPdf returns legacy scans + running scans + pending scans, excludes done/failed', async () => {
    const store = new ScansStore();
    await store.open();
    // legacy: created via ScansStore, but with pdfStatus undefined
    const a = await store.createInProgress();
    await store.appendPage(a, blob('a'), Q);
    await store.finish(a);
    // pdfStatus is undefined after finish in Phase 3 code; we'll simulate 'running' / 'done' / 'failed'
    await store.setPdfStatus(a, 'done');
    const b = await store.createInProgress();
    await store.appendPage(b, blob('b'), Q);
    await store.finish(b);
    await store.setPdfStatus(b, 'failed', 'oops');
    const c = await store.createInProgress();
    await store.appendPage(c, blob('c'), Q);
    await store.finish(c);
    await store.setPdfStatus(c, 'pending');
    const d = await store.createInProgress();
    await store.appendPage(d, blob('d'), Q);
    await store.finish(d);
    await store.setPdfStatus(d, 'running');

    const pending = await store.findPendingPdf();
    const ids = pending.map((s) => s.id).sort();
    expect(ids).toEqual([c, d].sort());
  });

  it('setPageOcr persists text + words on a page', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.setPageOcr(id, 0, 'hello world', [
      { text: 'hello', x: 0, y: 0, w: 50, h: 20, confidence: 90 },
      { text: 'world', x: 60, y: 0, w: 60, h: 20, confidence: 88 },
    ]);
    const pages = await store.getPages(id);
    expect(pages[0]!.ocrText).toBe('hello world');
    expect(pages[0]!.ocrWords?.length).toBe(2);
  });

  it('setPdfBlob inserts into pdfs store and links the scan', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.finish(id);
    const pdfBlob = blob('%PDF-1.7 ... fake');
    const pdfKey = await store.setPdfBlob(id, pdfBlob);
    expect(pdfKey).toMatch(/^[0-9a-f-]+$/i);
    const back = await store.getPdf(pdfKey);
    expect(back).not.toBeNull();
    expect(await back!.text()).toBe('%PDF-1.7 ... fake');
    const list = await store.listCompleted();
    expect(list[0]!.pdfKey).toBe(pdfKey);
  });

  it('delete cascades the pdf as well as pages and thumbnail', async () => {
    const store = new ScansStore();
    await store.open();
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.finish(id);
    const pdfKey = await store.setPdfBlob(id, blob('pdf'));
    await store.delete(id);
    expect(await store.getPdf(pdfKey)).toBeNull();
  });
});
```

### Step 3: Run — should fail (DB_VERSION still 1, methods don't exist)

- [ ] `npm --prefix pwa test -- scans-store-v2`
  - Expected: failures because new methods don't exist and `pdfs` store isn't created.

### Step 4: Update `scans-store.ts` to v2

- [ ] Edit `pwa/src/scanner/scans-store.ts`. Bump version, add `pdfs` store, add new schema fields, add new methods. Specifically:

Replace the `DocScannerSchema` interface:

```ts
interface DocScannerSchema extends DBSchema {
  scans: {
    key: string;
    value: Scan;
    indexes: { by_status: string; by_updatedAt: number };
  };
  pages: {
    key: [string, number];
    value: Page;
    indexes: { by_scan: string };
  };
  thumbs: {
    key: string;
    value: Thumbnail;
  };
  pdfs: {
    key: string;
    value: PdfArtifact;
  };
}
```

Add `PdfArtifact` to the imports from `./types.js`.

Bump:
```ts
const DB_VERSION = 2;
```

Update the `upgrade` callback to handle both fresh installs and v1→v2 migration:

```ts
async open(): Promise<void> {
  this.db = await openDB<DocScannerSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const scans = db.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('by_status', 'status');
        scans.createIndex('by_updatedAt', 'updatedAt');
        const pages = db.createObjectStore('pages', { keyPath: ['scanId', 'ordinal'] });
        pages.createIndex('by_scan', 'scanId');
        db.createObjectStore('thumbs', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        db.createObjectStore('pdfs', { keyPath: 'id' });
      }
    },
  });
}
```

Add the new methods to the class:

```ts
async setPdfStatus(scanId: string, status: PdfStatus, error?: string): Promise<void> {
  const scan = await this.d.get('scans', scanId);
  if (!scan) throw new Error(`scan not found: ${scanId}`);
  scan.pdfStatus = status;
  scan.ocrError = status === 'failed' ? (error ?? 'Unknown error') : null;
  scan.updatedAt = Date.now();
  await this.d.put('scans', scan);
}

async setPdfBlob(scanId: string, blob: Blob): Promise<string> {
  const id = uuid();
  await this.d.put('pdfs', { id, blob, bytes: blob.size });
  const scan = await this.d.get('scans', scanId);
  if (!scan) throw new Error(`scan not found: ${scanId}`);
  // Drop any prior pdf row this scan referenced
  if (scan.pdfKey) await this.d.delete('pdfs', scan.pdfKey);
  scan.pdfKey = id;
  scan.updatedAt = Date.now();
  await this.d.put('scans', scan);
  return id;
}

async getPdf(pdfKey: string): Promise<Blob | null> {
  const row = await this.d.get('pdfs', pdfKey);
  return row?.blob ?? null;
}

async setPageOcr(scanId: string, ordinal: number, text: string, words: OcrWord[]): Promise<void> {
  const existing = await this.d.get('pages', [scanId, ordinal]);
  if (!existing) throw new Error(`page not found: ${scanId}/${ordinal}`);
  existing.ocrText = text;
  existing.ocrWords = words;
  await this.d.put('pages', existing);
}

async clearScanOcr(scanId: string): Promise<void> {
  const pages = await this.getPages(scanId);
  for (const p of pages) {
    p.ocrText = null;
    p.ocrWords = null;
    await this.d.put('pages', p);
  }
}

async findPendingPdf(): Promise<Scan[]> {
  const all = await this.d.getAllFromIndex('scans', 'by_updatedAt');
  return all
    .filter((s) => s.status === 'completed')
    .filter((s) => s.pdfStatus !== 'done' && s.pdfStatus !== 'failed');
}
```

Update `delete()` to cascade the PDF too:

```ts
async delete(scanId: string): Promise<void> {
  const tx = this.d.transaction(['scans', 'pages', 'thumbs', 'pdfs'], 'readwrite');
  const scan = await tx.objectStore('scans').get(scanId);
  if (scan?.thumbnailKey) await tx.objectStore('thumbs').delete(scan.thumbnailKey);
  if (scan?.pdfKey) await tx.objectStore('pdfs').delete(scan.pdfKey);
  const pageKeys = await tx.objectStore('pages').index('by_scan').getAllKeys(scanId);
  for (const k of pageKeys) await tx.objectStore('pages').delete(k);
  await tx.objectStore('scans').delete(scanId);
  await tx.done;
}
```

Add `OcrWord, PdfArtifact, PdfStatus` to the type imports from `./types.js`.

### Step 5: Run tests

- [ ] `npm --prefix pwa test -- scans-store-v2`
  - Expected: 5 passing.

- [ ] Also run the existing scans-store tests to check no regressions:
  ```bash
  npm --prefix pwa test -- scans-store
  ```
  Expected: existing 7 + new 5 = 12 passing in scans-store namespace.

### Step 6: Commit

- [ ] ```bash
git add pwa/src/scanner/types.ts pwa/src/scanner/scans-store.ts pwa/tests/scanner/scans-store-v2.test.ts
git commit -m "feat(pwa): scans-store v2 — pdfs store + per-page OCR fields"
```

---

## Task 3: ocr/types.ts (shared types)

**Files:**
- Create: `pwa/src/ocr/types.ts`

### Step 1: Implement

- [ ] Create `pwa/src/ocr/types.ts`:

```ts
import type { OcrWord } from '../scanner/types.js';

export type { OcrWord };

export interface OcrResult {
  text: string;
  words: OcrWord[];
}

// postMessage protocol with the Web Worker

export type WorkerInput =
  | { type: 'init' }
  | { type: 'recognize'; jobId: string; blob: Blob }
  | { type: 'terminate' };

export type WorkerOutput =
  | { type: 'ready' }
  | { type: 'progress'; jobId: string; pct: number }
  | { type: 'result'; jobId: string; text: string; words: OcrWord[] }
  | { type: 'error'; jobId: string; message: string };

// Per-job lifecycle states tracked by the queue (UI display only).
export type OcrJobPhase = 'queued' | 'recognizing' | 'building' | 'done' | 'partial' | 'failed';
```

### Step 2: Verify typecheck

- [ ] `npm --prefix pwa run typecheck`
  - Expected: clean.

### Step 3: Commit

- [ ] ```bash
git add pwa/src/ocr/types.ts
git commit -m "feat(pwa): ocr/types — shared OcrResult + worker postMessage types"
```

---

## Task 4: ocr/tesseract-worker.ts (Web Worker entry)

**Files:**
- Create: `pwa/src/ocr/tesseract-worker.ts`

No unit tests — wasm boundary; manual smoke covers it.

### Step 1: Implement

- [ ] Create `pwa/src/ocr/tesseract-worker.ts`:

```ts
/// <reference lib="webworker" />
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import type { OcrWord, WorkerInput, WorkerOutput } from './types.js';

const OCR_LANGUAGE = 'eng';
const OCR_MIN_WORD_CONFIDENCE = 30;

let tess: TesseractWorker | null = null;

function post(msg: WorkerOutput): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function init(): Promise<void> {
  if (tess) return;
  tess = await createWorker(OCR_LANGUAGE, undefined, {
    // Vite copies tesseract.js wasm into /assets/; tesseract.js auto-discovers it.
    // langPath points at our vendored eng.traineddata.gz directory.
    langPath: '/ocr',
    gzip: true,
  });
}

self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      await init();
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', jobId: 'init', message: (err as Error).message });
    }
    return;
  }
  if (msg.type === 'terminate') {
    if (tess) { await tess.terminate(); tess = null; }
    return;
  }
  if (msg.type === 'recognize') {
    if (!tess) {
      post({ type: 'error', jobId: msg.jobId, message: 'worker not initialized' });
      return;
    }
    try {
      const result = await tess.recognize(msg.blob);
      const words: OcrWord[] = (result.data.words ?? [])
        .filter((w) => (w.confidence ?? 0) >= OCR_MIN_WORD_CONFIDENCE)
        .map((w) => ({
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          confidence: w.confidence ?? 0,
        }));
      post({ type: 'result', jobId: msg.jobId, text: result.data.text, words });
    } catch (err) {
      post({ type: 'error', jobId: msg.jobId, message: (err as Error).message });
    }
  }
};
```

### Step 2: Verify typecheck

- [ ] `npm --prefix pwa run typecheck`
  - Expected: clean.

### Step 3: Commit

- [ ] ```bash
git add pwa/src/ocr/tesseract-worker.ts
git commit -m "feat(pwa): tesseract Web Worker entry"
```

---

## Task 5: ocr/worker-client.ts (main-thread Promise wrapper)

**Files:**
- Create: `pwa/src/ocr/worker-client.ts`

No direct unit tests — covered by `queue.test.ts` via a fake worker-client.

### Step 1: Implement

- [ ] Create `pwa/src/ocr/worker-client.ts`:

```ts
import type { OcrResult, WorkerInput, WorkerOutput } from './types.js';

const WORKER_RECOGNIZE_TIMEOUT_MS = 30_000;

export interface IWorkerClient {
  init(): Promise<void>;
  recognize(blob: Blob): Promise<OcrResult>;
  terminate(): void;
}

interface PendingJob {
  resolve: (r: OcrResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerClient implements IWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private jobs = new Map<string, PendingJob>();
  private nextJobId = 0;

  private spawn(): Worker {
    // Vite resolves the URL ctor pattern at build time so the Worker is bundled.
    const w = new Worker(new URL('./tesseract-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerOutput>) => this.handle(e.data);
    w.onerror = () => this.failAll(new Error('worker fatal error'));
    return w;
  }

  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.worker = this.spawn();
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker init timeout')), 60_000);
      const onReady = (e: MessageEvent<WorkerOutput>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          this.worker!.removeEventListener('message', onReady);
          resolve();
        } else if (e.data.type === 'error' && e.data.jobId === 'init') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      this.worker!.addEventListener('message', onReady);
      this.post({ type: 'init' });
    });
    return this.ready;
  }

  recognize(blob: Blob): Promise<OcrResult> {
    if (!this.worker) return Promise.reject(new Error('worker not initialized'));
    const jobId = `j${this.nextJobId++}`;
    return new Promise<OcrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(jobId);
        reject(new Error('recognize timeout'));
      }, WORKER_RECOGNIZE_TIMEOUT_MS);
      this.jobs.set(jobId, { resolve, reject, timer });
      this.post({ type: 'recognize', jobId, blob });
    });
  }

  terminate(): void {
    if (this.worker) this.worker.terminate();
    this.failAll(new Error('worker terminated'));
    this.worker = null;
    this.ready = null;
  }

  private post(msg: WorkerInput): void { this.worker?.postMessage(msg); }

  private handle(msg: WorkerOutput): void {
    if (msg.type === 'result') {
      const job = this.jobs.get(msg.jobId);
      if (!job) return;
      clearTimeout(job.timer);
      this.jobs.delete(msg.jobId);
      job.resolve({ text: msg.text, words: msg.words });
    } else if (msg.type === 'error') {
      const job = this.jobs.get(msg.jobId);
      if (!job) return;
      clearTimeout(job.timer);
      this.jobs.delete(msg.jobId);
      job.reject(new Error(msg.message));
    }
  }

  private failAll(err: Error): void {
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    this.jobs.clear();
  }
}
```

### Step 2: Verify typecheck

- [ ] `npm --prefix pwa run typecheck`
  - Expected: clean.

### Step 3: Commit

- [ ] ```bash
git add pwa/src/ocr/worker-client.ts
git commit -m "feat(pwa): main-thread Promise wrapper around the OCR Web Worker"
```

---

## Task 6: ocr/queue.ts + tests

**Files:**
- Create: `pwa/src/ocr/queue.ts`
- Create: `pwa/tests/ocr/queue.test.ts`

### Step 1: Write failing tests

- [ ] Create `pwa/tests/ocr/queue.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OcrQueue } from '../../src/ocr/queue.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { OcrResult } from '../../src/ocr/types.js';
import type { Quad } from '../../src/scanner/types.js';

// Fake worker-client that we drive deterministically.
class FakeClient {
  initCalls = 0;
  terminateCalls = 0;
  pending: { blob: Blob; resolve: (r: OcrResult) => void; reject: (e: Error) => void }[] = [];
  init = vi.fn(async () => { this.initCalls++; });
  recognize = vi.fn((blob: Blob) => new Promise<OcrResult>((resolve, reject) => {
    this.pending.push({ blob, resolve, reject });
  }));
  terminate = vi.fn(() => { this.terminateCalls++; this.failAll(new Error('terminated')); });
  // Test-only helper:
  resolveNext(result: OcrResult): void {
    const job = this.pending.shift();
    if (!job) throw new Error('no pending job');
    job.resolve(result);
  }
  rejectNext(err: Error): void {
    const job = this.pending.shift();
    if (!job) throw new Error('no pending job');
    job.reject(err);
  }
  failAll(err: Error): void { while (this.pending.length) this.rejectNext(err); }
}

// Fake pdf builder (so queue tests don't depend on pdf-lib).
const fakePdf = vi.fn(async () => new Blob(['%PDF fake'], { type: 'application/pdf' }));

const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });
const ocr = (text: string): OcrResult => ({ text, words: [] });

let store: ScansStore;
let client: FakeClient;

beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
  client = new FakeClient();
  fakePdf.mockClear();
});

async function makeCompletedScan(pages: string[]): Promise<string> {
  const id = await store.createInProgress();
  for (const p of pages) await store.appendPage(id, blob(p), Q);
  await store.finish(id);
  await store.setPdfStatus(id, 'pending');
  return id;
}

describe('OcrQueue', () => {
  it('processes a single pending scan end-to-end and marks done', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);

    await q.start();
    // First page request goes out; resolve it
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('hello'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('world'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });
    expect(fakePdf).toHaveBeenCalledOnce();
    const pages = await store.getPages(id);
    expect(pages[0]!.ocrText).toBe('hello');
    expect(pages[1]!.ocrText).toBe('world');
  });

  it('partial: keeps building PDF when some pages fail; status = partial', async () => {
    const id = await makeCompletedScan(['p1', 'p2', 'p3']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('hello'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.rejectNext(new Error('blurry'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(3));
    client.resolveNext(ocr('world'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('partial');
    });
    expect(fakePdf).toHaveBeenCalledOnce();
  });

  it('failed: marks pdfStatus failed when all pages fail', async () => {
    await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalled());
    client.rejectNext(new Error('boom'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.rejectNext(new Error('boom'));

    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('failed');
    });
    expect(fakePdf).not.toHaveBeenCalled();
  });

  it('FIFO by updatedAt — older completed scan processes first', async () => {
    const a = await makeCompletedScan(['a']);
    await new Promise((r) => setTimeout(r, 5));
    const b = await makeCompletedScan(['b']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    // First job must be `a` (older). We can verify by completing it and watching state.
    client.resolveNext(ocr('a'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      const aRow = list.find((s) => s.id === a);
      expect(aRow!.pdfStatus).toBe('done');
    });
    expect((await store.listCompleted()).find((s) => s.id === b)!.pdfStatus).toBe('running');
  });

  it('resume: skips pages that already have ocrText', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    // Pre-OCR page 0 (simulating mid-OCR tab kill)
    await store.setPageOcr(id, 0, 'pre-existing', []);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    // Only page 1 should be sent to the worker
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('p1-text'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });
    expect(client.recognize).toHaveBeenCalledTimes(1);
  });

  it('cancel during in-flight terminates worker and stops processing', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    q.cancel(id);
    expect(client.terminateCalls).toBeGreaterThan(0);
    // No PDF was assembled
    expect(fakePdf).not.toHaveBeenCalled();
  });

  it('retry: resets state and re-queues', async () => {
    const id = await makeCompletedScan(['p1']);
    const q = new OcrQueue(store, client, fakePdf);
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.rejectNext(new Error('boom'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('failed');
    });

    await q.retry(id);
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('done'));
    await vi.waitFor(async () => {
      const list = await store.listCompleted();
      expect(list[0]!.pdfStatus).toBe('done');
    });
  });

  it('emits progress events', async () => {
    const id = await makeCompletedScan(['p1', 'p2']);
    const q = new OcrQueue(store, client, fakePdf);
    const events: { scanId: string; doneCount: number; totalCount: number }[] = [];
    q.on('progress', (e) => events.push(e));
    await q.start();
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(1));
    client.resolveNext(ocr('a'));
    await vi.waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
    client.resolveNext(ocr('b'));
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    expect(events.some((e) => e.scanId === id && e.doneCount === 1 && e.totalCount === 2)).toBe(true);
  });
});
```

### Step 2: Implement `queue.ts`

- [ ] Create `pwa/src/ocr/queue.ts`:

```ts
import { ScansStore } from '../scanner/scans-store.js';
import type { Page, Scan } from '../scanner/types.js';
import type { IWorkerClient } from './worker-client.js';
import { WorkerClient } from './worker-client.js';

export interface ProgressEvent { scanId: string; doneCount: number; totalCount: number; }
export interface DoneEvent { scanId: string; pdfStatus: 'done' | 'partial'; }
export interface FailedEvent { scanId: string; error: string; }

type Listener<T> = (event: T) => void;

export type PdfBuilder = (pages: { blob: Blob; ocrText: string; ocrWords: import('../scanner/types.js').OcrWord[] }[]) => Promise<Blob>;

export class OcrQueue {
  private queue: string[] = [];                // scanIds in order
  private currentScanId: string | null = null;
  private cancelled = new Set<string>();
  private listeners: Record<string, Listener<any>[]> = {};

  constructor(
    private readonly store: ScansStore,
    private readonly client: IWorkerClient = new WorkerClient(),
    private readonly buildPdf: PdfBuilder = (async () => { throw new Error('PDF builder not provided'); }),
  ) {}

  async start(): Promise<void> {
    // Reset any 'running' rows back to 'pending' (resume after crash)
    const all = await this.store.findPendingPdf();
    for (const s of all) {
      if (s.pdfStatus === 'running') await this.store.setPdfStatus(s.id, 'pending');
    }
    // Sort by updatedAt asc (oldest first)
    const sorted = all.slice().sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of sorted) this.enqueue(s.id);
  }

  enqueueAfterFinish(scanId: string): void { this.enqueue(scanId); }

  private enqueue(scanId: string): void {
    if (!this.queue.includes(scanId) && this.currentScanId !== scanId) {
      this.queue.push(scanId);
    }
    void this.processNext();
  }

  cancel(scanId: string): void {
    this.cancelled.add(scanId);
    this.queue = this.queue.filter((id) => id !== scanId);
    if (this.currentScanId === scanId) {
      this.client.terminate();
      this.currentScanId = null;
      // worker recreates itself on next init() call inside processNext
    }
  }

  async retry(scanId: string): Promise<void> {
    await this.store.setPdfStatus(scanId, 'pending');
    await this.store.clearScanOcr(scanId);
    this.cancelled.delete(scanId);
    this.enqueue(scanId);
  }

  on<T>(event: 'progress' | 'done' | 'failed', listener: Listener<T>): void {
    (this.listeners[event] = this.listeners[event] ?? []).push(listener);
  }

  private emit(event: string, payload: any): void {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }

  private async processNext(): Promise<void> {
    if (this.currentScanId !== null) return; // already processing
    const scanId = this.queue.shift();
    if (!scanId) return;
    if (this.cancelled.has(scanId)) { this.cancelled.delete(scanId); return void this.processNext(); }
    this.currentScanId = scanId;

    try {
      await this.client.init();
      await this.store.setPdfStatus(scanId, 'running');
      const pages = await this.store.getPages(scanId);

      let okCount = 0;
      let failCount = 0;
      for (const page of pages) {
        if (this.cancelled.has(scanId)) break;
        if (page.ocrText && page.ocrWords) { okCount++; this.emit('progress', { scanId, doneCount: okCount + failCount, totalCount: pages.length }); continue; }
        try {
          const r = await this.client.recognize(page.blob);
          await this.store.setPageOcr(scanId, page.ordinal, r.text, r.words);
          okCount++;
        } catch (err) {
          await this.store.setPageOcr(scanId, page.ordinal, '', []);
          failCount++;
        }
        this.emit('progress', { scanId, doneCount: okCount + failCount, totalCount: pages.length });
      }

      if (this.cancelled.has(scanId)) {
        this.cancelled.delete(scanId);
        this.currentScanId = null;
        return void this.processNext();
      }

      if (okCount === 0) {
        await this.store.setPdfStatus(scanId, 'failed', 'OCR failed on every page');
        this.emit('failed', { scanId, error: 'OCR failed on every page' });
      } else {
        const fresh = await this.store.getPages(scanId);
        const pdfBlob = await this.buildPdf(fresh.map((p) => ({
          blob: p.blob,
          ocrText: p.ocrText ?? '',
          ocrWords: p.ocrWords ?? [],
        })));
        await this.store.setPdfBlob(scanId, pdfBlob);
        const status = failCount === 0 ? 'done' : 'partial';
        await this.store.setPdfStatus(scanId, status);
        this.emit('done', { scanId, pdfStatus: status });
      }
    } catch (err) {
      await this.store.setPdfStatus(scanId, 'failed', (err as Error).message);
      this.emit('failed', { scanId, error: (err as Error).message });
    } finally {
      this.currentScanId = null;
      void this.processNext();
    }
  }
}
```

### Step 3: Run tests

- [ ] `npm --prefix pwa test -- queue`
  - Expected: 8 passing.

### Step 4: Commit

- [ ] ```bash
git add pwa/src/ocr/queue.ts pwa/tests/ocr/queue.test.ts
git commit -m "feat(pwa): OcrQueue orchestrator with FIFO + resume + cancel"
```

---

## Task 7: pdf/build.ts + tests

**Files:**
- Create: `pwa/src/pdf/build.ts`
- Create: `pwa/tests/pdf/build.test.ts`

### Step 1: Write failing tests

- [ ] Create `pwa/tests/pdf/build.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildSearchablePdf } from '../../src/pdf/build.js';
import type { OcrWord } from '../../src/scanner/types.js';

// happy-dom doesn't provide createImageBitmap; we use a small fixture JPEG
// stored as bytes in the test, then build a Blob.
const FIXTURE_PATH = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
function fixtureBlob(): Blob { return new Blob([readFileSync(FIXTURE_PATH)], { type: 'image/jpeg' }); }

const word = (text: string, x: number, y: number): OcrWord =>
  ({ text, x, y, w: 50, h: 20, confidence: 90 });

describe('buildSearchablePdf', () => {
  it('produces a valid 2-page PDF from 2 input pages', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'hello', ocrWords: [word('hello', 10, 10)] },
      { blob, ocrText: 'world', ocrWords: [word('world', 10, 10)] },
    ]);
    expect(pdfBlob.type).toBe('application/pdf');

    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it('embeds an image per page (image layer)', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'hi', ocrWords: [word('hi', 10, 10)] },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    // pdf-lib doesn't expose embedded images directly, but the file size
    // should exceed the bare-minimum PDF (~600 bytes); embedding a JPEG adds
    // at least the JPEG size (small fixture is ~700 bytes).
    expect(bytes.length).toBeGreaterThan(1000);
    expect(doc.getPageCount()).toBe(1);
  });

  it('skips pages with no ocrText (still embeds the image)', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: '', ocrWords: [] },
      { blob, ocrText: 'searchable', ocrWords: [word('searchable', 10, 10)] },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    // Both pages exist; no exception even when ocrWords is empty.
  });
});
```

### Step 2: Add the JPEG fixture

- [ ] ```bash
mkdir -p pwa/src/pdf/fixtures
# A 2x1 red JPEG (smallest valid JPEG that pdf-lib can embed):
node -e "
const { Buffer } = require('node:buffer');
const { writeFileSync } = require('node:fs');
const b64 =
  '/9j/4AAQSkZJRgABAQEAAQABAAD/2wBDAAYEBAQFBAYFBQYJBgUGCQsIBgYICwwKCgsKCgwQDAwM' +
  'DAwMEAwODxAPDgwTExQUExMcGxsbHB8fHx8fHx8fHx//2wBDAQcHBw0MDRgQEBgaFREVGh8fHx8f' +
  'Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx//wAARCAABAAIDASIA' +
  'AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB' +
  'AAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z';
writeFileSync('pwa/src/pdf/fixtures/2x1-red.jpg', Buffer.from(b64, 'base64'));
"
ls -lh pwa/src/pdf/fixtures/2x1-red.jpg
```

If the embedded base64 above is rejected by pdf-lib (some JPEG decoders are strict), use a slightly larger valid JPEG: any 100×100 photo will do. Save bytes-as-base64 in the same way.

### Step 3: Implement `pdf/build.ts`

- [ ] Create `pwa/src/pdf/build.ts`:

```ts
import { PDFDocument, rgb } from 'pdf-lib';
import type { OcrWord } from '../scanner/types.js';

const PDF_PAGE_DPI = 144;
const PT_PER_PX = 72 / PDF_PAGE_DPI;

export interface PageInput {
  blob: Blob;
  ocrText: string;
  ocrWords: OcrWord[];
}

/** Assembles a searchable PDF: each input page becomes a PDF page with the
 *  source image as the visible layer and per-word invisible text drawn at
 *  the OCR-detected positions. */
export async function buildSearchablePdf(pages: PageInput[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');

  for (const page of pages) {
    const bytes = new Uint8Array(await page.blob.arrayBuffer());
    const image = await doc.embedJpg(bytes);
    // Page sized in points to match image at PDF_PAGE_DPI
    const widthPt = image.width * PT_PER_PX;
    const heightPt = image.height * PT_PER_PX;
    const pdfPage = doc.addPage([widthPt, heightPt]);

    pdfPage.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });

    // Invisible text layer. Word boxes are in image pixels with origin top-left;
    // PDF origin is bottom-left. Convert.
    for (const w of page.ocrWords) {
      const xPt = w.x * PT_PER_PX;
      const yPt = heightPt - (w.y + w.h) * PT_PER_PX;
      const sizePt = Math.max(4, w.h * PT_PER_PX);
      pdfPage.drawText(w.text, {
        x: xPt,
        y: yPt,
        size: sizePt,
        font,
        color: rgb(0, 0, 0),
        opacity: 0,
      });
    }
  }

  const out = await doc.save();
  return new Blob([out], { type: 'application/pdf' });
}
```

### Step 4: Run tests

- [ ] `npm --prefix pwa test -- pdf/build`
  - Expected: 3 passing.

### Step 5: Commit

- [ ] ```bash
git add pwa/src/pdf/build.ts pwa/tests/pdf/build.test.ts pwa/src/pdf/fixtures
git commit -m "feat(pwa): pdf/build — searchable PDF assembly via pdf-lib"
```

---

## Task 8: Wire scanner-session + App.tsx to the queue

**Files:**
- Modify: `pwa/src/scanner/scanner-session.ts`
- Modify: `pwa/src/ui/App.tsx`
- Modify: `pwa/src/ui/ScannerScreen.tsx` (forward queue prop)
- Modify: `pwa/src/ui/SavedScansScreen.tsx` (accept queue prop)
- Modify: `pwa/src/ui/ScanViewerScreen.tsx` (accept queue prop)

### Step 1: scanner-session.finish marks pdfStatus

- [ ] Edit `pwa/src/scanner/scanner-session.ts`'s `finish()`:

```ts
async finish(): Promise<void> {
  this.stop();
  await this.store.finish(this.scanId);
  await this.store.setPdfStatus(this.scanId, 'pending');
}
```

### Step 2: App.tsx instantiates OcrQueue

- [ ] Edit `pwa/src/ui/App.tsx`:

```tsx
// Add to the imports:
import { OcrQueue } from '../ocr/queue.js';
import { WorkerClient } from '../ocr/worker-client.js';
import { buildSearchablePdf } from '../pdf/build.js';

// Replace the existing `const [store] = useState(...)` block with:
const [store] = useState(() => new ScansStore());
const [queue] = useState(() => new OcrQueue(store, new WorkerClient(), buildSearchablePdf));

// In the existing first useEffect (after store.open() resolves), kick off the queue:
useEffect(() => {
  api.status().then((s) => setEmail(s.email))
    .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
    .finally(() => setLoaded(true));
  store.open()
    .then(() => queue.start().catch((e) => console.error('queue start', e)))
    .catch((e) => console.error('open store', e));
}, []);
```

Pass `queue` as a prop to ScannerScreen, SavedScansScreen, ScanViewerScreen in the route switch:

```tsx
case 'scanner':
  return <ScannerScreen
    store={store}
    queue={queue}
    resumeScanId={route.resumeScanId}
    onBack={() => setRoute({ kind: 'status' })}
    onDone={() => setRoute({ kind: 'saved' })}
  />;
case 'saved':
  return <SavedScansScreen
    store={store}
    queue={queue}
    onBack={() => setRoute({ kind: 'status' })}
    onNewScan={() => setRoute({ kind: 'scanner' })}
    onView={(scanId) => setRoute({ kind: 'viewer', scanId })}
  />;
case 'viewer':
  return <ScanViewerScreen
    store={store}
    queue={queue}
    scanId={route.scanId}
    onBack={() => setRoute({ kind: 'saved' })}
  />;
```

### Step 3: ScannerScreen forwards to queue after Done

- [ ] Edit `pwa/src/ui/ScannerScreen.tsx`. Add `queue: OcrQueue` to `ScannerScreenProps` and call it from the `done()` handler:

```tsx
import type { OcrQueue } from '../ocr/queue.js';

export interface ScannerScreenProps {
  store: ScansStore;
  queue: OcrQueue;
  // ... existing
}

// In the done() handler:
async function done() {
  if (pageCount === 0) { await sessionRef.current?.discard(); onBack(); return; }
  const scanId = sessionRef.current?.scanId;
  await sessionRef.current?.finish();
  if (scanId) queue.enqueueAfterFinish(scanId);
  onDone();
}
```

### Step 4: Add `queue` props to SavedScansScreen + ScanViewerScreen

- [ ] Edit `pwa/src/ui/SavedScansScreen.tsx`: add `queue: OcrQueue` to `SavedScansScreenProps`. Don't use it yet — Task 9 wires up the UI.

- [ ] Edit `pwa/src/ui/ScanViewerScreen.tsx`: add `queue: OcrQueue` to `ScanViewerScreenProps`. Same — Task 10 uses it.

- [ ] Edit `pwa/tests/ui/SavedScansScreen.test.tsx`: every `render(<SavedScansScreen ... />)` call now needs `queue={{} as any}` (or a real instance — Task 9 replaces these with proper queue fixtures). Without this update typecheck will fail.

### Step 5: Verify typecheck + run tests

- [ ] ```bash
npm --prefix pwa run typecheck
npm --prefix pwa test 2>&1 | tail -5
```

Expected: typecheck clean; existing tests still pass.

### Step 6: Commit

- [ ] ```bash
git add pwa/src/scanner/scanner-session.ts pwa/src/ui pwa/tests/ui/SavedScansScreen.test.tsx
git commit -m "feat(pwa): wire OcrQueue into App.tsx and ScannerScreen.done()"
```

---

## Task 9: SavedScansScreen UI — progress, retry, download

**Files:**
- Modify: `pwa/src/ui/SavedScansScreen.tsx`
- Modify: `pwa/tests/ui/SavedScansScreen.test.tsx`

### Step 1: Write failing tests

- [ ] Add to `pwa/tests/ui/SavedScansScreen.test.tsx`:

```tsx
import { OcrQueue } from '../../src/ocr/queue.js';

// In existing beforeEach, also instantiate a queue with a no-op client:
let queue: OcrQueue;
beforeEach(async () => {
  // ... existing setup ...
  queue = new OcrQueue(store, { init: async () => {}, recognize: async () => ({ text: '', words: [] }), terminate: () => {} } as any, async () => new Blob());
});

// Test renders should pass `queue={queue}` as a prop.

it('shows "OCR queued" for a row with pdfStatus pending', async () => {
  const id = await store.createInProgress();
  await store.appendPage(id, blob('p'), Q);
  await store.finish(id);
  await store.setPdfStatus(id, 'pending');

  render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
  await waitFor(() => expect(screen.getByText(/ocr queued/i)).toBeInTheDocument());
});

it('shows "OCR\'ing N/M" when queue emits progress for the row', async () => {
  const id = await store.createInProgress();
  await store.appendPage(id, blob('p1'), Q);
  await store.appendPage(id, blob('p2'), Q);
  await store.finish(id);
  await store.setPdfStatus(id, 'running');
  render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);

  // Simulate progress emission
  (queue as any).emit('progress', { scanId: id, doneCount: 1, totalCount: 2 });
  await waitFor(() => expect(screen.getByText(/ocr.*1\/2/i)).toBeInTheDocument());
});

it('shows Download button when pdfStatus is done', async () => {
  const id = await store.createInProgress();
  await store.appendPage(id, blob('p'), Q);
  await store.finish(id);
  await store.setPdfBlob(id, new Blob(['%PDF'], { type: 'application/pdf' }));
  await store.setPdfStatus(id, 'done');
  render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument());
});

it('shows Retry button on failed; tap calls queue.retry', async () => {
  const id = await store.createInProgress();
  await store.appendPage(id, blob('p'), Q);
  await store.finish(id);
  await store.setPdfStatus(id, 'failed', 'boom');
  const retrySpy = vi.spyOn(queue, 'retry').mockResolvedValue();
  render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(retrySpy).toHaveBeenCalledWith(id);
});

it('delete cancels queue then deletes the scan', async () => {
  const id = await store.createInProgress();
  await store.appendPage(id, blob('p'), Q);
  await store.finish(id);
  await store.setPdfStatus(id, 'running');
  const cancelSpy = vi.spyOn(queue, 'cancel');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
  await waitFor(() => expect(screen.getByText(/1 page/i)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
  await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(id));
});
```

### Step 2: Update `SavedScansScreen.tsx`

- [ ] Update the component to subscribe to queue events, show per-row state, render the right buttons. Key additions:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { OcrQueue, type ProgressEvent, type DoneEvent, type FailedEvent } from '../ocr/queue.js';
import type { Scan } from '../scanner/types.js';

export interface SavedScansScreenProps {
  store: ScansStore;
  queue: OcrQueue;
  onBack: () => void;
  onNewScan: () => void;
  onView: (scanId: string) => void;
}

export function SavedScansScreen({ store, queue, onBack, onNewScan, onView }: SavedScansScreenProps) {
  // Existing state...
  const [progress, setProgress] = useState<Record<string, { doneCount: number; totalCount: number }>>({});

  useEffect(() => {
    const onProg = (e: ProgressEvent) => setProgress((p) => ({ ...p, [e.scanId]: { doneCount: e.doneCount, totalCount: e.totalCount } }));
    const onDone = (_: DoneEvent) => reload();   // re-fetch to pick up new pdfStatus
    const onFail = (_: FailedEvent) => reload();
    queue.on('progress', onProg);
    queue.on('done', onDone);
    queue.on('failed', onFail);
    // No detach — OcrQueue is app-lifetime; minor leak fine for SPA
  }, []);

  // In del():
  async function del(scanId: string) {
    if (!window.confirm('Delete this scan?')) return;
    queue.cancel(scanId);
    await store.delete(scanId);
    await reload();
  }

  // In the row render, replace the existing "Today, ..." / "MB" line with status-aware label:
  const status = renderRowStatus(s, progress[s.id]);

  // ... where renderRowStatus is a small helper at module scope:
}

function renderRowStatus(s: Scan, prog: { doneCount: number; totalCount: number } | undefined): JSX.Element {
  switch (s.pdfStatus) {
    case 'done':
    case 'partial':
      return <span class="muted">PDF ready{s.pdfStatus === 'partial' ? ' (partial)' : ''}</span>;
    case 'failed':
      return <span class="error-text">Failed: {s.ocrError ?? 'unknown'}</span>;
    case 'running':
      return <span class="muted">OCR'ing {prog?.doneCount ?? 0}/{prog?.totalCount ?? s.pageCount}</span>;
    case 'pending':
    default:
      return <span class="muted">OCR queued</span>;
  }
}
```

Add the right-side action button per status:

```tsx
function rowAction(s: Scan, queue: OcrQueue, store: ScansStore): JSX.Element | null {
  if (s.pdfStatus === 'done' || s.pdfStatus === 'partial') {
    return <button class="btn" onClick={() => downloadPdf(s, store)}>Download</button>;
  }
  if (s.pdfStatus === 'failed') {
    return <button class="btn btn-secondary" onClick={() => queue.retry(s.id)}>Retry</button>;
  }
  return null;
}

// downloadPdf lives in its own module so ScanViewerScreen (Task 10) can reuse it
// without circular imports. Move/create the helper at pwa/src/ui/download.ts:
import { downloadPdf } from './download.js';
```

And create `pwa/src/ui/download.ts`:

```ts
import { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';

export async function downloadPdf(s: Scan, store: ScansStore): Promise<void> {
  if (!s.pdfKey) return;
  const blob = await store.getPdf(s.pdfKey);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scan-${new Date(s.updatedAt).toISOString().replace(/[:.]/g, '-')}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}
```

Adjust the `<li>` layout to render `status` inside the existing meta block and put the new action button alongside the existing trash button.

### Step 3: Run tests

- [ ] ```bash
npm --prefix pwa test -- SavedScansScreen
```
Expected: existing 3 + new 5 = 8 passing.

### Step 4: Commit

- [ ] ```bash
git add pwa/src/ui/SavedScansScreen.tsx pwa/tests/ui/SavedScansScreen.test.tsx
git commit -m "feat(pwa): SavedScansScreen — OCR progress, retry, download PDF"
```

---

## Task 10: ScanViewerScreen — Download button

**Files:**
- Modify: `pwa/src/ui/ScanViewerScreen.tsx`

No new tests; this is a small render-only addition.

### Step 1: Implement

- [ ] Edit `ScanViewerScreen.tsx`. Accept `queue: OcrQueue` (unused for now — symmetry with other screens) and add a Download button to the header when the scan's PDF is ready:

```tsx
const [scanRow, setScanRow] = useState<Scan | null>(null);
useEffect(() => {
  store.listCompleted().then((all) => setScanRow(all.find((s) => s.id === scanId) ?? null));
}, [scanId]);

// In the header JSX:
<header style={{ ... }}>
  <button class="btn btn-secondary" onClick={onBack}>← Back</button>
  <strong>{idx + 1} / {pages.length}</strong>
  <span style={{ display: 'flex', gap: 8 }}>
    {(scanRow?.pdfStatus === 'done' || scanRow?.pdfStatus === 'partial') && (
      <button class="btn" onClick={() => downloadPdf(scanRow, store)}>Download</button>
    )}
    <button class="btn btn-danger" aria-label="Delete scan" onClick={deleteScan}>🗑</button>
  </span>
</header>
```

Reuse the `downloadPdf` helper from `pwa/src/ui/download.ts` (created in Task 9):

```tsx
import { downloadPdf } from './download.js';
```

### Step 2: Verify typecheck + tests

- [ ] ```bash
npm --prefix pwa run typecheck
npm --prefix pwa test 2>&1 | tail -5
```

### Step 3: Commit

- [ ] ```bash
git add pwa/src/ui/ScanViewerScreen.tsx
git commit -m "feat(pwa): ScanViewerScreen — Download PDF button when ready"
```

---

## Task 11: Service Worker + Vite chunks

**Files:**
- Modify: `pwa/public/sw.js`
- Modify: `pwa/vite.config.ts`

### Step 1: Update SW patterns + bump cache name

- [ ] Edit `pwa/public/sw.js`:

```js
const CACHE_NAME = 'docscanner-scanner-v3';
const RUNTIME_CACHE_PATTERNS = [
  /\/assets\/scanner-core-.*\.js$/,
  /\/assets\/ocr-core-.*\.js$/,
  /\/scanner\//,
  /\/opencv\//,
  /\/ocr\//,
];
```

The activate handler already drops non-current caches, so `v2` entries get cleaned up automatically.

### Step 2: Add OCR chunk to manualChunks

- [ ] Edit `pwa/vite.config.ts`:

```ts
manualChunks(id) {
  if (id.includes('/scanner/edge-detect') || id.includes('/scanner/scanner-session')) return 'scanner-core';
  if (id.includes('/ocr/queue') || id.includes('/ocr/worker-client') || id.includes('/pdf/build')) return 'ocr-core';
},
```

(Note: tesseract.js itself stays in its own auto-chunk — Vite handles it. The `ocr-core` chunk is for *our* glue.)

### Step 3: Verify build emits expected chunks

- [ ] ```bash
npm --prefix pwa run build
ls pwa/dist/assets/ | grep -E 'scanner-core|ocr-core|tesseract'
```
Expected: at minimum `scanner-core-*.js` and `ocr-core-*.js`. Tesseract's own files (`tesseract.js-*`, worker, wasm) appear under `pwa/dist/assets/` too — they're served same-origin and the `/assets/` prefix is matched implicitly via the chunk-name patterns.

### Step 4: Commit

- [ ] ```bash
git add pwa/public/sw.js pwa/vite.config.ts
git commit -m "feat(pwa): SW caches /ocr/* + ocr-core chunk; manualChunks splits ocr code"
```

---

## Task 12: Manual smoke + tag

User-driven, not automated.

### Step 1: Boot stack

- [ ] ```bash
docker compose down && docker compose up -d --build
```

If using ngrok for HTTPS phone testing: `ngrok http 3000` and grab the URL.

### Step 2: Run all 7 manual smoke cases (from spec)

- [ ] Capture a 3-page document → row flips to **Download** within ~30 s on real phone → tap → real searchable PDF lands in Files / Photos.
- [ ] Open the saved PDF in any reader → search for a word visible on page 2 → it highlights at the right location.
- [ ] Capture a scan → swipe-up close mid-OCR → reopen → it picks up where it left off; already-OCR'd pages don't re-process.
- [ ] Capture two scans back-to-back → second shows "OCR queued" while first runs.
- [ ] Capture a deliberately blurry page → row reaches "OCR partial — N-1/N pages searchable"; PDF still has readable pages searchable.
- [ ] Airplane mode before *first ever* scan → row reaches "OCR engine unavailable" with Retry. Reconnect → tap Retry → succeeds.
- [ ] Phase 3 leftover scans (created before Phase 4) → on first app open after Phase 4 ships, those rows pick up "OCR queued" and process through.

### Step 3: Record results in this plan

- [ ] Append to the bottom:

```markdown
## Smoke Results

_Date:_ <YYYY-MM-DD>
_Test device:_ <iPhone model + iOS version>
_Notes:_
- <one bullet per smoke case>
```

### Step 4: Final commits + tag

- [ ] ```bash
git add docs/superpowers/plans/2026-04-30-phase-4-ocr-pdf.md
git commit -m "docs: phase 4 smoke recorded"
git tag -a phase-4-complete -m "Phase 4: OCR + searchable PDF assembly — smoke verified"
git push origin main
git push origin phase-4-complete
```

---

## Phase 4 Done — Definition

- All Phase 1+2+3+4 unit tests pass: server-side and PWA-side.
- `pwa/dist/` builds clean; `scanner-core` and `ocr-core` chunks present; tesseract.js worker + wasm under `dist/assets/`.
- `pwa/dist/ocr/eng.traineddata.gz` present.
- All earlier-phase manual smokes still work.
- Phase 4 manual smoke succeeds on a real phone (the 7 cases above).
- No new server endpoints. No edits to `server/` source.
- `phase-4-complete` tag pushed to origin.

---

## Smoke Results

_Date:_
_Test device:_
_Notes:_
