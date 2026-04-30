# Phase 4: OCR & Searchable PDF Assembly — Design Spec

**Date:** 2026-04-30
**Status:** Draft for review
**Owner:** ow@mroliverwine.com (single-user personal project)
**Predecessor:** [Phase 3 — Scanner Pipeline](2026-04-29-phase-3-scanner-pipeline-design.md) (tagged `phase-3-complete`)
**Parent design:** [doc-scanner — overall design spec](2026-04-27-doc-scanner-design.md)

## Goal

Take the multi-page scans persisted by Phase 3 and turn them into searchable PDFs in the background. Run OCR on every page using Tesseract.js in a Web Worker, assemble a single PDF per scan with `pdf-lib` (image layer + invisible text layer aligned to word boxes), and surface a Download action on the Saved Scans row when ready.

At the end of Phase 4, every saved scan automatically becomes a searchable PDF. The user can download that PDF locally; uploading to Drive remains a future phase.

## Non-Goals

These are deliberately deferred to later phases:

- **Classification.** No Anthropic Haiku, no `/api/classify`, no AI-suggested filename or folder. Phase 5.
- **Real upload.** No `/api/upload`, no folder picker. Phase 6.
- **PDF text-layer detection / pass-through for already-searchable inputs.** Journey C from the parent design (importing existing PDFs) is out of scope. Phase 4 only OCRs scans we captured.
- **Multi-language OCR.** English (`eng`) only. No language picker.
- **Per-scan custom filenames.** Generated as `scan-<ISO timestamp>.pdf`. Renaming is Phase 5's job (AI suggestion + user confirmation).
- **Inline PDF preview.** The Download action saves the PDF locally; the OS / browser handles viewing.
- **Page rotation correction**, **deskew tuning**, **PDF/A**, **signed PDFs**, **confidence-based reprocessing**.

## Constraints & Context

- **PWA-only.** Zero server-side changes. The Phase 1–3 server is untouched.
- **Existing PWA stack** (Preact + Vite + Vitest + happy-dom + idb + ulid + the vendored opencv.js + jscanify).
- **Bundle weight.** Tesseract.js is ~3 MB compressed JS; `eng.traineddata` is ~10 MB compressed. Both are lazy-loaded on the OcrQueue's first job, vendored same-origin into `pwa/public/ocr/` so the Service Worker's same-origin guard caches them.
- **Phone CPU + battery.** Tesseract on iPhone Safari runs at ~5–10 s per US-Letter page. Single Web Worker, FIFO queue (no concurrent OCR jobs).
- **IndexedDB quota** on iOS Safari can prompt eviction at ~50 MB. Phase 3 accepted this; Phase 4 doubles per-scan storage by adding the assembled PDF. Still safe for personal-use volumes (a few/week × months).
- **Resume on tab kill.** Per-page OCR results are persisted as soon as Tesseract returns them, so a mid-OCR app close picks up at the next un-OCR'd page on next boot.

## Decisions Made During Brainstorming

| Question | Decision |
|---|---|
| When does OCR run | Auto on scan completion; user does nothing extra |
| Parallelism | Single Web Worker, FIFO queue, oldest-pending-first |
| Cancellation | Deleting a scan during OCR cancels its job |
| Pre-existing Phase 3 scans | Treated as `pdfStatus='pending'` on app open; queue picks them up |
| OCR language | English only; constant `OCR_LANGUAGE = 'eng'` |
| Failure granularity | Per-page failures keep the rest of the PDF; status becomes `'partial'` |
| Word confidence floor | Drop words with Tesseract confidence < 30 from the text layer |
| Output destination | Stored in IndexedDB; user-initiated download via `<a download>` |
| Inline preview | Out of scope; rely on OS PDF reader |
| Retention | Keep both pages and PDF (revisit in Phase 6 with delete-on-upload) |

## Architecture Overview

Two new module groups inside `pwa/src/`. One singleton `OcrQueue` orchestrates everything; pure-logic units (PDF assembly, queue state machine) are unit-testable; the Tesseract boundary is covered by manual smoke.

```
pwa/src/ocr/
  types.ts            OcrResult, OcrJob, OcrWord, WorkerInput/Output
  tesseract-worker.ts Web Worker entry. Imports tesseract.js, receives page blobs, returns text + word boxes
  worker-client.ts    Main-thread Promise wrapper around the Web Worker
  queue.ts            Singleton FIFO orchestrator: claims pending scans, drives the worker, persists results, emits progress events

pwa/src/pdf/
  build.ts            Assembles searchable PDF from page blobs + per-page OCR results via pdf-lib
```

