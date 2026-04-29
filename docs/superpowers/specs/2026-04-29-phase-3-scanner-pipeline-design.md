# Phase 3: Scanner Pipeline — Design Spec

**Date:** 2026-04-29
**Status:** Draft for review
**Owner:** ow@mroliverwine.com (single-user personal project)
**Predecessor:** [Phase 2 — Drive Integration](../plans/2026-04-28-phase-2-drive-integration.md) (tagged `phase-2-complete`)
**Parent design:** [doc-scanner — overall design spec](2026-04-27-doc-scanner-design.md)

## Goal

Ship the in-browser document scanner: live camera viewfinder with edge-detection, auto-capture, multi-page collation, and a saved-scans list — all client-side in the PWA, persisted to IndexedDB.

At the end of Phase 3, the user can pick up their phone, scan a multi-page paper document, and see the captured pages in a Saved Scans list. Phase 4+ adds OCR, classification, and the real upload path.

## Non-Goals

These are deliberately deferred to later phases:

- **OCR.** No Tesseract.js, no `eng.traineddata` caching, no searchable PDF assembly.
- **Classification.** No `/api/classify`, no Anthropic Haiku integration.
- **Real upload.** No `/api/upload` calls. The `/api/drive/test-upload` endpoint from Phase 2 is not consumed by the PWA in Phase 3.
- **Folder picker.** No tree browser; that's part of the upload phase.
- **Outbox / Service Worker Background Sync.** The Saved Scans screen is a simple list, not a sync queue. No retry logic, no sync events.
- **Page reordering inside a saved scan.** Pages display in capture order. Per-page delete after a scan is completed is also deferred — only the whole scan can be deleted.

## Constraints & Context

- **PWA-only.** Zero server-side changes. The Phase 1 and Phase 2 server is untouched.
- **Existing PWA stack:** Preact + Vite + TypeScript. No CSS files exist yet (current screens use inline `style={...}` objects). Phase 3 introduces a CSS file plus a small theme module.
- **Bundle weight:** jscanify (the OpenCV.js-based edge detector) is ~10MB of WebAssembly. It must be lazy-loaded as a code-split chunk so it doesn't bloat first paint of LoginScreen / StatusScreen.
- **Browser support:** mobile Safari (iPhone) and Android Chrome are the target. Desktop browsers are best-effort for testing.
- **Camera permission requires HTTPS.** Production runs behind the operator's reverse proxy, which is HTTPS. Local dev gets the special `localhost` exemption.
- **iOS Safari per-frame canvas+wasm work is throttled.** A live preview running jscanify at 30fps is unrealistic; we target ~6fps with a graceful floor of ~3fps.
- **IndexedDB quota varies by platform.** Chrome is generous (~60% of disk); Safari can prompt for eviction at 50MB. We listen for `QuotaExceededError` and surface it; we do not preemptively count bytes.

## Decisions Made During Brainstorming

