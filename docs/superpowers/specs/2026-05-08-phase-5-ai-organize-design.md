# Phase 5 — AI Upload/Organize Design Spec

**Date:** 2026-05-08
**Status:** Draft → review pending
**Parent spec:** [`2026-04-27-doc-scanner-design.md`](2026-04-27-doc-scanner-design.md)
**Predecessor phase:** Phase 4 (OCR + searchable PDF) — merged from `phase-4-ocr-pdf` after a golden-path smoke; full smoke deferred and combined with Phase 5's smoke before `phase-5-complete`.
**Branch:** `phase-5-ai-organize` (off `main`)

## Goal

Bridge the gap between "phone has a finished searchable PDF" (Phase 4 output) and "Proton Drive has a well-named, well-filed PDF." Use Claude Haiku 4.5 to suggest a filename and destination folder from the OCR text and a thumbnail; the user always confirms before upload; the pipeline is offline-resilient via an outbox + background sync.

This phase realises the components designed in the parent spec (`classify/haiku.ts`, `classify/history.ts`, `/api/classify`, `/api/upload`, the confirmation card, outbox states `pending_classify` / `pending_upload` / `needs_attention`) and adds defensive infrastructure not specified in the parent: server-side image normalisation, layered size guards, and a vertical-slice build order.

## Non-Goals

- **Uploaded existing PDFs (Journey C from the parent spec).** Phase 4 explicitly deferred this; Phase 5 keeps the same boundary. The classify pipeline is designed source-agnostic so a future Phase 6 can plug in PDF→image rasterisation on the PWA without changing server modules.
- **Re-classifying / re-filing existing Drive content.** Different workflow (re-organiser, not uploader). Future phase if desired.
- **Cost dashboard or admin UI.** Read SQLite directly when curious; structured logs surface latency and token counts.
- **Multi-language classification.** English-only for now, matches Phase 4's English-only OCR.
- **Vector embeddings for history retrieval.** FTS5 with porter stemming is sufficient at single-user volume.
- **Auto-skip-confirmation for high-confidence cases.** Parent spec line 45 mandates "always confirm filename + folder." Confidence is shown but does not gate behaviour.
- **History pruning / archival.** A document/week is ~50 rows/year. Revisit at 10k rows (~200 years at current volume).

## Constraints & Context

- **Anthropic Claude Haiku 4.5** (model id pinned in code): vision-capable, 5 MB max image, ≤1568 long-edge recommended for cost. ~$1/M input, ~$5/M output. Server-held API key (`ANTHROPIC_API_KEY`, already wired in `server/src/config.ts`).
- **Trust boundary** (parent spec line 73): the phone owns raw page images; the server owns the long-lived Proton session and the Anthropic API key. Phase 5 preserves this — only the 512px thumbnail and OCR text leave the phone for classification; the full PDF stays on the phone until upload.
- **Proton Drive SDK boundary** (`server/src/drive/client.ts`): currently exposes `uploadFile(name, bytes, mimeType)` from Phase 2 — **uploads only to MyFilesRootFolder, no parent param**. Phase 5 must extend the client to accept a destination folder uid and to surface the resolved final name. See "Server Component — `drive/client.ts` extension" below for the contract change.
- **Volume**: light, batched (few documents/week). All design decisions assume single-user operation.
- **Deployment**: Docker on `node:24.15.0-alpine3.23`. Sharp's prebuilt Alpine binaries are available for `linux-musl-x64` and `linux-musl-arm64`; no extra apk packages required.
- **Atomic commits preferred** (per author preference): each slice produces 1–3 commits that are independently meaningful in `git log`.

## Decisions Made During Brainstorming