**Trust / data boundary unchanged.** Pages, OCR text, and PDFs all live on the phone. Server still doesn't see them in Phase 4.

## Components

### New PWA modules

- **`ocr/types.ts`** — Shared types. `OcrWord = { text, x, y, w, h, confidence }` (pixel coords in source image). `OcrResult = { text, words: OcrWord[] }`. `WorkerInput`/`WorkerOutput` discriminated unions for the postMessage protocol.
- **`ocr/tesseract-worker.ts`** — Web Worker entry point. On `init` message: lazy-imports tesseract.js, instantiates a worker with `eng.traineddata` from `/ocr/eng.traineddata.gz`. On `recognize` message: takes a page Blob, runs `recognize`, normalizes Tesseract's word output into our `OcrWord` shape, posts `result` back. On `terminate`: shuts down the underlying tesseract worker.
- **`ocr/worker-client.ts`** — Main-thread API. `init()` returns a promise that resolves on the worker's `ready` message. `recognize(blob) → Promise<OcrResult>` posts a job and resolves on the matching `result`. Tracks pending jobs by `jobId`. Handles worker `onerror` by rejecting all pending jobs and re-creating the worker (so a fatal crash on one page doesn't poison subsequent pages).
- **`ocr/queue.ts`** — `OcrQueue` class. Singleton (one per app instance). Public API: `start(store)` (call once at app boot), `enqueueAfterFinish(scanId)` (called from `scanner-session.finish`), `cancel(scanId)`, plus event emitters for `progress`/`done`/`failed` so SavedScansScreen can subscribe. Internally: maintains an in-memory queue of scan IDs, drives the `worker-client`, persists per-page OCR results to `pages` and per-scan PDF + status to `scans` + `pdfs`.
- **`pdf/build.ts`** — `buildSearchablePdf({pages: PageInput[]}) → Promise<Blob>`. For each page: load the JPEG, embed it in a new PDF page sized to the image's pixel dimensions converted via `PDF_PAGE_DPI`. For each `OcrWord` whose confidence ≥ `OCR_MIN_WORD_CONFIDENCE`, draw the text in transparent (`opacity: 0` or `renderingMode: 3`) at the word's PDF-space position with a font size sized to the word's box height. The result is a searchable PDF whose visible content is the page image and whose invisible text layer is selectable / searchable / OCR-text-extractable.

### Touched existing modules

- **`scanner/scans-store.ts`** — Bumps DB version to `2`. Adds the `pdfs` object store. New fields on existing rows are read with `?? defaultValue` (no data migration). Adds `setPdfStatus(scanId, status, error?)`, `setPdfBlob(scanId, blob)`, `setPageOcr(scanId, ordinal, text, words)`, `findPendingPdf(): Scan[]`, `getPdf(pdfKey): Blob | null`. `delete()` cascades the PDF blob alongside pages and the thumbnail.
- **`scanner/scanner-session.ts`** — `finish()` now sets `pdfStatus = 'pending'` on the scan and calls `OcrQueue.enqueueAfterFinish(scanId)` (queue passed in via constructor or set via a setter — TBD in plan).
- **`ui/App.tsx`** — On mount, instantiates `new OcrQueue(store)` and calls `start()`. Passes the queue down as a prop to `SavedScansScreen` and `ScanViewerScreen`. Stops the queue on unmount.
- **`ui/SavedScansScreen.tsx`** — Each row subscribes to queue events for its scan ID. Renders one of: pending spinner with "OCR queued"; running spinner with "OCR'ing N/M"; partial banner with "OCR partial — N/M pages searchable" + Download button; done with Download button; failed with `ocrError` text + Retry button. Trash now calls `queue.cancel()` then `store.delete()`.
- **`ui/ScanViewerScreen.tsx`** — Header gains a Download button when the scan's `pdfStatus === 'done'` or `'partial'`.
- **`public/sw.js`** — Adds `/ocr/` to the runtime cache patterns (matches `tesseract.js` and `eng.traineddata.gz`). Bumps `CACHE_NAME` to `v3` so prior versions are dropped on activate.
- **`vite.config.ts`** — `manualChunks` adds an `ocr-core` entry for `pwa/src/ocr/queue` and `pwa/src/pdf/build`, so the SW pattern can match the chunk regardless of build hash.

### New PWA dependencies