| Question | Decision |
|---|---|
| Scope within "scanner" | Full multi-page workflow (capture, edge-detect, manual fallback, multi-page collation, IndexedDB checkpoint) |
| What happens at "Done" | Persist to IndexedDB + show Saved Scans list (view + delete). No upload, no OCR. |
| Capture UX flow | Live edge detection with auto-capture (after stability), not capture-then-correct |
| Auto-capture stability rule | All 4 corners stable within ~20px for ~1.5s; visible amber→green countdown; manual shutter overrides at any time |
| Auto-capture toggle | User can disable; setting persists in localStorage |
| jscanify throttle | ~6 fps live preview; full quality on the captured frame |
| Image format | JPEG quality 92, max edge 2200px after perspective transform |
| Storage layer | IndexedDB via [`idb`](https://www.npmjs.com/package/idb) wrapper; three object stores (scans / pages / thumbs) |
| Theming | CSS custom properties + `prefers-color-scheme` media query; manual override (system/light/dark) on StatusScreen, persisted in localStorage |
| Existing screen migration | LoginScreen + StatusScreen migrate to theme variables; no in-flight visual inconsistency |
| Saved-scans list affordances | Inline trash icon per row (no swipe gesture); newest-first; tap row to view; long-press in ScanViewerScreen for "fix corners" |

## Architecture Overview

Phase 3 ships entirely inside `pwa/src/`. Five new modules under `pwa/src/scanner/`, four new screens under `pwa/src/ui/`, one new theme module, and minor edits to the two existing screens.

**Module dependency graph:**

```
ScannerScreen ──┐
                ├── scanner-session (orchestrator)
                │       │
                │       ├── camera          (getUserMedia wrapper)
                │       ├── edge-detect     (jscanify, lazy-loaded)
                │       ├── stability       (pure function over quad history)
                │       └── scans-store     (IndexedDB CRUD via idb)
                │
EditCornersScreen ──── edge-detect, scans-store
SavedScansScreen ──── scans-store
ScanViewerScreen ──── scans-store
ResumePrompt ──── scans-store

All screens ──── theme module
```

**Trust / data boundary unchanged from earlier phases.** Pages and scans live entirely on the phone. The server doesn't see them in Phase 3.

## Components

### New PWA modules — `pwa/src/scanner/`

- **`camera.ts`** — Wraps `navigator.mediaDevices.getUserMedia`. Exposes `start(constraints) → MediaStream`, `stop()`, and a typed error enum (`PERMISSION_DENIED`, `NO_CAMERA`, `BUSY`, `OTHER`). Handles the iOS Safari quirk where `getUserMedia` rejects without a clear reason if called too early after page load.
- **`edge-detect.ts`** — Lazy-loadable module that imports jscanify on first call. Exports `findQuad(canvas) → Quad | null` and `warpToFlat(canvas, quad, maxEdge=2200) → Promise<Blob>` (JPEG-92). Both delegate to jscanify; `warpToFlat` adds the OffscreenCanvas downscale + JPEG encode step.
- **`stability.ts`** — Pure function. Maintains a rolling window of the last N quads (timestamped). Exposes `update(quad) → 'searching' | 'counting' | 'stable'` and `reset()`. Stability rule: all 4 corners must stay within ~20px of their median position for ~1.5s. Returns enum so the viewfinder UI can drive its color/ring without coupling to time.
- **`scans-store.ts`** — IndexedDB CRUD via the `idb` wrapper. Schema in "Data Model" below. Functions:
  - `createInProgress() → ScanId`
  - `appendPage(scanId, blob, quad) → ordinal`
  - `updatePage(scanId, ordinal, blob, quad)` — used after EditCorners re-warps
  - `findInProgress() → Scan | null`
  - `finish(scanId)` — flips status to completed, generates the thumbnail, sets pageCount + updatedAt
  - `delete(scanId)` — cascades pages + thumbnail
  - `listCompleted() → Scan[]` (sorted by updatedAt desc, **does not load page blobs**)
  - `getPages(scanId) → Page[]` — used only by ScanViewerScreen / EditCornersScreen
- **`scanner-session.ts`** — Controller composing the above. Manages the lifecycle of an in-progress scan: starts a session, drives the per-frame loop (camera frame → findQuad → stability), handles auto-capture firing, kicks captures into the warp pipeline, appends to store. Exposes a tiny event API (`onPageAdded`, `onStabilityChange`) for ScannerScreen to render off.

### New PWA screens — `pwa/src/ui/`

- **`ScannerScreen.tsx`** — Top bar (cancel · "Page N" · settings icon) · live viewfinder with quad overlay + auto-capture toggle · page strip below · controls row (retake · shutter · Done). Subscribes to `scanner-session` events.
- **`EditCornersScreen.tsx`** — Captured frame with 4 draggable corner handles (blue) + Cancel / Apply. Reached either when manual shutter fired with no quad detected, or via "fix corners" on a strip page during scanning. Validates quad on every drag (corners must form a non-degenerate quadrilateral; Apply is disabled otherwise).
- **`SavedScansScreen.tsx`** — Top bar (back · "Saved Scans" · settings) · "+ New Scan" button · list of completed scans (thumbnail · "Scan · N pages" · timestamp+size · trash icon). Empty state when there are zero saved scans. Confirm modal on trash tap.
- **`ScanViewerScreen.tsx`** — Read-only swipeable page viewer. Top bar shows position ("2 / 4") and a trash icon for whole-scan delete. Page strip below highlights current page.
- **`ResumePrompt.tsx`** — Modal shown on app open when an in-progress scan exists. "Resume scanning" / "Discard" buttons; cannot be dismissed without a choice (so the in-progress row doesn't accumulate forever).

### New theme module — `pwa/src/theme/`

- **`theme.css`** — Single stylesheet declaring CSS custom properties on `:root` for light theme, with `@media (prefers-color-scheme: dark) { :root { ... } }` for dark. Variables: `--bg`, `--bg-elev`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--accent-fg`, `--danger`. `:root[data-theme="light"]` and `[data-theme="dark"]` selectors override the media query when the user picks an explicit mode.
- **`use-theme.ts`** — Preact hook backing a 3-state preference (`'system' | 'light' | 'dark'`) read from `localStorage.theme` (default `'system'`). When the value is `'system'`, removes `data-theme` from `<html>`; when explicit, sets it. Also updates the `<meta name="theme-color">` tag so the iOS PWA status bar matches.

### Edits to existing files

- **`pwa/src/main.tsx`** — Imports `theme/theme.css` so it's bundled into the entry chunk.
- **`pwa/src/ui/App.tsx`** — Adds routing between StatusScreen / ScannerScreen / SavedScansScreen / ScanViewerScreen / EditCornersScreen. Today there's no router; we keep it simple with a discriminated-union state in `App.tsx` (no library — `wouter` or `preact-router` is overkill for ~5 screens).
- **`pwa/src/ui/LoginScreen.tsx`** — Inline styles converted to CSS classes that read theme variables.
- **`pwa/src/ui/StatusScreen.tsx`** — Inline styles converted to CSS classes; gains a "Saved Scans" entry, a "+ New Scan" button, and a 3-button theme picker (System / Light / Dark).

### Bundle / lazy-loading strategy

- **Main bundle** (loaded on every page open): main.tsx, theme.css, use-theme, App.tsx, LoginScreen, StatusScreen, ResumePrompt, scans-store, and the API client. ResumePrompt and scans-store are needed at startup to show the resume modal if applicable, so they ship in the main chunk.
- **Scanner chunk** (loaded on first ScannerScreen route): camera, edge-detect, stability, scanner-session, ScannerScreen, EditCornersScreen. Includes the jscanify wasm transitively (~10MB).
- **Saved-scans chunk** (loaded on first SavedScansScreen route): SavedScansScreen, ScanViewerScreen.

The Service Worker (which exists in skeletal form from Phase 1) is configured to cache the scanner chunk and the jscanify wasm so the second open is instant offline.

## Data Model

IndexedDB database: `docscanner`, version `1`. Created/migrated by `scans-store` on first open.

```
ObjectStore "scans"
  keyPath: id (string, ULID — sortable by creation time)
  fields:
    id            string  ULID
    status        'in_progress' | 'completed'
    pageCount     number
    createdAt     number  (epoch ms)
    updatedAt     number  (epoch ms)
    thumbnailKey  string | null  (key into "thumbs"; null while in_progress)
  indexes:
    by_status     (so findInProgress is O(log n))
    by_updatedAt  (so listCompleted sorts efficiently)

ObjectStore "pages"
  keyPath: [scanId, ordinal]
  fields:
    scanId      string  ULID (FK → scans.id)
    ordinal     number  (0-indexed; pages always ordered by capture)
    blob        Blob    (JPEG-92, max edge 2200px, see Image format below)
    quad        { tl: {x,y}, tr: {x,y}, bl: {x,y}, br: {x,y} }
    capturedAt  number  (epoch ms)
  indexes:
    by_scan     (scanId)

ObjectStore "thumbs"
  keyPath: id (string, UUIDv4)
  fields:
    id    string
    blob  Blob   (JPEG, ~30KB, 256px max edge, used by SavedScansScreen list)
```

**Why three stores instead of two:** putting pages and thumbnails in `scans` means every list-of-scans query drags megabytes of full-page Blobs into memory. Splitting them lets `SavedScansScreen` load only thumbnails. Costs a few extra lines of indirection in `scans-store.ts`.

**Image format & resolution rationale:**

- **JPEG quality 92, max edge 2200px** after perspective transform.
- A typical paper page lands at ~250–500 KB.
- PNG would be 6–10× larger; OCR doesn't benefit from lossless.
- Quality below 92 produces visible artifacts in dark text on light backgrounds.
- 2200px comfortably exceeds 300dpi for a US Letter page (the OCR sweet spot) without bloating IndexedDB with the 4000px+ that modern phone cameras shoot at.

**The "one in-progress scan" invariant.** At most one scan with `status: 'in_progress'` exists at any time. `scanner-session` enforces this. ResumePrompt hands off to either continuing that scan or deleting it.

## Data Flow

### Journey 1 — Start a fresh scan

1. User on StatusScreen taps "+ New Scan". `App.tsx` routes to ScannerScreen.
2. ScannerScreen mounts: lazy-imports the scanner chunk (triggers jscanify wasm fetch on first ever open; cached after that). Requests camera via `camera.start()`.
3. `scanner-session.start()` creates a new `scans` row with `status: 'in_progress'`, `pageCount: 0`.
4. Camera ready → live preview begins. Per-frame loop runs at ~6fps: `camera.captureFrameToCanvas()` → `edge-detect.findQuad()` → `stability.update()`.
5. When `stability` returns `'stable'` (or user taps the shutter), `scanner-session` freezes the current frame, calls `edge-detect.warpToFlat()`, and `scans-store.appendPage()`. Strip rerenders.
6. User taps Done → `scanner-session.finish()` flips `status: 'completed'` and generates the thumbnail. App routes to SavedScansScreen with the new scan at the top.

### Journey 2 — Manual corner adjustment

1. User taps shutter while no quad is detected, or taps "fix corners" on a page in the strip during scanning.
2. App routes to EditCornersScreen with the captured frame and an initial quad guess (jscanify's last detected quad if any; otherwise a default quad inset 10% from the frame edges).
3. User drags the four blue handles. Apply is disabled while the quad is degenerate (corners cross or zero area). Live preview overlay re-renders on each drag.
4. User taps Apply → `edge-detect.warpToFlat()` re-runs with the new quad → `scans-store.appendPage()` (if new capture) or `scans-store.updatePage(scanId, ordinal, …)` (if fixing an existing strip page) → route back to ScannerScreen.

### Journey 3 — Resume previous scan

1. App boots. After successful login, StatusScreen mounts.
2. Effect calls `scans-store.findInProgress()`.
3. If a result is returned, `<ResumePrompt>` modal renders over StatusScreen with two buttons: "Resume scanning (N pages from <relative time>)" and "Discard".
4. Resume → route to ScannerScreen, passing the existing scan's id; `scanner-session` re-uses it instead of creating a new row.
5. Discard → `scans-store.delete(scanId)` (cascades pages) → modal dismisses.

### Journey 4 — Browse and delete saved scans

1. StatusScreen "Saved Scans" link → SavedScansScreen → `scans-store.listCompleted()` returns scans ordered newest-first, **only thumbnails loaded** (never page blobs).
2. Empty state if zero scans: a soft message and a "+ Start your first scan" button.
3. Tap row → ScanViewerScreen with the scan id. Pages load on demand via `getPages(scanId)`.
4. Tap trash icon (in row or in viewer header) → confirm modal → `scans-store.delete(scanId)` cascades pages and thumbnail.

### Journey 5 — Theme change

1. User opens StatusScreen, taps the Light radio.
2. `use-theme` writes `'light'` to `localStorage.theme`, sets `data-theme="light"` on `<html>`, updates `<meta name="theme-color">` content.
3. CSS variables resolve to the light palette regardless of system preference.
4. Switching to System removes the `data-theme` attribute, returning to media-query-driven behavior.

## Error Handling & Edge Cases

| Failure | Behavior |
|---|---|
| Camera permission denied | Full-screen message *"Camera access required. Open Settings → Safari → Camera and allow."* with a "Try again" button that re-invokes `getUserMedia`. No way to bypass; ScannerScreen is non-functional without it. |
| No camera available (desktop) | Same screen, copy *"No camera detected on this device."* |
| jscanify wasm fails to load | Fall back to manual-only mode: viewfinder shows a default centered quad as starting guess. Every shutter tap goes to EditCornersScreen. Banner explains *"Edge detection unavailable — adjust corners manually."* |
| No quad detected on a frame | Viewfinder shows no overlay; *"Position page in view"* hint replaces *"Hold steady…"*. Tapping shutter goes to EditCornersScreen with a default quad. |
| Stability never converges (shaky / poor light) | Auto-capture simply doesn't fire. Manual shutter remains available. No nag. |
| IndexedDB QuotaExceededError on append | Non-dismissible banner *"Storage full — delete a saved scan to keep going."* New captures blocked. Trash icons in SavedScansScreen still work; deleting one frees the user. |
| Tab killed mid-capture | The `in_progress` row plus its already-captured pages persist. Next open triggers ResumePrompt. |
| EditCornersScreen quad invalid (corners crossed / zero area) | Apply disabled; small inline message *"Corners must form a quadrilateral."* No silent failures. |
| User goes offline before jscanify is cached | First ever open requires connectivity (we don't pre-bundle wasm). After Service Worker caches it, subsequent opens work fully offline. The fallback above handles the offline-first-time case. |
| Storage size displayed in SavedScansScreen rows is stale | Recomputed on each `listCompleted` call from `pageCount * estimated-size`; not authoritative but cheap. |

### Explicitly NOT handled

- **iOS PWA reload after camera permission grant.** iOS sometimes requires a full reload after the user toggles camera permission in Settings. The "Try again" button performs `location.reload()` to handle this; we don't do anything fancier.
- **Multi-tab / multi-device sync.** Single-user, single-device app. If the user opens it in two tabs, each thinks it owns the in-progress scan. We don't lock; the second tab's appends would race and last-write-wins on the same `[scanId, ordinal]`. Not worth the complexity for a personal app.
- **Page reorder.** Capture order is the only order. Fix-corners on a strip page edits in place.
- **Per-page delete after a scan is completed.** Whole-scan delete only.

## Testing

### Vitest unit (`pwa/tests/`)

- **`stability.test.ts`** — Pure function. Inputs: synthetic quad sequences (steady, jittery, drifting). Asserts state transitions and timing. Uses fake timers for the 1.5s window.
- **`scans-store.test.ts`** — IndexedDB CRUD against [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb). Covers create→append→finish, cascade-delete, findInProgress single-row invariant, listCompleted ordering, QuotaExceededError surfacing.
- **`use-theme.test.ts`** — happy-dom `matchMedia` stub. Asserts system/light/dark transitions update `data-theme`, localStorage, and the `<meta name="theme-color">` content.

### Vitest component (Preact + happy-dom + Testing Library)

- **`ResumePrompt.test.tsx`** — Renders given a fake in-progress scan stub; "Resume" calls the right route handler, "Discard" calls `scans-store.delete`, modal can't be dismissed without a choice.
- **`SavedScansScreen.test.tsx`** — Empty state, list rendering with seeded scans, delete flow with confirm modal.
- **`EditCornersScreen.test.tsx`** — Drag interactions via synthetic pointer events; Apply disabled when quad invalid.

### Not unit-tested (deliberate)

- **`camera.ts`** — Wraps `getUserMedia`. Mocking it is more work than it's worth; covered by manual smoke.
- **`edge-detect.ts`** — Wraps jscanify / OpenCV.js. We trust the library; verifying on real hardware is more useful than mocking the wasm boundary.
- **`ScannerScreen` integration** — Too many moving parts (camera + canvas + wasm + IndexedDB). Manual smoke handles this.

### Manual smoke (recorded in the Phase 3 plan)

1. Capture a single-page document on phone with auto-capture in good light → page lands in saved scans, viewable.
2. Capture a 5-page multi-page doc → all 5 pages present, in capture order, viewable in ScanViewerScreen.
3. Force-kill PWA mid-scan (swipe-up close on iOS) → ResumePrompt appears next open.
4. Toggle dark mode in iOS Settings while app is open → app re-themes without reload.
5. Deny camera permission → friendly error message → grant permission via Settings → "Try again" → works.
6. Disable network (airplane mode) before first scanner open → graceful "Edge detection unavailable" banner; manual flow still works.

### No Playwright in Phase 3

Real-device camera + wasm + IndexedDB is what we need to validate, and Playwright on CI doesn't help with any of those. Adding Playwright now would be infrastructure with zero coverage of the actual risky code paths.

## Risks

- **iOS Safari `getUserMedia` flakiness.** Random rejections on first call after page load are documented across Safari versions. Mitigated by `camera.ts` retrying once after a short delay; if the second attempt fails, surface the error.
- **jscanify performance on cheap Androids.** ~6 fps may not be achievable. We design for a 3 fps floor; below that the live overlay will lag visibly but auto-capture still works (just feels less responsive).
- **iOS PWA Service Worker caching of large wasm.** The 10MB wasm exceeds some Service Worker caches' default size limits. We explicitly allow it via the SW config; otherwise first-offline-open silently misses cache.
- **IndexedDB quota surprise.** Safari can prompt to evict at 50MB without warning. Our QuotaExceededError handler is the safety net. If users routinely hit this, Phase 4 (which adds upload + delete-on-success) naturally addresses it.

## Open Questions

These are explicitly **not** locked down in the spec; they get answered during implementation:

1. **Exact stability thresholds** (`1.5s` window, `20px` corner drift). We feel these out on the actual phone.
2. **`idb` vs hand-rolled IndexedDB wrapper.** `idb` is the default; we'd swap if it surprises us.
3. **Whether to pre-bundle a small placeholder wasm or load nothing.** If first-ever open is offline, the user is just stuck. Accept that; fix in a later phase if it becomes a real problem.

## Phase 3 Done — Definition

- All Phase 1 + Phase 2 + new Phase 3 unit tests pass: `cd server && npm test` (existing) and `cd pwa && npm test` (new tests added).
- Phase 1 + Phase 2 integration tests still pass under the new lockfile.
- Phase 1 + Phase 2 manual smokes still work (login, status persistence, test-upload via curl).
- Phase 3 manual smoke succeeds end-to-end on a real iPhone or Android phone (the 6 cases above).
- No new server-side endpoints. No changes to existing server modules. (Phase 3 is PWA-only.)

---

## Smoke Results (filled in during the manual smoke task)

_Date:_
_Test device:_
_Notes:_