| Question | Decision | Why |
|---|---|---|
| Build order | Vertical slices (1 classify-online → 2 upload → 3 FTS5 history → 4 outbox+sync) | Each slice is independently testable and demoable; matches atomic-commits style; surfaces integration issues early. |
| AI structured output | Anthropic tool-use with forced single tool (`tool_choice: { type: "tool", name: "suggest_filing" }`) | Eliminates JSON-extraction failure modes (markdown fences, preambles, truncation). Schema-enforced. |
| Image size enforcement | Layered: PWA best-effort → route bodyLimit 4 MB → server-side resize-on-the-fly via sharp → Anthropic guard | Defence in depth; isolates each layer in tests; survives future ingestion paths (CLI, batch import, Phase 6 PDF render) that bypass PWA. |
| Image library | `sharp` | Industry-standard, libvips-backed, prebuilt Alpine binaries, single responsibility. |
| Phase 6 architecture (locked in) | PWA renders uploaded PDFs via `pdfjs-dist` → produces PNG → same `classify/image.ts` server module. Server never decodes PDFs for classification. | Keeps trust boundary intact; smaller server image; consistent thick-PWA / thin-server pattern. |
| History retrieval | SQLite FTS5 with `tokenize='porter unicode61'`, external content table, top-3 by BM25 | Sufficient quality at our volume; zero new dependencies; debuggable from `sqlite3` CLI. |
| FTS5 query construction | Manual OR over top ~20 distinctive content tokens, each quoted | Avoids implicit-AND too-strict default; safe against FTS5 reserved-word collisions in OCR text. |
| State machine | Three orthogonal axes: `ScanStatus` × `PdfStatus` × `UploadStatus` | Avoids N×M state explosion; each axis maps to its subsystem; future phases add axes without remodelling. |
| Confidence gating | Show as small badge when low; never auto-skip confirmation | Matches parent spec's "always confirm" rule; preserves user trust. |
| Telemetry persistence | Logs only (latency, tokens, success/fail) | YAGNI for dashboard; sqlite3 + grep is sufficient diagnosis. |
| `drive/client.uploadFile` extension | Add `parentFolderUid: string` parameter; return resolved `finalName` alongside `nodeUid` and `driveUrl` | Phase 2's wrapper hard-codes root upload — Phase 5 needs folder targeting. Returning the resolved name lets the route surface collision-suffixed names back to the PWA. |
| Name collision strategy | Wrapper-side: catch SDK conflict error, retry with `" (2)"`, `" (3)"`, `" (4)"` suffixes (max 3 retries) | SDK collision behaviour is unverified. Wrapping the retry loop guarantees deterministic semantics regardless of SDK version. Slice 2 includes an empirical SDK-behaviour test before locking the strategy. |
| Service Worker location | Extend existing `pwa/public/sw.js` (hand-written, 41 lines) with a `sync` event handler for `outbox-drain` | Project already chose hand-written SW over a build plugin; consistent with Phase 4's `/ocr/*` caching addition (commit `ee4d419`). Drain logic lives in plain JS inside the SW. |
| PWA suggestion field naming | `Scan.suggestion` mirrors `ClassifyResult` shape: `{ suggestedName, suggestedFolderLinkId, confidence, rationale }`; `Scan.finalName` / `Scan.finalFolderLinkId` are post-edit values | Avoids ambiguity at the server↔PWA seam; rename was an explicit reviewer recommendation. |

## Architecture Overview

### Slice 1 — Classify Online

End-to-end suggestion flow with no upload yet.

- **Server**: `classify/image.ts` (sharp-based normalisation), `classify/haiku.ts` (Anthropic SDK + tool-use), `POST /api/classify` route.
- **PWA**: `pwa/ui/ConfirmCard.tsx` (filename input + folder tree picker + rationale display), `pwa/api.ts::classify()`, scanner-session calls classify after `pdfStatus = done`.
- **End state**: scan → OCR → AI suggests name + folder → user edits + confirms → toast says "would upload here" (no actual upload yet).

### Slice 2 — Upload

The first real round-trip into Drive.

- **Server**: `POST /api/upload` route — multipart (PDF + name + folder linkId) → `drive/client.uploadFile()` → write `audit_log` row → return Drive web URL.
- **PWA**: Save button on confirm card calls `/api/upload`; success toast has "Open in Drive" link.
- **End state**: Demoable milestone. Tag-worthy: scan → AI → Drive in one flow.

### Slice 3 — FTS5 Few-Shot History

Server-only quality bump. Each save trains the next suggestion.

- **Server**: New migration `003_classification_history.sql` (table + FTS5 virtual table + sync triggers). `classify/history.ts` (`recordSave`, `findSimilar`). `routes-upload.ts` calls `recordSave` on success. `routes-classify.ts` calls `findSimilar` and passes results to `classify()`.
- **PWA**: No changes.
- **End state**: After 3+ saves, the prompt shown to Haiku contains an `<examples>` block with prior filings.

### Slice 4 — Outbox + Background Sync

Offline resilience. Phase 5 complete after this.

- **PWA only**: Add `'needs_attention'` state to `uploadStatus` (other states arrive in slice 1). Extend `pwa/public/sw.js` with sync + message listeners; new `pwa/src/outbox-drain.ts` (TypeScript) holds drain logic; new `pwa/src/sw-register.ts` registers `outbox-drain` background sync and posts message on visibility change. iOS Safari fallback: drain on `visibilitychange → visible` plus a "Retry all" button on a small outbox panel.
- **End state**: Airplane-mode scan → resume online → automatic suggest+upload without user interaction. Manual smoke (combined Phase 4 + Phase 5 cases) before tagging `phase-5-complete`.

