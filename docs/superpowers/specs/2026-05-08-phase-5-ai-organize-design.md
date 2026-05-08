# Phase 5 — AI Vision Organize Design Spec (v2)

**Date:** 2026-05-08
**Status:** v2 — supersedes earlier vision (see Revision History)
**Parent spec:** [`2026-04-27-doc-scanner-design.md`](2026-04-27-doc-scanner-design.md)
**Branch:** `phase-5-ai-organize` (off `main`)

## Revision History

| Rev | Date | Change |
|---|---|---|
| v1 | 2026-05-08 | Initial design — client-side Tesseract.js for OCR, send `{thumbnail, ocrText}` to Haiku for classification only. |
| **v2** | 2026-05-08 | **Pivot to Haiku vision for OCR + classification in one server call.** Client-side Tesseract retired after iOS Safari blob-URL incompatibilities surfaced during Phase 4 smoke. Phase 4's OCR pipeline (worker, queue, traineddata) is abandoned; PDF assembly + scans-store schema are retained. |

The v1 design assumed Phase 4's client-side Tesseract.js would deliver searchable PDFs locally and Phase 5 would only add a classify+upload layer on top. The smoke surfaced fundamental compatibility issues between tesseract.js v7's blob-URL inner worker and iOS Safari's strict same-origin checks (`NotFoundError` from cross-origin Cache/IDB operations). Rather than spend more cycles on workarounds, v2 collapses OCR and classification into a single Anthropic Haiku 4.5 vision call — Haiku reads the page images, returns the text-with-bounding-boxes for the searchable PDF layer, and returns the filename + folder suggestion. One subsystem instead of two; better OCR quality on weird documents; same trust boundary (server already touches Anthropic).

## Goal

Bridge the gap between "phone has captured page images" and "Proton Drive has a well-named, well-filed *searchable* PDF." Send page images to the server; Haiku 4.5 returns OCR text with word boxes plus a filename + folder suggestion in one tool-use response; PWA assembles the searchable PDF locally; user confirms; PWA uploads to Drive. Offline-resilient via outbox + background sync.

## Non-Goals

- **Client-side OCR** — retired in v2. The PWA never runs Tesseract or any local OCR engine.
- **Uploaded existing PDFs (Journey C)** — deferred. The new server-side OCR pipeline is image-input; Phase 6 PDF import will rasterise on PWA via `pdfjs-dist`, feed same `/api/classify` endpoint, no server change.
- **Re-classifying or re-filing existing Drive content** — separate workflow.
- **Cost dashboard / admin UI** — `sqlite3 /data/app.db` queries are sufficient.
- **Multi-language OCR** — Haiku handles many languages natively, but we only test English. Anthropic charges the same per token regardless of language.
- **Vector embeddings for history retrieval** — FTS5 with porter stemming is sufficient at our volume.
- **Auto-skip-confirmation** — parent spec mandates "always confirm." Confidence is shown only.
- **History pruning** — revisit at 10k rows.

## Constraints & Context

- **Anthropic Claude Haiku 4.5** vision input limits: 5 MB per image (after base64), ≤1568 long-edge recommended, max 100 images per request. ~$1/M input tokens, ~$5/M output tokens. A 1024×1024 page image = ~1400 vision tokens. Typical 5-page document = ~7000 input tokens for images + ~1000 for instructions/folders = ~8000 input + 500 output ≈ **$0.011 per scan**. At 5 scans/week ≈ **$3/year**.
- **Trust boundary** (parent spec line 73): the phone owns raw page images during capture; once the user wants to save, the server sees the page images for OCR + classification. The server already owns the Anthropic key + Proton session, so Anthropic seeing page content does not change the boundary materially. Documented in user-facing privacy notice ("Pages are sent to Anthropic for AI processing during save").
- **Proton Drive SDK** (`server/src/drive/client.ts`): currently `uploadFile(name, bytes, mimeType)` uploads only to MyFilesRootFolder. Phase 5 extends it to accept `parentFolderUid` and return resolved `finalName` after collision retry.
- **Folder enumeration** (`/api/drive/folders`): does not exist; built in Slice 0 of this phase.
- **Volume**: light, batched (few documents/week). All design decisions assume single-user.
- **Deployment**: Docker on `node:24.15.0-alpine3.23`. Sharp's prebuilt Alpine binaries ship without extra apk packages.