- **`tesseract.js`** — pure JS + wasm. Pinned minor version. Browser entry only; no equivalent of jscanify's Node-entry trap.
- **`pdf-lib`** — pure JS, no native deps, well-supported.
- **Vendored**: `pwa/public/ocr/eng.traineddata.gz` (~10 MB). Renovate is configured to ignore `pwa/public/**`.

## Data Model

IndexedDB database `docscanner`, version **`2`** (was `1` in Phase 3).

```
ObjectStore "scans" — extended
  EXISTING:  id, status, pageCount, createdAt, updatedAt, thumbnailKey
  NEW:
    pdfStatus    'pending' | 'running' | 'done' | 'failed' | 'partial' | undefined
                 (undefined = legacy Phase 3 scan; queue treats as 'pending')
    pdfKey       string | null  (key into "pdfs" store; null until pdfStatus='done' or 'partial')
    ocrError     string | null

ObjectStore "pages" — extended
  EXISTING:  scanId, ordinal, blob, quad, capturedAt
  NEW:
    ocrText  string | null
    ocrWords OcrWord[] | null

ObjectStore "pdfs" — NEW
  keyPath: id (string, UUIDv4 — referenced from scans.pdfKey)
  fields:
    id     string
    blob   Blob   (the assembled searchable PDF)
    bytes  number (cached size)
```

**`OcrWord` shape:**

```ts
interface OcrWord {
  text: string;
  // Pixel coordinates in the source page image; pdf/build.ts converts to PDF space.
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;  // 0–100
}
```

**Migration on `openDB(2)`:** `idb`'s `upgrade` callback creates the `pdfs` store and nothing else. Existing scans/pages are not mutated; the new fields read as `undefined` and Phase 4 code treats `undefined` `pdfStatus` as legacy-pending.

**Pinned constants:**
- `OCR_LANGUAGE = 'eng'`
- `OCR_MIN_WORD_CONFIDENCE = 30`
- `PDF_PAGE_DPI = 144` (image-pixels → PDF-points conversion)
- `WORKER_RECOGNIZE_TIMEOUT_MS = 30_000` (per page; rejects + recreates worker if exceeded)

## Data Flow

### Journey 1 — New scan completes (steady state)

1. User taps **Done** on `ScannerScreen`. `scanner-session.finish(scanId)` writes `status='completed'`, `pdfStatus='pending'`, generates the thumbnail (Phase 3 behavior), and notifies `OcrQueue.enqueueAfterFinish(scanId)`.
2. App routes to `SavedScansScreen`. The new scan appears at the top with a spinner + "OCR queued".
3. `OcrQueue.processNext()`:
   - Lazy-loads `tesseract.js` + `eng.traineddata.gz` on the first call (one-time ~13 MB fetch, SW-cached afterward).
   - Sets `scan.pdfStatus = 'running'` in IndexedDB; emits `running` event.
   - For each `page` in capture order:
     - Reads `page.blob` from `pages` store.
     - `worker-client.recognize(blob)` → `{text, words}`.
     - Persists `pages.ocrText` and `pages.ocrWords` for that ordinal.
     - Emits `progress` event `{scanId, doneCount, totalCount}`. Row label becomes "OCR'ing 2/5".
   - After all pages: calls `pdf/build.buildSearchablePdf({pages})`. Row label becomes "Building PDF…".
   - Inserts the PDF Blob into `pdfs` store; sets `scan.pdfStatus = 'done'`, `scan.pdfKey`. Emits `done`.
   - Row gains a **Download PDF** button.
4. Loop to next pending scan.

### Journey 2 — App boot with pending or legacy scans

1. `App.tsx` mounts. `store.open()` resolves; `OcrQueue.start(store)` runs.
2. Queue calls `store.findPendingPdf()`, which returns scans where `status='completed' && pdfStatus !== 'done' && pdfStatus !== 'failed'`. This naturally captures:
   - Legacy Phase 3 scans (`pdfStatus === undefined`)
   - Crashed mid-OCR scans (`pdfStatus === 'running'` — reset to `'pending'` on enqueue)
   - Genuinely pending scans
3. Sorted by `updatedAt` ascending (oldest first), enqueued, processed FIFO.
4. **Resume optimization:** when running a page, if `pages.ocrText` is already non-null from a prior run, skip the recognize call. This makes mid-OCR tab-kill recovery cheap.

### Journey 3 — User deletes a scan during OCR