## Components — Server

### `server/src/drive/client.ts` extension (modified, slice 2)

Phase 2's wrapper currently hard-codes upload to MyFilesRootFolder. Phase 5 extends it without breaking existing callers:

```ts
// Before (Phase 2):
async uploadFile(name: string, bytes: Uint8Array, mimeType: string): Promise<UploadResult>;

// After (Phase 5):
interface UploadOptions {
  parentFolderUid?: string;   // omit → MyFilesRootFolder (back-compat for existing callers / Phase 2 test endpoint)
}
async uploadFile(
  name: string,
  bytes: Uint8Array,
  mimeType: string,
  opts?: UploadOptions,
): Promise<UploadResult>;
// UploadResult gains: finalName: string  (the resolved name after collision-suffix, if any)
```

**Collision handling** lives inside this wrapper, not the route:
1. Try upload with `name`.
2. On SDK collision error, retry with `name + " (2)"`, `" (3)"`, `" (4)"`.
3. After 4th attempt fails (3 collisions), surface a typed `UploadCollisionExhausted` error.
4. Return `UploadResult` with `finalName` set to whichever name actually succeeded.

**Empirical SDK-behaviour test** (one-time, slice 2 first task):
- Manually upload two files with the same name to a known folder via the existing `POST /api/drive/test-upload` endpoint or a small one-off harness.
- Document SDK error shape (HTTP code, error class, message) in code comments and in the wrapper's error mapping.
- This finding determines what the wrapper catches in step 2 above. The retry loop is implementation-agnostic; the catch shape is SDK-specific.

Tests (`drive/client.test.ts` additions, SDK mocked):
1. Upload with no `parentFolderUid` → uses MyFilesRootFolder (back-compat unchanged).
2. Upload with `parentFolderUid` → uses provided folder.
3. SDK throws collision on first call, succeeds on second → `finalName` ends in `" (2)"`.
4. SDK throws collision four times → `UploadCollisionExhausted`.
5. Non-collision SDK error → propagates (no retry).

### `server/src/classify/image.ts` (new, slice 1)

Pure module. Single responsibility: given arbitrary user-provided image bytes, return Anthropic-safe normalised PNG bytes.

```ts
export class UndecodableImageError extends Error {}

export async function normaliseForClassify(input: Uint8Array): Promise<Uint8Array>;
//   - Throws UndecodableImageError if sharp can't read the input.
//   - Returns a PNG, ≤ 512 long-edge, ≤ 600 KB raw.
//   - Pass-through (no re-encode) only if input is already PNG, ≤ 512 long-edge, ≤ 600 KB.
//   - Re-encodes otherwise to guarantee output invariants.
```

Tests (`classify/image.test.ts`):
1. 200×200 PNG ≤600 KB → pass-through (output identical bytes).
2. 4000×3000 JPEG → 512×384 PNG ≤600 KB.
3. Corrupt header / non-image bytes → `UndecodableImageError`.
4. Performance smoke: 4000×3000 normalises in <200 ms.

### `server/src/classify/haiku.ts` (new, slice 1)

Stateless wrapper over `@anthropic-ai/sdk`. Single function:

```ts
export interface ClassifyInput {
  ocrText: string;            // truncated to ~2000 chars before send
  thumbnailPng: Uint8Array;   // already normalised by image.ts
  folders: { linkId: string; path: string }[];
  examples?: PastExample[];   // 0–3, slice 3+
}
export interface ClassifyResult {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
}
export class ImageTooLargeError extends Error {}
export async function classify(input: ClassifyInput): Promise<ClassifyResult | null>;
//   - Returns null (not throws) on Anthropic error / timeout / invalid response,
//     so callers degrade gracefully to "empty suggestion."
//   - Throws ImageTooLargeError only as defence-in-depth if image.ts is bypassed.
```

Tool definition forced via `tool_choice: { type: "tool", name: "suggest_filing" }`:

```ts
{
  name: "suggest_filing",
  description: "Propose a filename and destination folder for the scanned document.",
  input_schema: {
    type: "object",
    required: ["suggestedName", "suggestedFolderLinkId", "confidence", "rationale"],
    properties: {
      suggestedName: { type: "string", description: "Filename without extension. ASCII, no slashes, ≤80 chars." },
      suggestedFolderLinkId: { type: "string", description: "Must be one of the linkIds from the provided folders list." },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string", maxLength: 200 },
    },
  },
}
```

