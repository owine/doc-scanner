# AI Document Filing — Design Spec

**Date:** 2026-10-09
**Status:** Approved in brainstorming; awaiting written-spec review
**Parent spec:** [`2026-04-27-doc-scanner-design.md`](2026-04-27-doc-scanner-design.md)
**Supersedes:** [`2026-05-08-phase-5-ai-organize-design.md`](2026-05-08-phase-5-ai-organize-design.md) (the scanner-shaped Phase 5 on `feat/phase-5-ai-organize`)
**Branch:** `feat/ai-analyzer` (analyzer + model eval already built; see [Status](#status-of-the-branch))

## Why this exists

Development stalled inside the scanner. The scanner was meant to be one way into the thing that matters: **documents land in Proton Drive with a good name in the right folder, without the user doing the filing.** This spec re-centres the app on that. Any document — scanned, picked from the phone or desktop, shared from another app, or emailed — goes through one pipeline: analyse it with Claude, name it the way the user names things, pick (or propose) a folder, and file it, automatically when the model is confident and through a quick review when it isn't.

The Phase 5 branch already built most of the pieces (folder tree, Haiku classification, few-shot history, upload into a folder, a confirm card, an outbox) but shaped every one of them around camera pages: `/api/classify` only took page images, Haiku was also asked for word-level bounding boxes to build a searchable PDF on the phone, and `/api/upload` only took PDFs. That coupling — understanding a document vs. producing a text layer for a scan — is what this design pulls apart.

## Scope

This spec covers the **core pipeline**: the server-side inbox and worker, the analyzer, preparing and filing, the PWA's file picker and scanner as entrypoints, and the review and activity UI.

Two entrypoints get their own short follow-up specs because they are independent plumbing on top of the same `POST /api/documents`:

1. **Share sheet** — Web Share Target in the manifest plus a service-worker handler that posts the shared file.
2. **Email-in** — mail ingest, a sender allow-list, a machine credential for the endpoint, and the email subject/body as `sourceContext`.

### Non-goals

- Re-filing or renaming documents already in Drive.
- Persisting decrypted Proton keys to survive restarts (see [Trust boundary](#trust-boundary)).
- Client-side OCR (retired in Phase 5 v2; OCR is now server-side `ocrmypdf`).
- Multi-user. Everything assumes one user, a few documents a week, occasional bursts.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Entrypoints | Picker/drag-drop and scanner now; share sheet and email-in as follow-up specs | All four post to one endpoint; the two follow-ups are independent plumbing. |
| Confirmation | **Auto-file when confident**, review queue otherwise | Fewer taps; a misfile is cheap to fix in Drive, and the eval shows the high-confidence band is precise. |
| What the AI may decide | Name + existing folder, **or propose a new folder** — a proposal always goes to review, and is created automatically when approved | Lets structure grow (a new year, a new kind of document) without the AI reshaping the tree unseen. |
| Naming | **Learn from the user's own names**: each folder's five most recent filenames, no fixed template. FTS5 recall of similar past documents is **not recorded or used in v1**: the history table would hold names, paths and document text in plaintext, so it starts collecting only when recall is built and the eval shows it helps | The user's conventions vary by folder; a template would fight them. Recent names alone gave 83% in the eval; recall has no pre-analysis text to search with yet (see §2). |
| File types | PDF, images, Office documents, and anything else (metadata-only) | Every type gets filed; only the analysis depth varies. |
| Scan output | Phone builds an **image-only PDF**; the **server adds the text layer** with `ocrmypdf` | Keeps OCR out of iOS Safari (the Phase 4 failure) and applies the same rule to any image-only PDF, whatever its source. |
| Processing model | **SQLite job queue worked in-process**; every source returns `202` immediately | One code path for interactive and unattended sources; survives restarts; no long-held requests from iOS Safari. |
| Unattended filing | **Analyse while logged out, file after login** | Keeps today's posture: decrypted keys never touch disk. |
| Model | **Claude Haiku 5.5, medium effort**, configurable | Ties Opus 5.5 on accuracy at ~1/37 the cost, with better-calibrated confidence. See [Model evaluation](#model-evaluation). |
| Auto-file threshold | **0.80**, configurable; the prompt states the configured value | In the eval, 53% of documents auto-filed at 0.80 with no misfiles (measured with the prompt saying 0.85; re-checked at 0.80 before auto-filing goes live). |
| Duplicate upload | Returns the **existing** document (unless that one failed, in which case it is retried) | Forwarded emails and double taps otherwise file twice. |
| Discard | **Kept 7 days**, recoverable, then purged | Room to change one's mind; Drive remains the system of record. |

## Trust boundary

Unchanged from the parent spec, made explicit for unattended sources:

- Decrypted Proton user and address keys live **only in memory**, for the lifetime of a login. A server restart forces re-login (`middleware.ts`). This spec does not change that: persisting the key passphrase would mean that a stolen database plus `SESSION_ENCRYPTION_KEY` decrypts the whole Drive, where today it yields only API tokens.
- The **analysis needs no Proton keys** — the server has the file's plaintext — so documents are analysed and prepared immediately even with no one logged in. Only **filing** (decrypting folder names to pick a target, encrypting the upload) needs a live session; documents wait in `awaiting_login` until there is one.
- Documents waiting in the inbox and the cached folder list are **encrypted at rest** (AES-GCM, key derived via HKDF from `SESSION_ENCRYPTION_KEY` with its own info label). A document's plaintext — the original, the prepared output and its thumbnail — is deleted once it is filed, and 7 days after it is discarded.
- Anthropic sees document content during analysis, as it already did in Phase 5 v2.
- Document content, filenames and folder paths are untrusted input to the model. The worst a hostile document can do is get itself misfiled: the model can only choose among folder IDs it was given, a new folder always needs review, and nothing the model returns is executed.

## Architecture

### 1. Document lifecycle and storage

One table, `documents`, one state machine for every source. Migrations: the Phase 5 history table keeps its `004_classification_history.sql`; `documents` and `settings` are `005`.

| Field | Purpose |
|---|---|
| `id`, `source` | `picker` · `scanner` · `share` · `email` |
| `original_name`, `mime`, `size`, `sha256` | `sha256` drives duplicate detection |
| `source_context` | Free text about the arrival (email subject, etc.) |
| `state`, `attempts`, `error`, `updated_at` | Lifecycle below |
| `analysis` (JSON) | Name, folder choice (existing link ID or proposed new folder), confidence, rationale, `isDocument`, text snippet |
| `decision` (JSON) | The name and folder actually being filed: the analysis's, or the user's approved edit. Written before `filing`, so a restart never loses an approval |
| `filing_target` | Target folder UID and intended name, written just before upload (crash recovery below) |
| `filed_name`, `filed_folder_path`, `drive_node_uid`, `auto_filed`, `user_edited` | Outcome, for the activity log and history |
| `discarded_at` | Set on discard; purge after 7 days |

```
received ─▶ analyzing ─▶ preparing ─▶ ready ─┬─▶ filing ─▶ filed
                                             ├─▶ needs_review ─(approve/edit)─▶ filing
                                             └─▶ awaiting_login ─(login)─▶ filing
any working state ─▶ failed (retry with backoff; visible after 3 attempts)
any resting state before filing ─▶ discarded ─(7 days)─▶ purged
```

- **Auto-file rule:** `confidence ≥ threshold` **and** the answer names an **existing** folder. An unresolved folder or a new-folder proposal always goes to `needs_review`, whatever the confidence. (Duplicates never reach this point: intake returns the existing document.)
- **Discard:** allowed from any **resting** state before filing (`received`, `ready`, `needs_review`, `awaiting_login`, `failed`). While the worker holds a document (`analyzing`, `preparing`, `filing`) the request is recorded and applied when the stage ends; the worker re-checks the row before writing its result, so a discard never races a filing.
- **Blob store:** `<dir of DB_PATH>/inbox/<id>.bin` (no new env var; next to the database, inside the existing data volume), AES-GCM, one file per document; the prepared output and thumbnail sit beside it.
- **Worker:** a single in-process loop, one job at a time, woken on enqueue, on login and on a timer. **Crash recovery** at startup:
  - `analyzing` and `preparing` simply re-run: both read the inbox blob and are idempotent.
  - `filing` resumes as `filing` from `decision`, so an approval or edit survives. An approved new folder's UID is written into `decision` the moment `createFolder` returns, so a retry never creates it twice. If `filing_target` is set, the upload may already have happened, so the worker first looks in the target folder for a file whose claimed SHA-1 matches the prepared file; if one exists the document is marked filed, otherwise it uploads. This prevents `name (1).pdf` duplicates in Drive.

### 2. Analysis

**Built:** `server/src/analyze/` on `feat/ai-analyzer`.

One Claude call per document: `createAnalyzer({ client, model, effort }).analyze(input, folders, examples)`.

**What the model reads**, by file type (`content.ts`):

| Type | Sent as |
|---|---|
| PDF | Native `document` block, cut to the first **20 pages** (`pdf.ts`). Encrypted PDFs go unchanged: e-signature services lock contracts against editing, not opening, and Claude reads them; pdf-lib can neither trim nor count their pages. One that truly needs a password is rejected by the API, and the analyzer retries once from metadata. |
| Image | `image` block, normalised by `sharp` to ≤ 1568 px long edge (the size Claude's vision is tuned for), JPEG or PNG, EXIF-rotated. Formats `sharp`'s prebuilt binary can't decode (HEIC) fall back to metadata. |
| Text (txt, csv, md, html, json) | Text block, capped at 100k characters. |
| Office (docx, xlsx, pptx) | Server-side text extraction → text block. **Not built yet** (no Office documents were in the eval). |
| Anything else | No content; filename, type, size and source context only. |

**Prompt** (`prompt.ts`): a system prompt that is stable for a given threshold setting (changing the threshold just invalidates the prompt cache), then the user turn:

1. **Folder list** with short IDs (`F1`, `F2`, …) — Drive's long link IDs stay out of the prompt and the answer — each with its **five most recent filenames** as the naming signal: `F12 /Bills/Utilities | recent: "Electric Sep 2026"; …`. This block carries the `cache_control` breakpoint, so a burst of documents reuses it. Folders on the user's **never-file-here** list (and everything under them) are left out entirely.
2. **FTS5 examples** — *off in v1, and nothing is recorded.* Migration `004`'s history table exists but stays empty: it would store filed names, folder paths and document text in plaintext, outside the encrypted stores, for a feature that is switched off. Recalling *similar* documents needs text to search with **before** the analysis call, and for scans and image-only PDFs there is none until OCR. Turning recall on (querying with the original filename and source context, or with OCR text if OCR moves ahead of analysis) is a later change, made only if the eval shows it beats recent names alone. Note the field rename when porting: the branch's `ocrSnippet` is `snippet` here.
3. The **document** content blocks.
4. An **arrival** block: source, type, size, original filename, source context, and any note about what the model can or can't see.

The system prompt asks for the user's naming conventions, an existing folder unless every one is clearly wrong, a calibrated confidence (it states the configured threshold, e.g. "documents above 0.80 are filed with no review"; the eval ran with the wording "0.85", so slice 1 re-runs Haiku with 0.80 to confirm calibration — about $1.20 — before auto-filing goes live), `isDocument` (photos are still filed, just kept as images), and a text snippet; and it marks everything about the document as untrusted data.

**Output** is **structured outputs** (`output_config.format` with a zod schema), not forced tool use, which current models reject. Code then resolves and validates it (`resolve.ts`): short folder IDs map back to link IDs, an unknown ID or empty proposal becomes "no folder" (→ review), confidence is clamped to 0–1, and the name is sanitised — control characters and `/ \ : * ? " < > |` removed, a trailing extension stripped, ≤ 120 characters. Unicode and ordinary punctuation are kept; the Phase 5 branch's ASCII-only regex rejected the user's own names.

**Outcomes**: `ok`, or `refusal` / `truncated` / `invalid` with a detail, each carrying the model and token usage that were billed. API errors propagate so the worker's retry policy owns them.

**Settings**: `ANALYZER_MODEL` (default `claude-haiku-5-5`), `ANALYZER_EFFORT` (default `medium`), `AUTO_FILE_THRESHOLD` (default `0.80`). Env vars are the defaults; a value saved in the PWA's settings (§4) overrides them.

### 3. Intake

**`POST /api/documents`** — multipart: one `file`, `source`, optional `originalName` and `sourceContext`. Session-cookie auth (email-in gets a machine credential in its own spec). 50 MB limit.

- Encrypts the file into the inbox, inserts the row, returns **`202 { id }`**.
- **Duplicate** (same `sha256` as a document that is pending, in review, or filed): **`200 { id, duplicate: true }`** for the existing document. If the earlier copy `failed`, it is reset and retried instead. A discarded copy doesn't count: re-uploading it creates a new document.

**PWA:**

- **Add** screen: multi-file picker (any type) and desktop drag-and-drop; per-file upload progress; the document then appears in the inbox.
- **Scanner**: capture, crop and page review are unchanged. On *Done* the phone builds a plain **image-only PDF** (`pdf/build.ts` without the OCR layer) and posts it with `source: scanner`.
- **Offline**: because the server owns the durable queue, the PWA only needs to get bytes there once. A small IndexedDB queue holds uploads that haven't reached the server and retries them when back online. This replaces the branch's outbox / background-sync machinery, which existed only because classification used to happen inside the request.

### 4. Preparing and filing

**Preparing** (no keys needed):

- Image-only PDFs → `ocrmypdf --skip-text` → searchable PDF. `--skip-text` leaves pages that already have text alone; encrypted PDFs are passed through.
- Document photos (`isDocument: true`) → `img2pdf` (bundled with `ocrmypdf`) then OCR → searchable PDF, so the filed type, MIME and extension become PDF. Formats `sharp` can't decode (HEIC) stay as images.
- Ordinary photos, Office files and other types are kept as they are. The filename's extension always follows the **prepared** file.
- **Thumbnail** for the review card: the first page rendered with Ghostscript (installed with `ocrmypdf`) for PDFs, `sharp` for images, none otherwise; stored encrypted beside the blob.
- OCR failure or a 5-minute timeout files the original with a note: a text layer is never worth losing a document over.

**Filing** (needs a live session; otherwise `awaiting_login`):

1. Resolve the folder: an existing link ID, or for an approved new-folder proposal, **create the folder** under its parent, then refresh the folder cache.
2. Upload via `DriveClient.uploadFile(name + ext, bytes, mime, { parentFolderUid })` (the branch's extension; collisions via the SDK's `getAvailableName`, e.g. `name (1).pdf`).
3. Record an `audit_log` entry (ids and flags only), then delete the inbox blob.

**Folder cache**: `walkFolderTree` (built; lists 6 folders concurrently by default) runs at login, every 6 hours, on demand, and after a folder is created. The result — paths plus each folder's five recent filenames, nothing else — is cached **encrypted at rest** so analysis works while logged out.

**Settings** (a small `settings` table, editable in the PWA): never-file-here folder paths (default empty), and overrides for the auto-file threshold, model and effort (env vars supply the defaults).

**Docker**: add `ocrmypdf` (Tesseract, Ghostscript) to the Alpine image; measure the size impact in the plan.

### 5. Review and activity (PWA)

The home screen becomes an **inbox**, replacing the saved-scans list:

1. **Needs review** — a card per document: thumbnail (first page or image), the proposed name (editable inline), the proposed folder with a search-as-you-type picker over the cached tree (never-file-here folders hidden), a *New folder* badge for proposals, confidence and the one-line rationale, and **Approve / Edit / Discard**. Evolves from the branch's `ConfirmCard`.
2. **Waiting** — documents being received, analysed or prepared; a banner when documents are waiting for login.
3. **Recently filed** — name, folder, *auto* vs *you approved*, and a link to open it in Drive. The *auto* chip makes auto-filings easy to spot-check.
4. **Failed** — the reason, with **Retry** or **Discard**.
5. **Discarded** — the last 7 days, restorable.

Primary actions: **Add** and **Scan**. **Settings** sits behind a menu.

Updates: the PWA polls `GET /api/documents?since=<cursor>` every few seconds while visible.

**Edits teach the system**: when the user changes the name or folder before approving, *their* version is what gets filed, so it becomes one of that folder's recent filenames — the naming signal the next document in that folder sees. 

### 6. Errors and observability

| Failure | Handling |
|---|---|
| Anthropic 429 / 5xx / network | Jittered backoff, 3 attempts, then `failed` with *Retry* |
| Refusal, truncated or invalid answer | `needs_review` with the reason; never silently dropped |
| Unreadable file | Analysed from metadata, then review |
| OCR failure / timeout | Filed without a text layer, with a note |
| No live session | `awaiting_login` (not an error) |
| Drive upload failure / dead session | Retry, or `awaiting_login` when the refresh token is dead (`isAuthExpired` from the branch) |
| Crash mid-job | Working states reset at startup |

- **GlitchTip** (existing Sentry setup): a document reaching `failed`, analyzer errors, filing errors. Per [`docs/observability.md`](../../observability.md), document names, text and snippets never leave the server; each new field gets a scrubber test.
- **Logs**: per document, stage timings, model, tokens and cost, confidence and outcome (auto-filed / reviewed / edited).
- **`audit_log`**: one row per filing including user edits — the production data for re-tuning the threshold later.

## Model evaluation

**Built:** `server/evals/analyzer/` (runner, harness, sampler, summary, judge check). Inputs and results are personal documents and live only in the gitignored `.claude/hillclimb/analyzer/`.

**Method.** The ground truth is the user's own filing: 40 documents already in Drive, sampled at random from those filed since 2024 in active folders (at most three per folder; never-file-here folders excluded from sampling *and* from the model's folder list). Each case hides the document's original filename and removes it from its folder's recent names, so the model can't copy its own answer. Each contender runs the real analyzer.

- **Folder right** — exact match to the folder the user chose.
- **Name OK** — an LLM judge (Claude Fable 5.1, not a contender) decides whether the user would keep the proposed name. The rubric was calibrated against the user's own grades on a pilot: a name that identifies the document at least as well counts even when it departs from the folder's pattern, and a neighbouring date from the same document is fine; a wrong fact or a name too vague to single the document out is not. A judge self-check (`eval:analyzer:judge-check`) confirms it accepts the user's own names and rejects empty, wrong, generic and wrong-year names.
- **Full accept** — both. Plus auto-file precision and coverage across thresholds, under the real rule (existing folder required).

**Round 1** (1 rep, original prompt):

| Contender | Full accept | Folder | Name | $/doc |
|---|---|---|---|---|
| Haiku 5.5, low effort | 65% | 78% | 76% | 0.0031 |
| Haiku 5.5, medium | 75% | 85% | 84% | ~0.0032 |
| Sonnet 5.5, low | 75% | 90% | 78% | 0.058 |
| Opus 5.5, low | 83% | 93% | 84% | 0.12 |

Round 1 exposed a prompt bug: the `isDocument` instruction read as "photos aren't filed", and models returned an empty name and no folder for photos. It also showed the analyzer skipping encrypted PDFs that Claude can read. Both were fixed (`508fa80`, `f905c63`, `c42fad6`). Sonnet was dominated (Haiku-medium's accuracy at 20× the cost) and dropped.

**Round 2** (finalists, fixed prompt, 2 reps = 80 runs each):

| | Haiku 5.5, medium | Opus 5.5, low |
|---|---|---|
| Full accept | **83% ±8** | **83% ±8** |
| Folder right | 90% | 95% |
| Name OK | 88% | 84% |
| Paired difference per case | 0.0 pts, 95% CI ±11.6 (each better on 5 cases, 30 tied) | |
| At 0.80: auto-filed / precision | **53% / 100%** | 34% / 96% |
| Cost per document (cold cache) | **$0.0033** | $0.12 |
| Same verdict across reps | 36/40 | 38/40 |

**Conclusion:** Haiku 5.5 at medium effort. Equal accuracy, better calibration (more documents auto-filed at the same safety), ~37× cheaper — on the order of a dollar a year at this volume. Opus stays a config change away. The prompt fix moved Haiku more (+8 points) than switching to Opus would have.

**Caveats:** 40 cases is a ±8–15 point noise floor; one user's Drive; no Office documents in the sample. The eval stays in the repo as the regression check for analyzer changes and future model releases.

## Status of the branch

On `feat/ai-analyzer`, built and tested:

- `server/src/analyze/` — the analyzer (content, PDF, image, prompt, resolve), with unit tests.
- `server/src/drive/folder-tree.ts` — concurrent tree walk with recent filenames and never-file-here exclusion; `DriveClient.walkFolderTree` and `downloadFile`.
- `server/evals/analyzer/` — the model eval.

Carried over from `feat/phase-5-ai-organize` in implementation: the history migration `004` (table only; nothing writes to it until recall is built), `uploadFile`'s `parentFolderUid`, `isAuthExpired`, `ConfirmCard` (→ review card), and `pdf/build.ts` without the OCR layer. Superseded: `routes-classify.ts`, `routes-upload.ts`, `classify/haiku.ts` (word-box OCR), `outbox-drain.ts`, the background-sync service-worker listeners.

## Delivery slices

The plan should ship this in independently useful slices:

1. **Server pipeline** — `documents` table, inbox store, worker, intake endpoint, analyzer wired in, filing with auto-file, `awaiting_login`, settings. Usable through the API and a minimal list. Includes the **calibration check**: re-run the Haiku eval with the prompt stating 0.80 (about $1.20) before auto-filing is switched on; until it passes, everything goes to review.
2. **Review UI** — the inbox screen, review card, folder picker, discard/restore, activity log, settings screen.
3. **Preparing** — `ocrmypdf`, `img2pdf`, thumbnails, the Docker image.
4. **Entrypoints** — Add screen and offline upload queue; the scanner posting image-only PDFs.

## Open items for the plan

- Office text extraction library (pure JS preferred; check the 7-day release-age gate).
- `ocrmypdf` on Alpine: package availability and image-size delta.
- Drive SDK folder creation call and its collision behaviour.
- HKDF label and blob format for the inbox store; whether the folder-cache copy shares it.
- Retention purge: timer in the worker vs. at startup.
