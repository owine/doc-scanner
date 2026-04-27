# Doc Scanner — Design Spec

**Date:** 2026-04-27
**Status:** Draft for review
**Owner:** ow@mroliverwine.com (single-user personal project)

## Goal

A self-hosted Progressive Web App that lets the owner scan paper documents with a phone camera (or upload existing files), classify them with an inexpensive AI model, and save them to Proton Drive into an existing folder structure with an AI-suggested filename.

## Non-Goals

- Multi-user support. One Proton account per deployment.
- Real-time / high-throughput document processing. Volume is a few documents per week, batched.
- Office document parsing (`.docx`, `.xlsx`). Out of scope.
- Cross-browser support beyond mobile Safari and Android Chrome.

## Constraints & Context

- **Proton Drive SDK** (`https://github.com/ProtonDriveApps/sdk`) is TypeScript, MIT-licensed, and explicitly **not yet ready for third-party production use**. Personal use is permitted. A breaking crypto-model change is forthcoming. We accept the rework risk.
- **Proton SDK ToS requirements** we must honor:
  - Use the SDK for all Proton interactions; no direct API calls.
  - Set `x-pm-appversion` header in the form `external-drive-docscanner@<semver>`.
  - Use event-based folder sync; no polling or recursive walks.
  - No Proton branding. Display credential-handling warning to the user.
  - Never store the user's Proton password.
- **SDK does not include** authentication, session management, or user-address provisioning. We must port these.
- **Anthropic Claude Haiku 4.5** for classification. Vision-capable, cheap (~$1/M in, ~$5/M out). Server-held API key.
- **Deployment target**: any Docker host (homelab or VPS). HTTPS is terminated by an upstream reverse proxy supplied by the operator (SWAG, Traefik, Cloudflare Tunnel, Caddy, etc.). The app speaks plain HTTP inside its container with `trust proxy` enabled and reads `X-Forwarded-*` headers.

## Decisions Made During Brainstorming

| Question | Decision |
|---|---|
| Hosting model | PWA + self-hosted Node server, Docker-portable |
| Folder taxonomy | Existing Proton Drive tree; AI learns from it |
| Volume | Light, batched (few/week) |
| Server stack | Node 20+ / TypeScript / Hono |
| Server location | Homelab or VPS, packaged as one Docker image |
| Remote access | Operator-supplied reverse proxy (SWAG + Cloudflare Tunnel, Traefik, etc.); HTTPS required for PWA + camera |
| AI provider | Claude Haiku 4.5 |
| Image processing | Edge detection + perspective correction + OCR + searchable PDF |
| OCR location | Client-side (Tesseract.js, Web Worker, cached `eng.traineddata`) |
| Confirmation UX | Always confirm filename + folder before upload |
| Proton auth | Port SRP login from `@protontech/srp` (largest single chunk of work) |
| Upload pipeline | Unified: images get flattened + OCR'd; PDFs skip flatten, OCR only if no text layer |
| Offline behavior | IndexedDB outbox + Service Worker Background Sync |

## Architecture Overview

Two deployable units in one Docker image:

1. **PWA frontend** — TypeScript + Vite + Preact. Installable from the server's HTTPS origin. Runs the scanner pipeline entirely in-browser:
   - Camera capture via `getUserMedia`
   - Edge detection + perspective correction via `jscanify`
   - Multi-page collation
   - OCR via Tesseract.js in a Web Worker (cached `eng.traineddata`)
   - Searchable PDF assembly via `pdf-lib` (image layer + invisible text layer)

2. **Backend server** — Node 20+ / Hono / TypeScript. Responsibilities:
   - SRP login + session persistence
   - Proton Drive SDK calls (folder tree, uploads, event sync)
   - Anthropic Haiku 4.5 classification calls
   - Static asset serving for the PWA

**Storage:** one Docker volume mounted at `/data`, holding a SQLite DB (`better-sqlite3`):
- Encrypted Proton session blob (AES-GCM, key from `SESSION_ENCRYPTION_KEY` env var)
- Folder-tree cache + Proton event cursor
- Classification history (FTS5-indexed for retrieval)
- Audit log of uploads

**Trust boundary:** the phone owns raw page images and the Proton password (entered into PWA, used in SRP exchange, never stored). The server owns the long-lived Proton session and the Anthropic API key.

## Components

### Server modules