Prompt assembly (single user turn, content blocks in order):
1. Text — instructions + folders formatted as `linkId: path` lines (cache-control marker).
2. Image — base64 PNG of thumbnail.
3. Text — OCR text excerpt, capped to ~2000 chars.
4. Text — `<examples>` block when `examples.length > 0` (slice 3+).

Static blocks (instructions + folders) carry `cache_control: { type: "ephemeral" }` for prompt-caching.

Post-response sanitisation:
- `suggestedName` matched against `/^[a-zA-Z0-9 .,'_-]{1,80}$/`; if violated, sanitise to nearest valid (strip illegal chars, truncate to 80, fallback to `"Document"` if empty after sanitisation).
- `suggestedFolderLinkId` checked against the `folders` list; if absent (hallucination), drop folder suggestion (return result with `suggestedFolderLinkId: ""`).

Tests (`classify/haiku.test.ts`, Anthropic SDK mocked):
1. Happy path: returns parsed `ClassifyResult`.
2. Hallucinated folder linkId → result returned with empty `suggestedFolderLinkId`.
3. Name with illegal characters → sanitised in result.
4. Anthropic SDK throws (timeout/5xx) → returns `null`.
5. Tool response missing required fields → returns `null`, raw response logged.
6. Image larger than 3 MB raw at SDK call → throws `ImageTooLargeError` before API call.

### `server/src/classify/history.ts` (new, slice 3)

```ts
export interface SavedRecord {
  ocrText: string;        // truncated to 500 chars before insert
  finalName: string;
  folderLinkId: string;
  folderPath: string;
  driveNodeUid: string;
}
export interface PastExample {
  ocrSnippet: string;
  finalName: string;
  folderPath: string;
}
export function recordSave(rec: SavedRecord): void;
export function findSimilar(ocrText: string, limit?: number): PastExample[];
```

`findSimilar` builds an OR-joined query of up to 20 distinctive content tokens (alphanumeric, ≥3 chars, stopword-filtered, sorted to prefer rarer-in-input tokens, each quoted to avoid FTS5 reserved-word collisions). Returns `[]` if no usable tokens.

Tests (`classify/history.test.ts`, in-memory SQLite with migration applied):
1. Insert 5 records, query with overlapping OCR → top 3 by BM25 rank.
2. Empty table → `[]`.
3. OCR text all stop words → `[]` (no FTS query built).
4. OCR contains FTS5 reserved words (`AND`, `NEAR`) → quoting prevents syntax errors.
5. After insert + delete, FTS index in sync.

### Migration `003_classification_history.sql` (new, slice 3)

```sql
CREATE TABLE classification_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_at        TEXT    NOT NULL,
  ocr_snippet     TEXT    NOT NULL,
  final_name      TEXT    NOT NULL,
  folder_link_id  TEXT    NOT NULL,
  folder_path     TEXT    NOT NULL,
  drive_node_uid  TEXT    NOT NULL
);

CREATE INDEX idx_classification_history_saved_at
  ON classification_history(saved_at DESC);

CREATE VIRTUAL TABLE classification_history_fts USING fts5(
  ocr_snippet, final_name, folder_path,
  content='classification_history',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER classification_history_ai AFTER INSERT ON classification_history BEGIN
  INSERT INTO classification_history_fts(rowid, ocr_snippet, final_name, folder_path)
  VALUES (new.id, new.ocr_snippet, new.final_name, new.folder_path);
END;
CREATE TRIGGER classification_history_ad AFTER DELETE ON classification_history BEGIN
  INSERT INTO classification_history_fts(classification_history_fts, rowid, ocr_snippet, final_name, folder_path)
  VALUES ('delete', old.id, old.ocr_snippet, old.final_name, old.folder_path);
END;
```

No update trigger — history rows are immutable.

### `server/src/http/routes-classify.ts` (new, slice 1)

`POST /api/classify`. Multipart with two parts: `thumbnail` (PNG) and `ocrText` (string).

Hono route:
1. `bodyLimit({ maxSize: 4 * 1024 * 1024 })` middleware (returns 413 on overflow).
2. Parse multipart; extract `thumbnail` Blob → `Uint8Array`, `ocrText` string. Reject 400 if missing.
3. Call `image.normaliseForClassify(bytes)`. Catch `UndecodableImageError` → 422.
4. Pull folder tree from `drive/folder-cache::getTree()`.
5. (Slice 3+) `examples = history.findSimilar(ocrText, 3)`.
6. Call `classify({ ocrText, thumbnailPng: normalised, folders, examples })`.
7. Return `{ suggestion: ClassifyResult | null }` JSON. Empty / failed classify is **not** an HTTP error — return `{ suggestion: null }` so PWA can show the empty confirm card.