## Decisions Made During Brainstorming

| Question | Decision | Why |
|---|---|---|
| OCR engine | **Anthropic Claude Haiku 4.5 vision** (not Tesseract.js, not server-side Tesseract) | One subsystem instead of two; better quality on complex layouts; eliminates ~13 MB of WASM payload; eliminates iOS Safari Worker compatibility class entirely. |
| OCR + classify split | **Single Haiku call returns both** in one tool-use response | Halves Anthropic round-trips; instructions and folder list cache once per call. |
| PDF assembly location | **PWA-side** using existing `pdf/build.ts` (Phase 4 retain) | Server stays thin; phone has the page images already in IndexedDB; pdf-lib already vetted in Phase 4. |
| Image normalisation | Server-side `sharp` resize-on-the-fly to 1024 long-edge | Uniform input to Haiku regardless of phone capture resolution; protects against unbounded uploads. |
| Image transport | Multipart, all pages in one request to `/api/classify` | Simpler than streaming; aligns with Haiku's multi-image API. |
| Tool-use schema | Forced single tool, returns per-page OCR + suggestion | Schema-enforced JSON; no parsing fragility. |
| `drive/client.uploadFile` extension | Add `parentFolderUid` opt; return resolved `finalName`; wrapper-side collision retry (`(2)`/`(3)`/`(4)` max 3) | Phase 2's wrapper hard-codes root upload. SDK collision shape verified empirically in slice 2's first task. |
| Service Worker | Extend `pwa/public/sw.js` with sync + message listeners; new `pwa/src/outbox-drain.ts` (TypeScript, testable) | Hand-written SW pattern matches Phase 4's choice; logic complexity in TS module. |
| State machine | Three orthogonal axes: `ScanStatus` × `PdfStatus` × `UploadStatus` (each modelled separately) | Phase 4 already split scan/pdf; Phase 5 adds upload axis. |
| Confidence gating | Show small badge when low (<0.6); never auto-skip confirmation | Parent spec rule. |
| Telemetry persistence | Logs only (latency, tokens, success/fail) | YAGNI for dashboard. |
| Suggestion field naming | PWA's `Scan.suggestion` mirrors server's `ClassifyResult` shape exactly | No "is this pre- or post-edit?" ambiguity. |
| FTS5 history retrieval | Top-3 by BM25 over `tokenize='porter unicode61'` external content table | Sufficient quality at single-user volume. |
| Phase 4 OCR retirement | Delete `pwa/src/ocr/`, `pwa/public/ocr/eng.traineddata.gz`, `pwa/scripts/copy-tesseract-assets.mjs`, SW `/ocr/*` cache pattern. **Retain** `pwa/src/pdf/build.ts`, `pwa/src/scanner/scans-store.ts` v2 schema, `ScanViewerScreen` download button, scan capture/edge detection. | Reduces PWA bundle ~13 MB; removes brittle iOS Safari path; keeps reusable artifacts. |

## Architecture Overview

### Capture flow (PWA-only, mostly retained from Phase 4)

User captures pages via existing camera + jscanify pipeline. Each accepted page produces a perspective-corrected JPEG/PNG blob, stored in `scans-store` `pages` blob store. Scan status lifecycle is unchanged from Phase 4: `in_progress` → (user finalizes) → `completed`.

The `pdfStatus` axis from Phase 4 is **removed** — it tracked Tesseract's progress, which no longer happens locally. PDF assembly is now triggered as a side-effect of the classify response (always succeeds or fails; no intermediate state).

### Slice breakdown