1. User taps trash on a row with `pdfStatus` of `'running'`, `'pending'`, or any other non-final state.
2. SavedScansScreen confirms via `window.confirm`, then calls `queue.cancel(scanId)` first, then `store.delete(scanId)`.
3. `cancel(scanId)`:
   - If `scanId` matches the *currently-processing* job: `worker.terminate()`, set a fresh worker via `worker-client.recreate()`, mark the in-flight job as cancelled so the next event from the dead worker (if any arrives racy) is ignored.
   - If queued only: remove from in-memory queue.
4. `store.delete()` cascades pages, thumbnail, **and the PDF** if any was already written.

### Journey 4 — Retry a failed scan

1. Failed row shows a "Retry OCR" button alongside `ocrError` text.
2. Tap → `queue.retry(scanId)`:
   - Resets `scan.pdfStatus = 'pending'`, clears `scan.ocrError`.
   - Clears `pages.ocrText` and `pages.ocrWords` for all pages of that scan (start fresh).
   - Enqueues.

### Journey 5 — Download PDF

1. Row with `pdfStatus === 'done'` or `'partial'` shows a Download affordance.
2. Tap → `store.getPdf(scan.pdfKey)` → `URL.createObjectURL(blob)` → invisible `<a download="scan-<ISO>.pdf" href="...">` is clicked → revoked after a short delay.
3. The OS / browser handles the saved file. iOS Safari shows the share sheet.
4. Same affordance is also available in `ScanViewerScreen`'s header.

## Error Handling & Edge Cases

| Failure | Behavior |
|---|---|
| `tesseract.js` fails to fetch (offline first time) | `pdfStatus='failed'`, `ocrError='OCR engine unavailable; check connection then Retry'`. |
| `eng.traineddata.gz` fails to fetch | Same path. |
| Per-page recognize error | Skip that page (`ocrText=''`, `ocrWords=null`). After all pages, `pdfStatus='partial'`. The PDF builds with image-only pages where OCR failed; the rest are searchable. |
| All pages fail | `pdfStatus='failed'`, `ocrError='OCR failed on every page'`. |
| `pdf-lib` assembly throws | `pdfStatus='failed'`, `ocrError=<lib message>`. Retry restarts from scratch. |
| `QuotaExceededError` during write | Match Phase 3's banner. Queue pauses (`pdfStatus='pending'` stays). User must delete a scan to resume. Queue auto-restarts on next app boot if storage was freed. |
| Worker crash (Tesseract OOM on a huge page) | `worker.onerror` fires; pending job rejects with the per-page-error path. `worker-client` recreates the worker. |
| Per-page recognize timeout (`WORKER_RECOGNIZE_TIMEOUT_MS`) | Same as worker crash. |
| Tab killed mid-OCR | Per-page results already persisted; resume from next un-OCR'd page on next app boot. |
| Multiple browser tabs | Each tab thinks it owns the queue. We don't lock. Worst case: same scan OCR'd twice (idempotent — last-write-wins on `pages.ocrText`). |
| User runs out of disk during PDF write | Same as quota path. |

### Explicitly NOT handled

- **Cross-page rotation correction.** If page 3 is upside-down, the PDF will be too. Tesseract's PSM 1 may correct via auto-orientation but we don't expose any UI for it.
- **Confidence-based reprocessing.** Words below threshold are dropped, not retried.
- **Multi-language documents.** English only.
- **PDF/A or signed PDFs.** Plain searchable PDF.
- **Inline PDF preview** (rendering inside the app). Browser/OS handles the saved file.

## Testing

### Vitest unit (`pwa/tests/`)

- **`ocr/queue.test.ts`** — Pure orchestration logic with a fake `worker-client` (controllable resolve/reject). Asserts:
  - FIFO ordering by `updatedAt`
  - Resume picks up legacy `undefined` `pdfStatus` and stuck `'running'`
  - Cancel during in-flight terminates worker, removes from queue
  - All-pages-fail → `pdfStatus='failed'`
  - Some-pages-fail → `pdfStatus='partial'` (PDF still built)
  - `QuotaExceededError` pauses queue without losing state
  - Resume optimization: pages with existing `ocrText` skip recognize
- **`pdf/build.test.ts`** — Assemble a 2-page PDF from fixture JPEGs + fake OCR words. Round-trip via `pdf-lib`'s `PDFDocument.load()`; assert page count, page dimensions match expected (image px ÷ 144 dpi × 72 pt/inch), embedded image count, and that pdf-lib's text extractor returns the OCR'd words. Real `pdf-lib`, no mocks.
- **`scans-store.test.ts`** (extend) — Per-new-field tests; v1 → v2 migration test that seeds a v1 db with the Phase 3 schema, opens at v2, and confirms (a) all Phase 3 data preserved, (b) `pdfs` store created.