Tests (`routes-classify.test.ts`):
1. Multipart parse happy path → JSON with suggestion.
2. 2.5 MB body → 413 from bodyLimit.
3. Missing thumbnail or ocrText → 400.
4. Classify returns null → 200 with `{ suggestion: null }` (not 500).
5. Undecodable image → 422.

### `server/src/http/routes-upload.ts` (new, slice 2)

`POST /api/upload`. Multipart: `pdf` (Blob), `name` (string), `folderLinkId` (string), `ocrText` (string, slice 3+ for history record).

Hono route:
1. Body limit 50 MB (PDFs can be larger than thumbnails).
2. Parse multipart; validate name regex; validate folderLinkId exists in folder cache.
3. Call `drive/client.uploadFile(name, pdfBytes, "application/pdf", { parentFolderUid: folderLinkId })`. Wrapper handles name collisions internally (see `drive/client.ts` extension above) and returns `finalName`.
4. On 401 from SDK: try `drive/client.refresh()` once. If refresh fails, return 401 with `reauth_required: true`.
5. On `UploadCollisionExhausted`: return 409 with `collision_exhausted: true`; PWA shows error and lets user edit name + retry.
6. (Slice 3+) `history.recordSave({ ocrText, finalName, folderLinkId, folderPath, driveNodeUid })`. History write failures are logged but **do not** fail the upload (history is best-effort).
7. Write `audit_log` row.
8. Return `{ driveNodeUid, driveWebUrl, finalName }` (finalName may differ from requested name if collision-suffixed).

Tests (`routes-upload.test.ts`, Drive client mocked at `drive/client.ts` boundary):
1. Happy path: upload → audit row → history row → response includes resolved `finalName`.
2. Wrapper returns `finalName` ending in `" (2)"` → response surfaces it; PWA can update its stored `finalName` accordingly.
3. 401 → refresh → retry → success.
4. 401 → refresh fails → response has `reauth_required: true`.
5. Body > 50 MB → 413.
6. `UploadCollisionExhausted` from wrapper → 409 with `collision_exhausted: true`.
7. History write throws → upload still returns 200 (history failure swallowed + logged).

## Components — PWA

### `pwa/ui/ConfirmCard.tsx` (new, slice 1)

Reuses styling patterns from `pwa/ui/SavedScansScreen.tsx`. Props:

```ts
interface Props {
  scanId: string;
  suggestion: ClassifyResult | null;     // null = empty defaults
  folders: FolderTreeNode[];             // from /api/folders
  onSave(finalName: string, folderLinkId: string): Promise<void>;
  onDismiss(): void;
}
```

Layout (top to bottom):
1. Filename input — pre-filled with `suggestion?.suggestedName ?? ""`. Validates against same regex as server. Save button disabled if invalid.
2. Folder picker — collapsible tree-view of cached Drive folders. Pre-expanded to suggested folder's path. User can browse to override. Small "↻ Refresh folders" link triggers `GET /api/folders` re-fetch (handles the case of folders added in Drive between PWA load and confirm — folder cache is event-sync'd every 5 minutes so without this, a freshly-created folder wouldn't appear).
3. Rationale + confidence — small italic text. Low-confidence (<0.6) shown with subtle "Low confidence" badge.
4. Save / Dismiss buttons.

Tests (`ConfirmCard.test.tsx`):
1. Render with full suggestion → fields pre-filled (`suggestedName`, `suggestedFolderLinkId`).
2. Render with `suggestion: null` → empty fields, Save disabled until name entered.
3. Name input with illegal chars → Save disabled, hint text shown.
4. Folder picker selection updates state.
5. Low-confidence (0.4) → badge visible; high-confidence (0.95) → no badge.
6. Refresh folders link → triggers folder re-fetch callback.

### `pwa/api.ts` additions (slices 1–2)

```ts
export async function classify(thumbnail: Blob, ocrText: string): Promise<ClassifyResult | null>;
export async function upload(pdf: Blob, name: string, folderLinkId: string, ocrText: string): Promise<UploadResponse>;
```

Both perform pre-flight blob size checks (1 MB for thumbnail, 50 MB for PDF) and throw before fetch on violation. Tests verify pre-flight + multipart shape.