| Slice | Server | PWA | Shippable end state |
|---|---|---|---|
| **0. Folder Cache** | `drive/folder-cache.ts`, `GET /api/drive/folders` (with `?refresh=1`) | `api.getFolders()` | Folder tree available to slice 1. |
| **1. Vision Classify** | `classify/image.ts` (multi-image normalisation), `classify/haiku.ts` (vision call → per-page OCR + suggestion), `POST /api/classify` (multipart: N page images → JSON with suggestion + per-page OCR) | `pwa/api.ts::classify(pageBlobs)`, scan capture flow triggers classify when user taps "Process", `ConfirmCard` displays suggestion | User scans → AI returns suggestion + OCR → ConfirmCard shows; PDF not yet built. |
| **2. PDF + Upload** | `drive/client.ts` extension (parentFolderUid + collision retry + finalName), `POST /api/upload` (multipart: PDF + name + folderLinkId + ocrText) | After classify response, PWA assembles searchable PDF via existing `pdf/build.ts` using Haiku-returned per-page OCR. Save button uploads. | First end-to-end: scan → AI → PDF → Drive. Tag-worthy milestone. |
| **3. FTS5 Few-Shot History** | Migration `003_classification_history.sql`, `classify/history.ts`, route hooks. Haiku prompt gains `<examples>` block. | No PWA changes. | After 3+ saves, Haiku sees prior examples. |
| **4. Outbox + Background Sync** | None (server idempotent enough) | Extend scans-store with `uploadStatus` `'needs_attention'` (other states added in slice 1). New `pwa/src/outbox-drain.ts` + `pwa/src/sw-register.ts`; extend `pwa/public/sw.js` with `sync` + `message` listeners. | Airplane scan → resume online → automatic process+upload. Tag `phase-5-complete`. |

### Capture-and-process timing