- **`auth/srp.ts`** — Wraps `@protontech/srp`. Exposes `login(email, password, totp?)` returning Proton session tokens (`AccessToken`, `RefreshToken`, `UID`) and a `refresh()` helper. No HTTP routing, no storage.
- **`auth/session-store.ts`** — Persists the session blob to SQLite, encrypted with AES-GCM using `SESSION_ENCRYPTION_KEY` (32 bytes, base64). Exposes `save`, `load`, `clear`. Sole owner of the encryption boundary.
- **`drive/client.ts`** — Thin wrapper over `@protontech/drive-sdk`, constructed with a session loaded from `session-store`. Exposes only `listFolderTree()`, `uploadFile(parentLinkId, name, bytes, mimeType)`, `subscribeEvents(cursor, onEvent)`. Hides SDK-internal types behind our own.
- **`drive/folder-cache.ts`** — Maintains the cached folder tree in SQLite. On startup, hydrates from cache then calls `subscribeEvents` from the saved cursor to apply deltas. Exposes `getTree()` returning `{ linkId, path, name }[]`.
- **`classify/haiku.ts`** — Single function: `classify({ ocrText, thumbnailPng, folders, recentExamples }) → { suggestedName, suggestedFolderLinkId, confidence, rationale }`. Uses Anthropic SDK tool-use for guaranteed-schema JSON. Stateless.
- **`classify/history.ts`** — Records every confirmed save (final name, folder, OCR snippet) and retrieves 3–5 nearest past examples via SQLite FTS5 for in-context shots in the next classification call.
- **`http/`** — Hono routes:
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/folders` (cached tree)
  - `POST /api/classify` (multipart: 512px page-1 thumbnail + OCR text → suggestion). Note: the full PDF is **not** sent at this step; it stays on the phone until upload.
  - `POST /api/upload` (PDF + chosen name + folder linkId → upload, record, return Drive link)
  - Static asset serving for the PWA.
- **`config.ts`** — Loads env vars; fails fast if any required value is missing. No defaults for secrets.
- **`db.ts`** — Opens SQLite, runs migrations, exposes typed query helpers.

### PWA modules

- **`pwa/scanner/`** — Camera capture, `jscanify` integration, manual corner adjustment fallback.
- **`pwa/ocr/`** — Tesseract.js Web Worker wrapper, `eng.traineddata` caching via Service Worker.
- **`pwa/pdf/`** — Multi-page searchable PDF assembly with `pdf-lib`.
- **`pwa/outbox.ts`** — IndexedDB-backed queue: items with status `pending_classify` / `pending_upload` / `needs_attention`. Exposes enqueue, drain, list, retry, delete.
- **`pwa/sw-sync.ts`** — Service Worker registering `outbox-drain` background sync; drains the queue when connectivity returns. iOS Safari fallback: drain on next PWA open + manual "retry all" button.
- **`pwa/api.ts`** — Typed client for the server's HTTP API.
- **`pwa/ui/`** — Login screen (with credential-handling warning), scan workspace, confirmation card, outbox panel.

## Data Flow

### Journey A: First-time setup

1. User opens `https://docs.your-domain/` on phone, installs PWA.
2. PWA shows login screen with explicit warning: *"This is an unofficial app. Your Proton credentials are sent only to your own server. Proton does not endorse this app."*
3. User enters Proton email + password (+ TOTP if enabled). PWA `POST /api/auth/login`.
4. Server runs SRP exchange with Proton, gets session tokens, encrypts and stores in SQLite. Returns success cookie (HttpOnly, SameSite=Strict).
5. Server kicks off folder-tree hydration in background.

### Journey B: Scan a document (steady state)

1. User taps "New Scan" → camera view via `getUserMedia`.
2. Capture page. `jscanify` finds corners; user adjusts handles if needed; perspective transform applied → flattened PNG.
3. User taps "Add Page" or "Done". Pages held in memory + IndexedDB checkpoint.
4. PWA spawns Web Worker, runs Tesseract.js across all pages, assembles searchable PDF.
5. PWA generates 512px thumbnail of page 1 + collected OCR text, `POST /api/classify`. Server hits Haiku, returns `{ suggestedName, suggestedFolderPath, confidence, rationale }`.
6. PWA shows confirmation card: editable filename, folder picker pre-set to suggestion (browse to override), rationale shown small. User taps "Save."
7. PWA `POST /api/upload` (PDF + name + folder linkId). Server uploads via SDK, records history, returns Drive link.
8. PWA shows toast with "Open in Drive" link. Workspace clears.

### Journey C: Upload existing file

Same as Journey B from step 4. Image uploads run through flatten + OCR; PDFs skip flatten and only OCR if no text layer exists (detected via `pdf-lib` text extraction).

### Journey D: Folder-tree refresh

Server calls Proton's **events endpoint** (the SDK-blessed event-based sync mechanism — *not* recursive folder traversal) every 5 minutes, applies deltas to cache. This satisfies the "use event-based sync" ToS requirement; the 5-minute cadence is Proton's recommended polling interval *of the events endpoint*. PWA fetches fresh tree on each scan-confirmation step.

## Error Handling & Edge Cases

### Auth failures
- SRP wrong password / bad TOTP → 401, generic "credentials rejected"; no server retries.
- Session expires mid-use → server tries refresh once; if refresh fails, returns 401 with `reauth_required` flag; PWA bounces to login.
- `SESSION_ENCRYPTION_KEY` missing or malformed at startup → server fails fast, exits non-zero.

### Scanner failures
- `jscanify` can't find corners → fall back to manual 4-point selection.
- Tesseract fails on a page → keep image-only page, mark PDF as "page N not searchable", continue. Classification still runs.
- Tab killed mid-scan → on next open, IndexedDB checkpoint offers "Resume previous scan?"