### `pwa/scanner/scans-store.ts` extensions (slices 1, 2, 4)

**Slicing**: the `uploadStatus` field and the five states `'idle' | 'pending_classify' | 'awaiting_confirm' | 'pending_upload' | 'done'` are added in **slice 1** (so the confirm-card flow has its state machine). Slice 2 wires the `'done'` transition to a real Drive node. **Slice 4** adds the `'needs_attention'` state and the background-drain triggers.

Add to `Scan` interface:

```ts
uploadStatus: 'idle' | 'pending_classify' | 'awaiting_confirm'
            | 'pending_upload' | 'done' | 'needs_attention';
uploadError: string | null;
suggestion?: {       // server response shape, before user edits
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
};
finalName?: string;             // post-edit, post-collision-suffix; populated on save
finalFolderLinkId?: string;     // post-edit
driveNodeUid?: string;
driveWebUrl?: string;
```

**Field-naming rule**: `suggestion.*` mirrors the server's `ClassifyResult` shape verbatim — never copy a "post-edit" name into `suggestion`. The post-edit values live in `finalName` / `finalFolderLinkId` only and are written when the user taps Save. Avoids the very subtle bug of "wait, is this the suggestion or the user's edit?"

State transitions enforced by a single mutator function (validates legal transitions, throws on illegal):

```
idle → pending_classify    (when pdfStatus becomes 'done' or 'partial')
pending_classify → awaiting_confirm   (classify succeeds OR fails — both yield confirm card)
awaiting_confirm → pending_upload     (user taps Save)
awaiting_confirm → idle               (user dismisses)
pending_upload → done                 (upload succeeds; driveNodeUid set)
pending_upload → needs_attention      (upload fails after retry; auth lost; etc.)
needs_attention → pending_upload      (user taps "Retry")
```

Tests (`scans-store.test.ts` additions):
1. Each legal transition succeeds and persists.
2. Each illegal transition throws.
3. `done` records carry `driveNodeUid` and `driveWebUrl`.
4. `needs_attention` carries `uploadError`.
5. Concurrent transitions on same scanId serialised.
6. `findPending` returns `pending_classify` + `pending_upload` rows ordered by `updatedAt`.

### `pwa/public/sw.js` extensions + `pwa/src/outbox-drain.ts` (slice 4)