A subtle change from v1: in v1, OCR ran continuously in the background (outboxed via Phase 4's `OcrQueue`); the user could finalize a scan immediately and OCR caught up later. In v2, OCR happens as part of the classify call — there is no "OCR catching up" state. The user taps "Process" (or it auto-fires when scan is finalized) → request goes to server → ~5-10s round-trip → ConfirmCard appears.

Trade-off: simpler state machine, but a ~10s blocking-feel delay between "I scanned my last page" and "I see the suggestion." Acceptable for the volume and use case (few/week, on-demand).

## Components — Server

### `server/src/drive/client.ts` extension (modified, slice 2)

```ts
// Phase 2 → Phase 5
interface UploadOptions { parentFolderUid?: string; }
async uploadFile(
  name: string,
  bytes: Uint8Array,
  mimeType: string,
  opts?: UploadOptions,
): Promise<UploadResult>;
// UploadResult: { nodeUid, driveUrl, finalName }
```

Wrapper-side collision retry: try `name`, then `name + " (2)"`, `" (3)"`, `" (4)"`. After 4 collisions, throw `UploadCollisionExhausted`. Slice 2's first task is an empirical SDK behaviour test (upload same name twice via existing `POST /api/drive/test-upload`) to verify the catch shape; the retry logic is implementation-agnostic but the catch is SDK-specific.

### `server/src/drive/folder-cache.ts` (new, slice 0)

```ts
export class FolderCache {
  constructor(sdk: ProtonDriveClient);
  getTree(): { linkId: string; path: string }[];
  refresh(): Promise<void>;
}
```

Walks `getMyFilesRootFolder()` → `iterateFolderChildren()` recursively, keeps only folders (not files), flattens paths depth-first. Per-session lifetime (attached to `liveSession` since folder UIDs differ per Proton account).

### `server/src/classify/image.ts` (new, slice 1)

```ts
export class UndecodableImageError extends Error {}
export async function normaliseForClassify(input: Uint8Array): Promise<Uint8Array>;
//   - Sharp-based resize to ≤ 1024 long-edge (vision-friendly).
//   - Re-encodes to JPEG q=85 (smaller payload than PNG for photos; OCR
//     quality unchanged at this resolution since text is a tiny fraction
//     of the byte budget). Output ≤ 1.5 MB.
//   - Pass-through only if input already ≤ 1024 long-edge AND ≤ 1.5 MB
//     AND format is JPEG/PNG.
//   - Throws UndecodableImageError on bad input.
```

Note: 1024 long-edge (not the 512 from v1) — Haiku reads small text better at higher resolution, and we're now relying on it for actual OCR not just a thumbnail glance.

### `server/src/classify/haiku.ts` (new, slice 1)

Wraps `@anthropic-ai/sdk` with forced multi-image tool-use:

```ts
export interface ClassifyInput {
  pages: Uint8Array[];   // already normalised by image.ts
  folders: { linkId: string; path: string }[];
  examples?: PastExample[];
}
export interface ClassifyResult {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
  pageOcr: PageOcr[];          // length === input.pages.length
}
export interface PageOcr {
  text: string;                // full extracted text, reading order
  words: { text: string; x: number; y: number; w: number; h: number }[];
  // Bounding boxes are normalised (0-1) since Haiku doesn't return real
  // pixel coordinates; pdf/build.ts maps them to PDF page coords.
}
export class ImageTooLargeError extends Error {}
export async function classify(input: ClassifyInput): Promise<ClassifyResult | null>;
```

Tool-use schema (forced via `tool_choice: { type: 'tool', name: 'extract_and_suggest' }`):

```ts
{
  name: 'extract_and_suggest',
  description: 'Extract OCR text from each page and propose a filename and destination folder.',
  input_schema: {
    type: 'object',
    required: ['suggestedName', 'suggestedFolderLinkId', 'confidence', 'rationale', 'pageOcr'],
    properties: {
      suggestedName: { type: 'string', description: 'Filename without extension. ASCII, no slashes, ≤80 chars.' },
      suggestedFolderLinkId: { type: 'string', description: 'Must be one of the linkIds from the provided folders list.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string', maxLength: 200 },
      pageOcr: {
        type: 'array',
        description: 'Per-page OCR results, in the same order as the input page images.',
        items: {
          type: 'object',
          required: ['text', 'words'],
          properties: {
            text: { type: 'string', description: 'Full extracted text in natural reading order.' },
            words: {
              type: 'array',
              items: {
                type: 'object',
                required: ['text', 'x', 'y', 'w', 'h'],
                properties: {
                  text: { type: 'string' },
                  x: { type: 'number', minimum: 0, maximum: 1, description: 'Normalised left.' },
                  y: { type: 'number', minimum: 0, maximum: 1, description: 'Normalised top.' },
                  w: { type: 'number', minimum: 0, maximum: 1 },
                  h: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
}
```

Prompt assembly: instructions + folder list (with `cache_control: ephemeral`) → image content blocks for each page → optional `<examples>` block from FTS5 (slice 3).

Post-response sanitisation:
- `suggestedName` against `/^[a-zA-Z0-9 .,'_-]{1,80}$/`; sanitise (strip illegal, truncate, fallback `'Document'`).
- `suggestedFolderLinkId` validated against `folders` list; drop suggestion (empty string) on hallucination.
- `pageOcr.length !== pages.length` → invalid response → return null.
- Word coordinates clamped to `[0, 1]`.

Tests (`classify/haiku.test.ts`, Anthropic SDK mocked):
1. Single-page happy path: returns `ClassifyResult` with `pageOcr.length === 1`.
2. Multi-page happy path: 3 pages in, 3 OCR results out.
3. Hallucinated folder linkId → result with empty `suggestedFolderLinkId`.
4. Page count mismatch (server returns 2 OCR for 3 pages) → returns null.
5. Anthropic SDK throws → returns null.
6. Image >3 MB raw → throws `ImageTooLargeError`.

### `server/src/classify/history.ts` (new, slice 3)

Same as v1 design. FTS5 retrieval over `(ocr_snippet, final_name, folder_path)` with porter+unicode61 tokenizer, top-3 by rank, OR-joined explicit-token query.

`recordSave({ ocrText, finalName, folderLinkId, folderPath, driveNodeUid })` — `ocrText` is the *concatenated* per-page text from Haiku (separated by `\n\n`), truncated to first 500 chars before insert.

### Migration `003_classification_history.sql` (new, slice 3)

Same as v1.

### `server/src/http/routes-classify.ts` (new, slice 1)

`POST /api/classify`. Multipart with N parts named `page_0`, `page_1`, … (PNG/JPEG blobs).

Hono route:
1. `bodyLimit({ maxSize: 20 * 1024 * 1024 })` — 20 MB total. Realistic upper bound (10 pages × ~1.5 MB each). 413 on overflow.
2. Parse multipart; extract page blobs in `page_N` order. Reject 400 if zero pages or non-contiguous indices.
3. Per-page: `await image.normaliseForClassify(bytes)`. Aggregate failures: if any page is undecodable → 422.
4. Pull folder tree from `liveSession.folderCache.getTree()`.
5. (Slice 3+) `examples = history.findSimilar(joinedOcrPlaceholderText, 3)` — actually, on first call we don't yet have OCR text, so initial slice-3 implementation uses examples based on a tiny *server-side* image hash or skips examples for the first save and keys subsequent ones off the OCR text returned by *that* call. Simpler: the FTS5 query for "what do these pages look like" runs after Haiku returns, but that defeats the purpose (we want examples *in* the prompt). Resolution: skip `findSimilar` keying entirely; instead, retrieve the **most-recent 3 saves regardless of similarity** as the examples block. That's a cheaper-but-effective baseline, and the cost of "less similar examples" is offset by them being recent (taxonomy drift is mild). Document in code comment.
6. Call `classify({ pages: normalisedBlobs, folders, examples })`.
7. Return `{ suggestion: ClassifyResult | null }`.

### `server/src/http/routes-upload.ts` (new, slice 2)

Same as v1 design. Multipart: `pdf` + `name` + `folderLinkId` + `ocrText`. Calls extended `drive/client.uploadFile`; records history on success; returns `{ driveNodeUid, driveWebUrl, finalName }` or 409/401/413 as appropriate.

## Components — PWA

### `pwa/src/api.ts` additions (slices 0, 1, 2)

```ts
export async function getFolders(refresh = false): Promise<{ folders: { linkId: string; path: string }[] }>;
export async function classify(pages: Blob[]): Promise<{ suggestion: ClassifyResult | null }>;
export async function upload(pdf: Blob, name: string, folderLinkId: string, ocrText: string): Promise<UploadResponse>;
```

Each performs pre-flight size checks: per-page ≤ 2 MB (looser than v1 to allow bigger captures), total combined ≤ 18 MB. Throws before fetch on violation.

### `pwa/src/scanner/scans-store.ts` extensions (slices 1, 2, 4)

Add `uploadStatus` axis (introduced in slice 1, expanded in slice 4):

```ts
export type UploadStatus = 'idle' | 'pending_classify' | 'awaiting_confirm'
                        | 'pending_upload' | 'done' | 'needs_attention';

interface Scan {
  // ... existing fields ...
  uploadStatus: UploadStatus;
  uploadError: string | null;
  suggestion?: { suggestedName: string; suggestedFolderLinkId: string; confidence: number; rationale: string };
  pageOcr?: PageOcr[];     // returned by classify; consumed by pdf/build
  pdfBlob?: Blob;          // assembled client-side after classify
  finalName?: string;
  finalFolderLinkId?: string;
  driveNodeUid?: string;
  driveWebUrl?: string;
}
```

Helper methods: `getPageBlobs(scanId)`, `setUploadStatus(scanId, next, patch?)`, `findPending()`. Transition map enforced.

### `pwa/src/ui/ConfirmCard.tsx` (new, slice 1)

Same as v1 design — filename input, folder picker, rationale + confidence, Save / Dismiss, Refresh-folders link. Receives `suggestion` from scans-store, `folders` from `api.getFolders()`.

### `pwa/src/pdf/build.ts` (retained from Phase 4, slice 2)

The Phase 4 module already accepts `pages: { blob, ocrText, ocrWords }[]` and produces a searchable PDF. **No code change required** — we just call it with Haiku's `pageOcr` data instead of Tesseract's output. Word coordinates from Haiku are normalised (0-1); `pdf/build.ts` already maps to PDF page units, so the existing math is correct.

If `pdf/build.ts`'s current expectation is pixel coordinates from Tesseract, we adapt the input mapping at the call site (multiply normalised coords by the page image's pixel dimensions, or change build.ts to accept normalised coords directly — TBD during slice 2 task 1).