### Vitest component

- **`SavedScansScreen.test.tsx`** (extend) — Pending row shows spinner; running row shows progress label that updates when the queue emits `progress`; partial row shows banner + Download; done row shows Download; failed row shows Retry; tapping Retry calls `queue.retry`; tapping trash calls `cancel` before `delete`.

### Not unit-tested (deliberate)

- **`ocr/tesseract-worker.ts`** — Wasm engine boundary; mocking is more work than it's worth. Manual smoke covers it.
- **`ocr/worker-client.ts`** — Thin postMessage wrapper. Exercised via the queue tests using a fake.

### Manual smoke (recorded in plan)

1. Capture a 3-page document → wait → row flips to **Download** within ~30 s on real phone → tap → real searchable PDF lands in Files / Photos.
2. Open the saved PDF in a reader → search for a word visible on page 2 → it highlights at the right location (text layer aligned to image).
3. Capture a scan → swipe-up close mid-OCR → reopen → it picks up where it left off; the already-OCR'd pages don't get re-processed.
4. Capture two scans back-to-back → second one shows "OCR queued" while first is running; processes after.
5. Capture a deliberately blurry page → row reaches "OCR partial — N-1/N pages searchable"; PDF still has the readable pages searchable.
6. Airplane mode before *first ever* scan → row reaches "OCR engine unavailable" with Retry. Reconnect, tap Retry → succeeds.
7. Phase 3 leftover scans (created before this build) → on first app open after Phase 4 ships, those rows pick up "OCR queued" and process through.

### No Playwright

Same reasoning as Phase 3: real wasm + IndexedDB + 13 MB asset fetch is what we need to validate, and headless Chromium gives us nothing useful for that.

## Risks

- **Tesseract performance on older iPhones.** First page on a cold worker can take 15+ s as wasm compiles. Acceptable for personal-use throughput; surfaces in the manual smoke. Fallback if completely unusable: server-side OCR (architecture supports the swap, but adds ops surface).
- **`eng.traineddata.gz` fetch failure on first ever launch.** User is stuck with `'failed'`/Retry until reconnected. Acceptable; the spec allows this.
- **PDF text-layer alignment.** `pdf-lib` positions text in PDF points; `OcrWord` positions are in image pixels. Bugs in the conversion (e.g., wrong DPI assumption) make the PDF "search" but at the wrong location. Caught by `pdf/build.test.ts` round-trip and confirmed visually in smoke #2.
- **`PDF_PAGE_DPI = 144` is an arbitrary-ish choice.** It controls only the printed/displayed physical size of the PDF, not searchability. Could revisit if a user complains about page sizes; otherwise fine.
- **iOS Safari `URL.createObjectURL` + `<a download>`** sometimes opens the PDF inline rather than triggering a save. The OS share sheet still works to save it. Documented in smoke #1 as expected behavior.

## Open Questions

These are explicitly **not** locked down in the spec; they get answered during implementation:

1. **`pdf-lib` text rendering mode** for invisible text. Either `opacity: 0` or `renderingMode: 3` (TrFillStroke = no fill, no stroke = invisible but selectable). Pick whichever produces extractable text in mainstream PDF readers (Apple Preview, Chrome's built-in, Acrobat).
2. **Tesseract worker count.** Plan calls for one. If the queue is empty and we keep the worker warm, sub-second startup on subsequent jobs; if we terminate after each job, free memory. Pick during tuning.
3. **eng.traineddata host path.** `pwa/public/ocr/eng.traineddata.gz` vs an `assets/` subdir. Trivial; pick during install.

## Phase 4 Done — Definition

- All Phase 1+2+3 unit and integration tests still pass.
- Phase 4 unit tests pass: queue, pdf-build, scans-store v2 migration, SavedScansScreen extension. (Approximately 12+ new test cases on top of Phase 3's 30 = ~42 total PWA tests.)
- `pwa/dist/` builds clean; chunk-split contains a separate `ocr-core` chunk; SW patterns match.
- `pwa/dist/ocr/eng.traineddata.gz` and `pwa/dist/ocr/<tesseract.js entry>` are present and same-origin so the SW caches them.
- Phase 1 + 2 + 3 manual smokes still work.
- Phase 4 manual smoke succeeds end-to-end on real phone (the 7 cases above).
- No new server endpoints. No edits to `server/` source.
- `phase-4-complete` tag pushed to origin.

---

## Smoke Results (filled in during the manual smoke task)

_Date:_
_Test device:_
_Notes:_