The existing 41-line hand-written `pwa/public/sw.js` (Phase 4's commit `ee4d419` added `/ocr/*` caching) gets two additions and one new sibling module. Splitting drain logic out of the SW file keeps it testable in TypeScript:

**`pwa/public/sw.js`** (extend in place):
- Add `sync` event listener for tag `outbox-drain`. Handler: dynamically import `/outbox-drain.js` (built artefact of `pwa/src/outbox-drain.ts`) and invoke its `drain()` function.
- Add `message` event listener for `{ type: 'request-drain' }` postMessages from the page (used by visibility-change fallback when Background Sync isn't supported, e.g., iOS Safari).

**`pwa/src/outbox-drain.ts`** (new TypeScript module, built into the SW bundle):
```ts
export async function drain(): Promise<DrainResult>;
//   Read scans-store rows where uploadStatus ∈ {'pending_classify','pending_upload'}
//   ordered by updatedAt. For each:
//     - 'pending_classify' → POST /api/classify; on success → 'awaiting_confirm';
//       on failure → 'awaiting_confirm' with empty suggestion (user fills manually).
//     - 'pending_upload'   → POST /api/upload; on success → 'done';
//       on retry-able failure → leave as 'pending_upload';
//       on hard failure (>3 attempts within 24h) → 'needs_attention'.
```

**`pwa/src/sw-register.ts`** (new, called from `main.tsx`):
- Existing `navigator.serviceWorker.register('/sw.js')` call moves here.
- Adds `registration.sync.register('outbox-drain')` after register (no-op if SyncManager unsupported).
- Adds `document.addEventListener('visibilitychange', …)` → posts `{ type: 'request-drain' }` to active SW when becoming visible (iOS Safari fallback).

**Outbox panel UI** (small, on `SavedScansScreen`): banner showing count of `pending_*` and `needs_attention` rows; "Retry all" button posts `{ type: 'request-drain' }` to SW and additionally clears retry-counter for `needs_attention` rows so they get one more chance.

Tests (`outbox-drain.test.ts`, run in vitest with mocked `fetch` + scans-store):
1. Drain with 2 `pending_classify` + 1 `pending_upload` → all called in order.
2. Classify fails → state moves to `awaiting_confirm` (not `needs_attention`; user can fill manually).
3. Upload fails 3× in 24 h → state moves to `needs_attention`.
4. Upload succeeds on 2nd attempt → state moves to `done`.
5. Empty queue → no-op, no fetch calls.

Note: `pwa/public/sw.js` itself remains plain JS and is exercised only via manual smoke (the dynamic-import seam is the only logic in sw.js — drain logic is fully covered in `outbox-drain.test.ts`).

## Data Flow

### Slice 1 (online classify only)

```
Phone:
  scan + pdfStatus=done  →  scans-store.setUploadStatus('pending_classify')
                         →  generate 512px thumbnail PNG
                         →  POST /api/classify (multipart: thumbnail + ocrText)
Server:
  bodyLimit 4 MB  →  parse multipart  →  image.normaliseForClassify
                  →  drive/folder-cache.getTree
                  →  classify/haiku.classify  →  return { suggestion } JSON
Phone:
  scans-store.setUploadStatus('awaiting_confirm', { suggestion })
  ConfirmCard renders with suggestion
```

### Slice 2 (real upload)

```
Phone (after user taps Save):
  scans-store.setUploadStatus('pending_upload', { finalName, finalFolderLinkId })
  POST /api/upload (multipart: pdf + name + folderLinkId + ocrText)
Server:
  bodyLimit 50 MB  →  drive/client.uploadFile  →  audit_log insert
                   →  return { driveNodeUid, driveWebUrl, finalName }
Phone:
  scans-store.setUploadStatus('done', { driveNodeUid, driveWebUrl, finalName })
  Toast: "Saved to Drive — Open" link
```

### Slice 3 (history makes the loop close)

`/api/upload` additionally calls `history.recordSave(...)` post-success. `/api/classify` calls `history.findSimilar(ocrText, 3)` and passes results to `classify()`. The next classify after 3+ saves contains an `<examples>` block — observable in server logs at debug level.

### Slice 4 (background drain)

Service Worker registers `outbox-drain`. Browser fires it on connectivity restoration. Drain calls `/api/classify` and `/api/upload` for queued scans, advancing states. iOS Safari fallback: same drain on PWA visibility return.

## Error Handling & Edge Cases

| Failure | Slice | Behaviour |
|---|---|---|
| Anthropic 5xx / timeout (10 s) | 1 | `classify()` returns `null`; route returns `{ suggestion: null }` 200; PWA shows empty confirm card. |
| Anthropic returns folder linkId not in cache | 1 | `classify()` returns result with `suggestedFolderLinkId: ""`; PWA shows folder picker un-pre-selected. |
| Anthropic returns name with illegal chars | 1 | `classify()` sanitises before returning; if empty after sanitisation, falls back to `"Document"`. |
| Image bytes undecodable | 1 | Route returns 422; PWA degrades to empty confirm card. |
| Multipart body > 4 MB on `/api/classify` | 1 | 413; PWA shows generic "couldn't classify, fill in manually". |
| Multipart body > 50 MB on `/api/upload` | 2 | 413; user surfaced error; scan stays `pending_upload`. |
| Drive upload 5xx | 2 | SDK retries internally (1 backoff retry); second failure → route 502 → PWA marks `needs_attention` + logs. |
| Drive token expired during upload | 2 | Route attempts `client.refresh()` once; on refresh failure returns 401 `reauth_required: true`; PWA bounces to login; scan stays `pending_upload`. |
| Drive name collision | 2 | `drive/client.ts` wrapper retries with `" (2)"` / `" (3)"` / `" (4)"` suffix (max 3); resolved `finalName` returned to PWA. After 3 collisions, route returns 409 with `collision_exhausted: true`; PWA prompts user to edit name + retry. |
| FTS5 query throws (corrupt index) | 3 | `findSimilar` catches, returns `[]`, logs; classify proceeds zero-shot. |
| `history.recordSave` disk-full / write fail | 3 | Logged; upload route still returns 200 (history is best-effort). |
| Background sync fires while reachable but auth lost | 4 | Affected scans → `needs_attention`; outbox panel banner. |
| User edits filename to empty / invalid chars | 1/2 | Save button disabled until valid (PWA-side regex match). |
| Service Worker not supported (e.g., desktop Safari) | 4 | Drain runs on PWA `visibilitychange → visible`; "Retry all" button always available. |

## Testing

### Server (vitest, all external boundaries mocked)

- `classify/image.test.ts` — 4 tests
- `classify/haiku.test.ts` — 6 tests
- `classify/history.test.ts` — 5 tests
- `routes-classify.test.ts` — 5 tests
- `routes-upload.test.ts` — 6 tests

**Total new server tests: 26.** Anthropic SDK mocked at module boundary; Drive client mocked at `drive/client.ts` boundary. No live API calls in CI.

### PWA (vitest)

- `pwa/api.test.ts` additions — 4 tests (classify pre-flight, upload pre-flight, multipart shape, error mapping)
- `pwa/scanner/scans-store.test.ts` additions — 6 tests (state transitions, findPending)
- `pwa/ui/ConfirmCard.test.tsx` — 6 tests (now includes Refresh-folders test)
- `pwa/outbox-drain.test.ts` — 5 tests

**Total new PWA tests: 21.** `pwa/public/sw.js` plain-JS additions (sync + message listeners) are validated only via manual smoke; logic complexity lives in the TS-tested `outbox-drain.ts`.

### Manual smoke (combined with deferred Phase 4 cases) — gates `phase-5-complete`

1. Capture (Phase 4) → OCR → PDF → classify → confirm → upload → verify in Drive web app.
2. Capture → enable airplane mode → close PWA → reopen online → background drain auto-uploads.
3. Capture → classify times out (simulate via blocked Anthropic endpoint) → manual fill → save → upload.
4. Capture → classify suggests folder, user picks different one → upload to chosen folder.
5. Two captures back-to-back, both `pending_upload` → both drain in order.
6. After 5+ saves, observe qualitatively that 6th classify reflects taxonomy.
7. Force `needs_attention` (e.g., simulate 5xx storm) → "Retry all" recovers.
8. Phase 4 deferred cases: blur rejection, capture/OCR/PDF/search/resume/queue/airplane/legacy iOS Safari.

### Coverage targets

- 0 high/critical npm audit findings.
- All CI green (test, typecheck, build, docker amd64+arm64).
- New code paths covered by new tests; no untested branches in error handlers.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Anthropic SDK schema drift across upgrades | Medium | Tool-use is part of stable API; pin SDK; tests catch regressions at boundary. Renovate already pins. |
| FTS5 query performance at scale | Low | Single-user volume keeps row count low; revisit at 10k rows. |
| PWA bundle bloat from ConfirmCard + folder tree component | Medium | Reuse existing UI patterns; lazy-load tree picker if needed. Vite chunks already split (Phase 4). |
| Sharp Alpine binary mismatch on cross-arch builds | Low | Already handled by sharp's prebuilt binaries; CI builds both archs. |
| Hallucinated folder linkIds become a stealth UX issue | Low | Hard-validation against folder cache; degraded to manual pick. |
| Background sync iOS Safari bugs | Medium | Visibility-change fallback + manual retry button; documented in spec. |
| Cost runaway from a stuck retry loop | Low | Single-user, few/week; no exponential retries; failed classify → manual not retry. |
| **Proton SDK collision-error shape unknown** | **Medium** | **Slice 2's first task is an empirical SDK-behaviour test (manual two-file same-name upload via existing `/api/drive/test-upload` or one-off harness). Findings documented in `drive/client.ts` and used to lock the wrapper's catch shape. Until then, the wrapper assumes "any SDK error during a freshly-renamed retry is treated as collision" — overly broad but safe.** |
| **`drive/client.ts` extension regresses Phase 2 callers** | **Low** | **Default `parentFolderUid` to MyFilesRootFolder when `opts` omitted — preserves the existing `/api/drive/test-upload` behaviour. Phase 2 tests re-run to confirm.** |

## Open Questions

- **Confidence-badge threshold** is set to `<0.6`. Is that calibrated to your data, or should we observe a few real saves and adjust? — Recommend: ship at 0.6, revisit after 10 saves.
- **History recordSave on `awaiting_confirm` dismissal**: currently we only record on successful upload. Should we also record dismissals as negative signal? — Recommend: no for Phase 5; FTS5 only handles positive examples; revisit if quality plateaus.
- **Empirical SDK collision behaviour**: must be resolved during slice 2's first task (manual harness). Findings update `drive/client.ts` collision-catch logic. If SDK auto-suffixes, our wrapper's retry loop becomes a no-op safety net; if SDK throws a typed error, the wrapper catches that exact error class.

## Implementation Plan Hand-off

After this spec is approved (review loop + user review), the next step is to invoke the `superpowers:writing-plans` skill to convert these slices into a concrete, ordered task list with file paths and acceptance criteria for each step. Branch: `phase-5-ai-organize` off `main` (after Phase 4 quick-smoke + merge).