### `pwa/src/outbox-drain.ts` + `pwa/src/sw-register.ts` (new, slice 4)

Same as v1 design. `outbox-drain.ts` reads scans where `uploadStatus IN ('pending_classify', 'pending_upload')`, calls `/api/classify` or `/api/upload`, advances state. Retry counter; ≥3 failures in 24h → `'needs_attention'`. `sw-register.ts` registers `outbox-drain` background sync + visibility-change post-message.

### `pwa/public/sw.js` extensions (slice 4)

Add `sync` + `message` event listeners. Bump CACHE_NAME. **Remove** the `/ocr/` and `/assets/ocr-core-*.js` cache patterns from Phase 4 (no longer relevant). Keep `/scanner/`, `/opencv/`, `/assets/scanner-core-*.js`.

## Data Flow

### Slice 1 (online, no upload yet)

```
Phone:
  scan finalized  →  scans-store.setUploadStatus('pending_classify')
                  →  read all page blobs
                  →  POST /api/classify (multipart: page_0, page_1, ...)
Server:
  bodyLimit 20 MB  →  parse multipart  →  image.normaliseForClassify (per page)
                  →  liveSession.folderCache.getTree
                  →  classify/haiku.classify  →  return { suggestion } JSON
Phone:
  setUploadStatus('awaiting_confirm', { suggestion, pageOcr })
  ConfirmCard renders
```

