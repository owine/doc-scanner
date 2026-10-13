# Combine and File With — Design Spec

**Date:** 2026-10-13
**Status:** Approved design; not yet planned
**Parent spec:** [`2026-10-09-ai-document-filing-design.md`](2026-10-09-ai-document-filing-design.md)
**Branch:** `feat/combine-and-file-with`

## Why this exists

Related documents arrive as separate uploads. The case that prompted this: a certified letter the user sent and its return receipt, uploaded one after the other, each analysed on its own. The user wants two different outcomes depending on the documents:

1. **Combine:** make them one PDF, analysed and filed once.
2. **File with:** keep them as separate files, in the same folder, with names that pair. This must work whether the partner is still in review or already filed (file the letter today, the receipt when it comes back).

These are separate actions. Neither touches a file already in Drive.

### Non-goals

- Appending pages to a file already in Drive (a new revision). "File with" a filed document files a second file beside it.
- Combining documents that aren't in review (still analysing, failed, filed).
- Detecting related documents automatically. The user says which ones belong together.
- Queuing these actions offline. Like Approve, they need the server.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where the actions start | A **⋯ More** menu on the review card: Combine with…, File with…, Re-analyze | No selection mode on the home screen; both pickers start from the document in hand. |
| What can be combined | 2–10 documents, all in `needs_review` | Only they are at rest with an analysis and prepared output; nothing else is mid-stage. |
| Combined bytes | A new PDF built with `@cantoo/pdf-lib` (already a server dependency) from each part's **prepared PDF when it has one**, else its original | Prepared PDFs already carry the OCR text layer, so `ocrmypdf --skip-text` skips those pages on the combined document. |
| What happens to the parts | `needs_review → discarded`, with `combined_into` pointing at the new row | Undo comes free: discard the combined document, restore the parts. |
| Combined document's `source` | The first part's source; "combined from N documents" goes in `source_context` | `documents.source` has a `CHECK` constraint; a new value would need a table rebuild, and the model reads `source_context` in `<arrival>` anyway. |
| How "File with" works | A re-analysis with an **anchor** (another document) in the prompt; the folder is **pinned in code** to the anchor's folder; the model only writes a paired name | One mechanism covers in-review and filed anchors; the folder can't drift. |
| Anchor lifetime | Snapshotted (name + folder) when requested, sealed on the row | The worker stays free of cross-row reads. A stale snapshot is harmless: the result is always reviewed. |
| Documents that may already be in Drive | Combine, File with and Re-analyze are all refused (`409 possibly_in_drive`) for a row with a filing target or an unverified upload (the view's `possiblyInDrive`); the menu hides them | Such a row can sit in `needs_review` (restored from `awaiting_login`, or sent back by `FolderNameTakenError`). `prepareStage` skips a row with a target, so re-analysing it would file the original with no text layer, and the file stage's SHA-1 check would miss an earlier upload of the prepared bytes, making a duplicate. Combining it could put its pages in Drive twice. |
| Review | A re-analysed document (anchored or not) always goes to review | The user asked for it from review; nothing should auto-file behind their back. |
| Re-preparing | Re-analysis goes back through `received`, so preparing (OCR) re-runs | Keeps the "every prepare run starts by clearing prepared state" rule. Costs seconds for a typical one- or two-page document. |
| Prompt for ordinary documents | Unchanged, byte for byte | The eval baseline and the prompt cache stay valid; the `<related>` block exists only when an anchor is set. |

## Architecture

### 1. Data (migration `008`)

```sql
-- combined_into: set on a part when it was combined into another document
--   (plaintext document id; cleared on restore).
-- anchor: sealed JSON {documentId, name, folder} for a "File with" re-analysis.
ALTER TABLE documents ADD COLUMN combined_into TEXT;
ALTER TABLE documents ADD COLUMN anchor BLOB;
```

- `anchor` is sealed like the row's other names and paths (AES-GCM, associated data bound to row id and column). An anchor that won't decrypt quarantines the row to `failed`, like any other sealed column.
- `DocumentRow` and `DocumentPatch` gain `combinedInto: string | null` and `anchor: Anchor | null`, where

```ts
interface Anchor {
  documentId: string;
  /** Without extension. */
  name: string;
  folder: Decision['folder']; // existing {linkId, path} or new {parentLinkId, parentPath, name}
}
```

- `DocumentView` gains `combinedInto` and `anchorName` (the anchor's name only).
- Repo: `anchor` joins `COLUMN`, `JSON_FIELDS` and `SEALED_COLUMNS`, so `quarantine()` clears it like the others. `combinedInto` joins `COLUMN` as plaintext.
- The `document_filed` audit entry (`file.ts`) gains `anchored: boolean`. An anchored filing approved unedited reports `userEdited: false` for a folder that code chose, not the model, so calibrating auto-filing must be able to leave these out.
- Parts discarded by a combine are purged with every other discarded row after 7 days, so the undo window is the discard retention.

### 2. Combine (server)

**Endpoint:** `POST /api/documents/combine`, body `{ ids: string[] }`, ordered, 2–10 distinct IDs.

**Building** (new `server/src/documents/combine.ts`, pure apart from the inbox reads it is given):

- For each part, in order:
  - `preparedMime === 'application/pdf'` and the prepared blob exists → copy its pages.
  - Otherwise, by original type:
    - PDF → copy its pages.
    - JPEG/PNG/WebP/TIFF/GIF/HEIF (sniffed, as in `prepare/`) → `sharp` rotates per EXIF and writes JPEG → embedded as one page sized to the image.
    - Anything else → refused.
- Refused, as `422 { error: 'cannot_combine', documentId, reason }`, where `reason` is one of:
  - `encrypted`: any encrypted PDF, including one locked only by an owner password. pdf-lib could decrypt that kind, but combining is refused so a locked document is never altered (user decision, 2026-10-13).
  - `signed`: a digitally signed PDF (`/AcroForm /SigFlags` bit 1). Copying its pages would break the signature.
  - `dynamic_form`: a dynamic XFA form (`/XFA` with `/NeedsRendering true`). Copying its pages would copy only the "Please wait…" placeholder.
  - `unreadable`: a corrupt PDF or undecodable image.
  - `unsupported_type`: text, Office and other non-page types.
  - `too_large`: the result is over the server's intake limit (`MAX_UPLOAD_BYTES` in `routes-documents.ts`, 50 MiB).

**Before building:** refuse with `409 possibly_in_drive` if any part has `possiblyInDrive`. Refuse with `too_large` if the parts' input sizes (the prepared blob where it will be used, else `size`) already exceed the limit, so ten large parts are never loaded into memory together.
- The prepared blob's size needs a new `InboxStore.size(id, kind)`, read from the file's stat. The ciphertext's fixed overhead is close enough for this check.
- The check after building stays, because a photo re-encoded as JPEG can grow.

**Writing:**

1. Build the PDF in memory; compute its SHA-256.
2. Generate the new row's id with a helper exported from the repo (today's generator, `randomBytes(12).toString('base64url')`, is private inside `insert()`), and put the blob in the inbox under it. If the server crashes before the commit, the blob has no row, and the hourly orphan sweep deletes it.
3. Call a new repo method, `insertCombined(id, newDoc, partIds)`. The repo has no transaction helper today and `insert()` makes its own id. The new method takes the pre-made id and wraps steps (a) and (b) in `BEGIN`/`COMMIT`/`ROLLBACK`. Every step is synchronous, so nothing can interleave.
   - (a) Insert the new row in `received`. It takes the first part's `source`, `originalName` null, `mime: 'application/pdf'`, and `sourceContext: "combined from N documents"`.
   - (b) Transition each part `needs_review → discarded` with `combinedInto` and `discardedAt` (compare-and-set).
4. If any compare-and-set fails, roll back, delete the blob and return `409 conflict`. Otherwise wake the worker and return the new document's view.

The combined document then takes the normal path: analyse → prepare (OCR skips the pages that already have text) → decide → review.

**Restore:** `/restore` of a part already works, since the part is plainly discarded with its blobs and analysis kept; its patch also clears `combinedInto`.

Restoring a part while the combined document still exists is allowed: the same pages are then in two documents. The activity row's "Combined into another document" label is the warning, and undo means discard the combined document and restore its parts.

### 3. Re-analyze and File with (server)

**Endpoint:** `POST /api/documents/:id/reanalyze`, body `{ anchorId?: string }`. The document must be in `needs_review` (else `409 not_in_review`).

**Anchor snapshot**, when `anchorId` is given:

| Anchor state | `name` | `folder` |
|---|---|---|
| `filed` | `filedName` without extension | existing `{ linkId: filingTarget.folderLinkId, path: filedFolderPath }` |
| `needs_review` | `decision.name ?? analysis.name` | `decision.folder ?? analysis.folder` (a proposed new folder is kept as the same `new` choice) |

Refused with `409 possibly_in_drive` when the document itself has `possiblyInDrive`.

Rejected with `409 invalid_anchor`:

- the document itself
- any other state
- an in-review anchor with neither a decision nor an analysis (an unusable outcome), or whose `decision.folder ?? analysis.folder` is null
- a filed anchor missing its filing target

Two documents that both carry the same new-folder proposal still end in one folder: when filing, `file.ts` reuses a folder that already exists by that name.

**Transition:** `needs_review → received`, with:

- the anchor stored (or `null` for a plain re-analyze)
- `analysis`, `decision`, `reviewReason`, `preparedMime`, `prepareNote` and `hasThumbnail` cleared
- `userEdited: false`, `attempts: 0`, `nextAttemptAt: now`

Then wake the worker.

**Analyzer:**

- `AnalyzeInput` gains `anchor?: { name: string; folderPath: string }`.
  - The path is resolved by `analyzeStage` from the folder cache at analysis time, so a renamed folder shows its current path.
  - An existing folder is looked up by `linkId`. A `new` folder is joined to its parent's current path the way `folderPath()` in `routes-documents.ts` does it (no `//` under the root).
  - If the folder (or a new folder's parent) is gone from the cache, the prompt falls back to the snapshot's path. The pairing name is still useful, and the folder is nulled after the call anyway (below).
- `formatArrival` adds a block before `File this document.`, only when the anchor is set:

```
<related>
The user says this document belongs with one filed as "{name}" in {folderPath}.
It will be filed in that same folder. Choose a filename that pairs with that name:
the same conventions, saying what this document is.
</related>
```

  The anchor's name is quoted with the same `quote()` as recent names.
- With no anchor, the prompt is byte-identical to today's.

**`analyzeStage`, after an `ok` outcome with an anchor:**

- Overwrite `analysis.folder` with the anchor's folder, refreshed from the cache.
- If that folder (for a `new` folder, its parent) is no longer in the cache, or is now under an excluded path, set it to `null`. The card asks for a folder, and the reason is `'the related document's folder is no longer available'`.
- Otherwise record `reviewReason: 'filed with another document'`. With no anchor, record `'re-analyzed'`.
- Reasons are fixed text: `decideStage` logs the recorded reason verbatim (`decide.ts:45`), and reasons never carry names. The card shows the anchor's name from `anchorName`.
- `decideStage` already keeps a recorded reason, so the document always goes to review.
- An unusable outcome keeps today's behaviour: no analysis, and the analyzer's reason.

### 4. PWA

- **`ReviewCard.tsx`:** a **⋯ More** button next to Approve/Discard opens a menu. The menu is not shown at all for a card with `possiblyInDrive`:
  - **Combine with…**: shown when another review card exists.
  - **File with…**: shown when another review card or a recently filed document exists.
  - **Re-analyze**: always shown. It calls `reanalyze(id)` straight away, with no sheet.
- **New `DocumentChooser.tsx`:** a sheet modelled on `FolderPicker` (search field, list, Cancel), with two modes.
  - *Combine:*
    - The current card is pinned as item 1. The other review cards are listed with thumbnail and proposed name, and can be checked.
    - Checked items get ↑/↓ to set page order.
    - The confirm button reads **Combine N**.
  - *File with:* single choice in two sections.
    - **In review:** the other review cards.
    - **Recently filed:** the 30 documents `groupDocuments` already keeps, so no new API.
    - Each row shows the name and folder path. Choosing one calls `reanalyze(id, anchorId)`.
- **`documents/api.ts`:** `combine(ids)` and `reanalyze(id, anchorId?)`.
- **Activity (`DocumentRows.tsx`, `labels.ts`):** a discarded document with `combinedInto` reads "Combined into another document" and keeps its Restore button.
- **"Filed with …"** (from `anchorName`) shows on the waiting row (`DocumentRows.tsx`) and on the review card (`ReviewCard.tsx`).
- After either action, `DocumentSync`'s next poll moves the card(s) out of review. Re-analysed cards come back when analysis finishes.

### 5. Errors

| Case | Response | PWA shows |
|---|---|---|
| A listed document moved on, or a discard raced the request | `409 conflict` / `not_in_review` / `invalid_anchor` | "Something changed; the list has been refreshed." The sheet stays open on a fresh list |
| A part or the document may already be in Drive | `409 possibly_in_drive` | "This document may already be in Drive, so it can't be changed." (The menu hides the actions, so this happens only in a race) |
| A part can't be combined | `422 cannot_combine` + `documentId`, `reason` | "‹name› can't be combined (password-protected / digitally signed / a dynamic form / unreadable / not a PDF or photo / too large together)." |
| Network failure | — | An error in the sheet with Retry; nothing is queued |

Logs carry document ids, counts and reasons, never names or paths. That is the same rule as the rest of the pipeline.

## Testing

**Server (vitest):**

- `combine.ts`:
  - page order
  - prepared PDF preferred over the original
  - a photo becomes one page
  - each refusal reason
  - the size cap
- Combine route:
  - happy path
  - transaction rollback, with the blob deleted, when one part's compare-and-set fails
  - `409` for parts not in review, and `possibly_in_drive` for a part with a filing target
  - the size check before building
  - restore clears `combinedInto`
- Re-analyze route:
  - each anchor source: filed; in review with a decision; in review with only an analysis; a new-folder proposal
  - each `invalid_anchor` case, and `possibly_in_drive`
  - fields cleared on the transition
- `analyzeStage`:
  - folder override for an anchor, with the path refreshed from the cache
  - a missing or excluded anchor folder (or new-folder parent) gives `null` plus the reason
  - no document name in any review reason
  - review reasons
  - an unusable outcome with an anchor
- Prompt:
  - `<related>` appears only with an anchor
  - a snapshot guard that the no-anchor prompt is unchanged
- Repo:
  - migration `008` applies
  - `anchor` seal/unseal round trip; a tampered `anchor` quarantines the row
  - `insertCombined` rolls back the insert when a part's compare-and-set fails
- File stage: the audit entry records `anchored`.

**PWA (happy-dom):**

- When each menu item is shown, and no menu for `possiblyInDrive`.
- `DocumentChooser`:
  - both modes
  - pinned first item and reordering
  - the filed section
  - error states

**Manual:** in the Docker image, with the certified letter and return receipt:

- Combine them, check the combined PDF's page order and text layer, then undo.
- File the letter, then *File with* the receipt against it, and check the same folder and paired name.