### Classification failures
- Haiku API error / 10s timeout → confirmation card shows with empty suggestion; user types name + picks folder manually. Save still works.
- Haiku returns invalid JSON → same path as API error; raw response logged server-side.
- Haiku suggests a folder linkId not in cached tree → drop suggestion, fall back to manual folder pick (hallucination guard).

### Upload failures
- Proton SDK error → surface verbatim to PWA; PDF stays in IndexedDB outbox for retry.
- Network drop mid-upload → SDK chunked resume if supported, else full retry on user action.

### Offline upload queue
- Every built PDF lands in IndexedDB outbox with status `pending_classify` or `pending_upload` plus chosen name + folder linkId.
- Persistent **outbox panel** in PWA shows queue with status; user can edit, retry, delete.
- **Service Worker Background Sync** registers `outbox-drain`; browser fires when connectivity returns even if PWA tab is closed. Drains queue: classify-then-upload for `pending_classify`, upload-only for `pending_upload`.
- **iOS Safari fallback** (no Background Sync): drain on next PWA open + manual "retry all" button.
- **Offline classification**: not attempted. User can either save with `Scan {timestamp}` and let it classify when back online (review suggestion in outbox before upload), or save with manual name + folder from cached tree (goes straight to `pending_upload`).
- **Long-queued items (>24h)**: server re-validates folder linkId still exists before upload; if gone, item flips to `needs_attention`.
- **Source data safety**: items stay in IndexedDB until server confirms successful Drive upload (returns Drive link); only then is the PDF blob purged.

### Rate limiting / Proton API politeness
- Folder event polling backs off exponentially on 429s.
- Upload concurrency capped at 1.

### Data integrity
- Every successful upload recorded to `audit_log` with timestamp, original guess, final filename, folder linkId, Drive file linkId.
- SQLite WAL mode + `synchronous=NORMAL`; on host crash, worst case is losing a few classification-history entries — never user data (source PDF is on Drive).

### Explicitly NOT handled
- Multi-user support.
- Filename conflict resolution in target folder — Proton SDK behavior wins (likely auto-suffix); we report what it returned.

## Testing

### Server (Vitest)
- `auth/srp.ts` — unit tests with mocked Proton challenge/response; one opt-in integration test against the real Proton API behind `INTEGRATION=1` (skipped in CI).
- `auth/session-store.ts` — round-trip encrypt/decrypt, key rotation, missing-key failure mode.
- `drive/folder-cache.ts` — fed synthetic event streams; assert tree state after each delta. No network.
- `drive/client.ts` — mocked SDK; integration test uploads to `__test__/` folder on real test account, then deletes.
- `classify/haiku.ts` — recorded fixtures replayed via stub SDK; assert prompt assembly, JSON parsing, hallucination rejection.
- `classify/history.ts` — FTS5 retrieval returns expected nearest examples for fixed corpus.
- `http/` routes — full round-trip with mocked SDK + Anthropic. Covers happy path + every error branch.

### PWA (Vitest + Playwright)
- Pure logic units (PDF assembly, OCR result merging, outbox state machine) — Vitest in jsdom.
- Scanner pipeline — Playwright with fake `getUserMedia` returning fixture image; assert flatten + OCR + PDF output matches golden file (pixel-diff tolerance for OCR).
- Outbox drain — Playwright with stubbed server; simulate offline → online transition via `page.context().setOffline()`; assert items drain.
- Install + service worker — Playwright Lighthouse audit asserts PWA installability.

### Manual end-to-end smoke
- `docs/smoke-test.md` checklist: log in, scan a real receipt, confirm filename, verify in Proton Drive web UI, verify text-search finds OCR'd content. Run before every deploy.

### Deliberately not tested
- The Proton SDK itself.
- Haiku's classification quality (non-deterministic).
- Browsers other than mobile Safari + Android Chrome.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Proton SDK breaking crypto-model change lands mid-build | High | Pin SDK version; budget rework. Keep `drive/client.ts` thin so re-port surface is small. |
| SRP port subtly wrong → can't log in or 2FA breaks | High | Start from official open-source Proton client code. Comprehensive integration test against real Proton account before any other work. |
| Tesseract.js performance unusable on older phones | Medium | Test on owner's phone early. Fallback: server-side OCR if needed (architecture supports the swap). |
| Haiku misclassifies → wrong folder | Low | Always-confirm UX catches it. Hallucination guard rejects unknown folder linkIds. |
| Reverse proxy / tunnel down → app unreachable | Low | Outbox queue means scans aren't lost; user retries when proxy recovers. |

## Open Questions

- 2FA method: **TOTP only for v1.** The `login(email, password, totp?)` signature bakes this assumption in. FIDO2/U2F is explicitly out of scope for v1; if needed later, it requires a separate auth flow and is a non-trivial addition.
- Anthropic API key rotation cadence — env var only, or worth a small admin endpoint? (Defer; env var is fine for v1.)