### Slice 2 (PDF assembly + upload)

```
Phone (after classify response):
  pdf/build.assemble(pages, pageOcr)  →  pdfBlob stored in scans-store
  ConfirmCard's Save button enabled
Phone (Save tapped):
  setUploadStatus('pending_upload', { finalName, finalFolderLinkId })
  POST /api/upload (multipart: pdfBlob + name + folderLinkId + concatenatedOcrText)
Server:
  bodyLimit 50 MB  →  drive/client.uploadFile (with collision retry)
                  →  audit_log insert  →  history.recordSave (slice 3+)
                  →  return { driveNodeUid, driveWebUrl, finalName }
Phone:
  setUploadStatus('done', { driveNodeUid, driveWebUrl, finalName })
  Toast: "Saved to Drive — Open"
```

### Slice 4 (background sync)

`outbox-drain.ts` runs on `sync` event or visibility-change postMessage. Drains pending classify/upload rows.

## Error Handling & Edge Cases

| Failure | Slice | Behaviour |
|---|---|---|
| Anthropic 5xx / timeout (15 s; longer than v1's 10 s because vision + multi-image is slower) | 1 | `classify` returns `null`; route returns `{ suggestion: null }`; PWA shows empty ConfirmCard. **No PDF assembled** — Save button disabled until user types a name (then PDF is built without OCR text layer; warning displayed). |
| Anthropic returns folder linkId not in cache | 1 | Drop folder suggestion; PWA picker un-pre-selected. |
| `pageOcr.length !== pages.length` | 1 | Treated as classify failure (returns null). |
| Image bytes undecodable (any page) | 1 | 422; PWA shows "couldn't process some pages, retry". |
| Total multipart > 20 MB on `/api/classify` | 1 | 413; PWA suggests reducing pages or retrying. |
| Body > 50 MB on `/api/upload` | 2 | 413. |
| Drive 5xx | 2 | SDK retries internally; on second failure → 502; PWA marks `needs_attention`. |
| Drive token expired during upload | 2 | Server tries `refresh()` once; on failure → 401 `reauth_required: true`. |
| Drive name collision | 2 | Wrapper retries with suffix; on `UploadCollisionExhausted` → 409 `collision_exhausted: true`. |
| FTS5 history error | 3 | Caught; classify proceeds without examples. |
| Background sync auth lost | 4 | Affected scans → `needs_attention`; banner. |
| iOS Safari no Background Sync | 4 | Visibility-change drain + Retry-all button. |
| User edits filename empty / invalid | 1/2 | Save disabled until valid. |

## Testing

### Server (vitest, all external boundaries mocked)

- `drive/folder-cache.test.ts` — 5 tests (slice 0)
- `drive/client.test.ts` additions — 5 tests (uploadFile extension + collision)
- `classify/image.test.ts` — 4 tests (single-page paths, JPEG transcode, undecodable, perf)
- `classify/haiku.test.ts` — 6 tests (multi-image happy paths, hallucination, page-count mismatch, error paths)
- `classify/history.test.ts` — 5 tests
- `routes-classify.test.ts` — 5 tests (multi-page multipart, missing pages, 413, 422, classify null → 200)
- `routes-upload.test.ts` — 6 tests
- `routes-drive.test.ts` additions — 3 tests (folders endpoint)

**Total new server tests: 39.** Anthropic + Drive SDK mocked at module boundary.

### PWA (vitest)

- `pwa/api.test.ts` additions — 5 tests
- `pwa/scanner/scans-store.test.ts` additions — 7 tests
- `pwa/ui/ConfirmCard.test.tsx` — 6 tests
- `pwa/outbox-drain.test.ts` — 5 tests

**Total new PWA tests: 23.**

### Manual smoke (combined Phase 4 retained + Phase 5) — gates `phase-5-complete`

1. End-to-end: scan multi-page → process → ConfirmCard → save → verify in Drive web app, search OCR'd text inside PDF.
2. Airplane mode: scan, close PWA, reopen online → background drain auto-processes.
3. Anthropic timeout (block via local DNS) → empty ConfirmCard → manual fill → save without OCR layer (warning shown).
4. Suggestion folder picker overrides → upload to chosen folder.
5. After 5+ saves, observe `<examples>` block in server logs on 6th classify.
6. Force `needs_attention` (kill server mid-upload) → "Retry all" recovers.
7. Phase 4 retained cases: scan capture, edge detection, resume-after-tab-kill.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Haiku OCR quality worse than Tesseract on some document classes | Low–Medium | Empirically tested in slice 1 with real documents from your inventory; if poor, evaluate Sonnet 4.6 as a fallback (~5x cost but still cheap at single-user volume). |
| Haiku word-bounding-box accuracy insufficient for searchable PDF text layer | Medium | Words placed via word coords need only approximate alignment for text-search to work (PDF readers fuzzy-match). If alignment is bad, fall back to a single page-spanning text block. |
| Anthropic API rate limits at multi-page inputs | Low | Single-user volume far below Tier-1 limits. |
| `drive/client.ts` extension regresses Phase 2 callers | Low | Default `parentFolderUid` to root folder when omitted; Phase 2 tests still pass. |
| Proton SDK collision-error shape unknown | Medium | Empirical test in slice 2's first task. |
| Upload payload size for high-resolution captures | Medium | `image.ts` resize to 1024 long-edge caps it; `bodyLimit` 20 MB is the backstop. |
| iOS Safari Background Sync flaky | Medium | Visibility-change fallback + manual Retry-all button. |
| Cost runaway from a stuck retry loop | Low | No exponential retries; failed classify → user fills manually. |

## Open Questions

- **Confidence-badge threshold** at 0.6: ship at this and revisit after 10 saves.
- **History examples retrieval strategy in slice 3**: most-recent 3 saves vs. FTS5-similarity. Lean toward most-recent for simplicity in this phase; revisit if quality plateaus.
- **Page word-box rendering in PDF**: word-level boxes vs. line-level vs. page-spanning text block. Empirically test in slice 2 task 1.
- **Retired client-side OCR — fully delete or stub?** Recommend full delete: removes 13 MB of vendored assets, clears bundle, simpler mental model. Phase 4 commits remain in git history for the curious.

## Implementation Plan Hand-off

After this v2 spec is approved, the existing implementation plan (`docs/superpowers/plans/2026-05-08-phase-5-ai-organize.md`) is rewritten to match. Key plan changes:
- Remove all Tesseract.js dependencies + setup tasks.
- Add a "Phase 4 OCR retirement" pre-task: delete `pwa/src/ocr/`, `pwa/public/ocr/eng.traineddata.gz`, vendored tesseract assets, copy script, SW `/ocr/*` cache patterns.
- Slice 1's `classify/haiku.ts` is the larger task (multi-image vision + structured per-page output).
- Slice 2 retains existing `pdf/build.ts` and adds a small adapter for normalised word coordinates.
- All other slices and the test discipline are unchanged in spirit.
