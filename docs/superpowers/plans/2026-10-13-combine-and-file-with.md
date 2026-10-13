# Combine and File With Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user combine documents in review into one PDF, and re-analyze a document in review (optionally "with" another document in review or already filed) so that it lands in the same folder with a paired name.

**Architecture:**

- **Combine:** a new route builds one PDF with pdf-lib from each part's prepared PDF (else its original). One SQLite transaction inserts the new document and discards the parts into it (`combined_into`). The new document then takes the normal pipeline.
- **Re-analyze:** a route sends a review document back to `received`, with an optional sealed **anchor** snapshot. `analyzeStage` adds a `<related>` block to the prompt only when an anchor is set, pins the folder to the anchor's, and records a fixed review reason so the result is always reviewed.
- **PWA:** the review card gets a More menu and an inline `DocumentChooser`.

**Tech Stack:** TypeScript, Hono, `node:sqlite`, `@cantoo/pdf-lib`, `sharp`, vitest; PWA: Preact 11, @testing-library/preact, happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-13-combine-and-file-with-design.md`.

**Deviation from the spec:** migration `008` also adds `reanalyzed INTEGER` (0/1). A plain re-analyze has no anchor, and `analyzeStage` needs a marker to record `'re-analysed'`. Reusing `review_reason` would break the rule that a fresh analysis clears a stale reason (existing test "clears a review reason an earlier, unusable answer left"). Task 15 updates the spec to match.

---

## Before you start

- Work on the existing branch `feat/combine-and-file-with` (the spec commits are already on it).
- Node must be the `.nvmrc` version **for the vitest workers too**. `fnm use` alone is not enough. Run this once per shell:

  ```bash
  export PATH="$HOME/.local/share/fnm/node-versions/v$(cat .nvmrc)/installation/bin:$PATH"
  node -v   # v24.21.0
  ```

- Run tests:
  - Server, single file: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run <path>`. The loader is required.
  - PWA, single file: `cd pwa && pnpm exec vitest run <path>`.
  - Everything: `pnpm test` and `pnpm -r run typecheck` from the repo root.
- Commits are Conventional Commits with scopes, signed (the git config already does this), one logical change each.
- Rules that apply everywhere in this plan:
  - **Never log a document or folder name.** Log ids, counts and fixed reasons only.
  - **Review reasons are fixed text** (`decide.ts` logs them verbatim).

## File map

**Server: create**

| File | Responsibility |
|---|---|
| `server/src/migrations/008_combine_and_anchor.sql` | `combined_into`, `anchor`, `reanalyzed` columns |
| `server/src/documents/combine.ts` | `combineParts()`: builds one PDF from parts; pure apart from pdf-lib/sharp |
| `server/src/documents/folders.ts` | `folderPath()` (moved out of the routes file, shared) |
| `server/src/documents/anchor.ts` | `snapshotAnchor()` (route) and `currentAnchorFolder()` (analyze stage) |
| `server/tests/documents/combine.test.ts`, `server/tests/documents/anchor.test.ts` | Their tests |

**Server: modify**

| File | Change |
|---|---|
| `server/src/documents/types.ts` | `Anchor`; new `DocumentRow`/`DocumentPatch` fields |
| `server/src/documents/repo.ts` | Columns, sealing, `newDocumentId()`, `insertCombined()` |
| `server/src/documents/view.ts` | `possiblyInDrive()` helper; `combinedInto`, `anchorName` |
| `server/src/documents/inbox-store.ts` | `size()` |
| `server/src/prepare/tools.ts` | Export `SHARP_FORMATS` |
| `server/src/drive/folder-tree.ts` | Export `stripExtension` |
| `server/src/analyze/types.ts`, `server/src/analyze/prompt.ts` | `AnalyzeInput.anchor`; `<related>` block |
| `server/src/documents/stages/analyze.ts` | Anchor folder pinning and review reasons |
| `server/src/documents/stages/file.ts` | Audit `anchored` |
| `server/src/http/routes-documents.ts` | `POST /combine`, `POST /:id/reanalyze`; restore clears `combinedInto` |

**PWA: create**

| File | Responsibility |
|---|---|
| `pwa/src/ui/inbox/choose.ts` | Pure candidate filters and folder labels for the chooser (beside `labels.ts`, which it uses) |
| `pwa/src/ui/inbox/DocumentChooser.tsx` | Inline chooser: combine (multi + order) / file with (single) |
| `pwa/tests/ui/choose.test.ts`, `pwa/tests/ui/DocumentChooser.test.tsx`, `pwa/tests/ui/DocumentRows.test.tsx` | Their tests |

**PWA: modify**

| File | Change |
|---|---|
| `pwa/src/api.ts` | `ApiError.body` |
| `pwa/src/documents/types.ts`, `pwa/src/documents/api.ts` | New view fields; `combine`, `reanalyze` |
| `pwa/src/ui/inbox/DocumentRows.tsx` | Combined label; "Filed with" on waiting rows |
| `pwa/src/ui/inbox/ReviewCard.tsx` | More menu, chooser, Re-analyze |
| `pwa/src/ui/inbox/InboxScreen.tsx` | Wiring |
| `pwa/src/theme/theme.css` | Chooser styles |
| `pwa/tests/documents/fixtures.ts` | New fields |

**Docs:** `CLAUDE.md`, the spec.

---

### Task 1: Migration 008 and row plumbing

**Files:**
- Create: `server/src/migrations/008_combine_and_anchor.sql`
- Modify: `server/src/documents/types.ts`, `server/src/documents/repo.ts`, `server/src/documents/view.ts`
- Test: `server/tests/documents/repo.test.ts`, `server/tests/documents/view.test.ts`

- [ ] **Step 1: Write the failing repo tests**

In `server/tests/documents/repo.test.ts`, inside the describe block that defines `everything` (around line 309):

1. Add an anchor carrying `MARK` to `everything`, so the existing "no plaintext" and "round-trips every sealed field" tests cover it:

```ts
      anchor: { documentId: 'other', name: `${MARK} Letter`, folder: { kind: 'existing', linkId: 'BILLS', path: `/Bills/${MARK}` } },
```

2. Add `'anchor'` to the test's `SEALED` list (line 326):

```ts
    const SEALED = ['original_name', 'source_context', 'analysis', 'decision', 'filing_target', 'filed_name', 'filed_folder_path', 'review_reason', 'error', 'anchor'];
```

3. Add `anchor: null` to the quarantine test's `toMatchObject` (around line 400), after `filedName: null,`:

```ts
        anchor: null,
```

4. Add, after the quarantine test, a test that corrupts the anchor itself:

```ts
    it('quarantines a row whose anchor won\'t decrypt', () => {
      const r = repo();
      const a = r.insert(named());
      r.transition(a.id, 'received', 'needs_review', everything);
      db.prepare('UPDATE documents SET anchor = ? WHERE id = ?').run(new Uint8Array(40), a.id);
      expect(r.get(a.id)).toMatchObject({ state: 'failed', anchor: null, analysis: null });
    });
```

Then add a new test in the top-level describe:

```ts
  it('round-trips combinedInto and reanalyzed as plaintext, defaulting to null and false', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(r.get(a.id)).toMatchObject({ combinedInto: null, anchor: null, reanalyzed: false });
    r.transition(a.id, 'received', 'received', { combinedInto: 'XYZ', reanalyzed: true });
    expect(r.get(a.id)).toMatchObject({ combinedInto: 'XYZ', reanalyzed: true });
    const raw = db.prepare('SELECT combined_into, reanalyzed FROM documents WHERE id = ?').get(a.id);
    expect(raw).toEqual({ combined_into: 'XYZ', reanalyzed: 1 });
  });
```

- [ ] **Step 2: Write the failing view tests**

In `server/tests/documents/view.test.ts`:

1. Add the new fields to the `row()` builder, after `hasThumbnail: false,`:

```ts
  combinedInto: null,
  anchor: null,
  reanalyzed: false,
```

2. Add tests:

```ts
  it('shows what a document was combined into, and the name it is filed with, but not the anchor itself', () => {
    const v = toView(
      row({
        state: 'needs_review',
        combinedInto: 'C1',
        anchor: { documentId: 'A1', name: 'Certified letter', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } },
      }),
    );
    expect(v).toMatchObject({ combinedInto: 'C1', anchorName: 'Certified letter' });
    expect(v).not.toHaveProperty('anchor');
    expect(toView(row()).anchorName).toBeNull();
  });

  it('possiblyInDrive matches the view flag', () => {
    expect(possiblyInDrive(row({ state: 'needs_review', filingTarget: TARGET }))).toBe(true);
    expect(possiblyInDrive(row({ state: 'needs_review', uploadUnverified: true }))).toBe(true);
    expect(possiblyInDrive(row({ state: 'needs_review' }))).toBe(false);
    expect(possiblyInDrive(row({ state: 'filed', filingTarget: TARGET }))).toBe(false);
  });
```

3. Change the import to `import { possiblyInDrive, toView } from '../../src/documents/view.js';`.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/repo.test.ts tests/documents/view.test.ts`

Expected: FAIL. TypeScript-level failures (unknown `anchor` patch field, missing `possiblyInDrive` export) surface as runtime errors such as `unknown patch field anchor` and `possiblyInDrive is not a function`.

- [ ] **Step 4: Add the migration**

Create `server/src/migrations/008_combine_and_anchor.sql`:

```sql
-- Schema version 8: combining documents and filing one with another
-- (docs/superpowers/specs/2026-10-13-combine-and-file-with-design.md).
-- combined_into: on a part a combine discarded, the combined document's id.
--   Plaintext: an id only. Cleared on restore.
-- anchor: sealed JSON {documentId, name, folder}, the document a "File with"
--   re-analysis pairs this one with, as it was when asked. Sealed: it holds a
--   name and a path.
-- reanalyzed: the user asked for this document to be analysed again, so its
--   analysis always goes to review.
ALTER TABLE documents ADD COLUMN combined_into TEXT;
ALTER TABLE documents ADD COLUMN anchor BLOB;
ALTER TABLE documents ADD COLUMN reanalyzed INTEGER NOT NULL DEFAULT 0 CHECK (reanalyzed IN (0, 1));
```

- [ ] **Step 5: Add the types**

In `server/src/documents/types.ts`:

1. Change the first import to `import type { Analysis, FolderChoice, IngestSource } from '../analyze/types.js';`.
2. Add after `FilingTarget`:

```ts
/**
 * The document a "File with" re-analysis pairs this one with, as it was when
 * the user asked: its name (no extension) and folder. A snapshot, so the
 * worker never reads another row; the result is reviewed anyway.
 */
export interface Anchor {
  documentId: string;
  name: string;
  folder: FolderChoice;
}
```

3. Add to `DocumentRow`, after `uploadUnverified`:

```ts
  /** On a part a combine discarded: the combined document's id. */
  combinedInto: string | null;
  anchor: Anchor | null;
  /** The user asked for a fresh analysis: it always goes to review. */
  reanalyzed: boolean;
```

4. Add to `DocumentPatch`, after `discardedAt`:

```ts
  combinedInto?: string | null;
  anchor?: Anchor | null;
  reanalyzed?: boolean;
```

- [ ] **Step 6: Plumb the repo**

In `server/src/documents/repo.ts`:

1. `COLUMN`: add after `discardedAt: 'discarded_at',`:

```ts
  combinedInto: 'combined_into',
  anchor: 'anchor',
  reanalyzed: 'reanalyzed',
```

2. `JSON_FIELDS` becomes:

```ts
const JSON_FIELDS = new Set<keyof DocumentPatch>(['analysis', 'decision', 'filingTarget', 'anchor']);
```

3. `SEALED_COLUMNS`: append `'anchor',` after `'filed_folder_path',`. The doc comment above it already covers it, since it holds a name and a path. `quarantine()` builds its `SET` list from `SEALED_COLUMNS`, so a quarantined row loses its anchor with no further change.

4. `fromRow()`: add after `uploadUnverified: ...`:

```ts
    combinedInto: r.combined_into as string | null,
    anchor: json('anchor'),
    reanalyzed: r.reanalyzed === 1,
```

- [ ] **Step 7: Update the view**

In `server/src/documents/view.ts`:

1. Add above `toView`:

```ts
/** An upload was started: the document may already be in Drive (it can't be filed, combined or re-analysed safely). */
export function possiblyInDrive(d: DocumentRow): boolean {
  return d.state !== 'filed' && (d.filingTarget !== null || d.uploadUnverified);
}
```

2. In `toView`, replace the `possiblyInDrive:` line with `possiblyInDrive: possiblyInDrive(d),`.
3. Add after `discardedAt: d.discardedAt,`:

```ts
    combinedInto: d.combinedInto,
    // The name only: the anchor's folder and id stay on the server.
    anchorName: d.anchor?.name ?? null,
```

- [ ] **Step 8: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/repo.test.ts tests/documents/view.test.ts tests/db.test.ts && pnpm run typecheck`

Expected: PASS, and no type errors. `tests/db.test.ts` will fail until Step 8a.

- [ ] **Step 8a: Update `server/tests/db.test.ts`**

Three assertions pin the schema version at 7: the two `expect(v.v).toBe(7)` lines (around lines 25 and 39) and `expect(secondCount).toBe(7)` (around line 90). Change all three to `8`. Then add, after the migration 007 test:

```ts
  it('migration 008 adds documents.combined_into, anchor and reanalyzed', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cols = (db.prepare("SELECT name FROM pragma_table_info('documents')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['combined_into', 'anchor', 'reanalyzed']));
    db.prepare(
      `INSERT INTO documents (id, seq, created_at, updated_at, source, mime, size, sha256, state, next_attempt_at)
       VALUES ('d1', 1, 't', 't', 'picker', 'application/pdf', 10, 'abc', 'received', 't')`,
    ).run();
    expect(db.prepare('SELECT reanalyzed FROM documents WHERE id = ?').get('d1')).toEqual({ reanalyzed: 0 });
    expect(() => db.prepare('UPDATE documents SET reanalyzed = 2 WHERE id = ?').run('d1')).toThrow();
  });
```

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/db.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/migrations/008_combine_and_anchor.sql server/src/documents/types.ts server/src/documents/repo.ts server/src/documents/view.ts server/tests/documents/repo.test.ts server/tests/documents/view.test.ts server/tests/db.test.ts
git commit -m "feat(documents): store combined_into, a sealed anchor and reanalyzed"
```

---

### Task 2: `insertCombined` and shared id generation

**Files:**
- Modify: `server/src/documents/repo.ts`
- Test: `server/tests/documents/repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/documents/repo.test.ts`. Extend the existing import to `import { DocumentDataUnreadableError, DocumentRepo, newDocumentId } from '../../src/documents/repo.js';`.

```ts
describe('insertCombined', () => {
  const inReview = (r: DocumentRepo, sha: string) => {
    const d = r.insert(doc({ sha256: sha }));
    r.transition(d.id, 'received', 'needs_review');
    return d;
  };

  it('makes URL-safe ids of 16 characters', () => {
    repo(); // the file's afterEach closes the database repo() opened
    expect(newDocumentId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newDocumentId()).not.toBe(newDocumentId());
  });

  it('inserts the combined document under the given id and discards every part into it', () => {
    const r = repo();
    const a = inReview(r, 'a'.repeat(64));
    const b = inReview(r, 'b'.repeat(64));
    const id = newDocumentId();
    const made = r.insertCombined(id, doc({ sha256: 'c'.repeat(64), originalName: null, sourceContext: 'combined from 2 documents' }), [a.id, b.id]);
    expect(made).toMatchObject({ id, state: 'received', sourceContext: 'combined from 2 documents' });
    for (const p of [a, b]) {
      expect(r.get(p.id)).toMatchObject({ state: 'discarded', combinedInto: id, discardedAt: '2026-10-10T12:00:00.000Z' });
    }
  });

  it('changes nothing when a part has left review', () => {
    const r = repo();
    const a = inReview(r, 'a'.repeat(64));
    const b = r.insert(doc({ sha256: 'b'.repeat(64) })); // still received
    const id = newDocumentId();
    expect(r.insertCombined(id, doc({ sha256: 'c'.repeat(64) }), [a.id, b.id])).toBeNull();
    expect(r.get(id)).toBeNull();
    expect(r.get(a.id)).toMatchObject({ state: 'needs_review', combinedInto: null, discardedAt: null });
    expect(db.isTransaction).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/repo.test.ts -t insertCombined`

Expected: FAIL, because `newDocumentId` is not exported and `insertCombined` doesn't exist.

- [ ] **Step 3: Implement**

In `server/src/documents/repo.ts`:

1. Add above `class DocumentRepo`:

```ts
/** A new document id: 12 random bytes as 16 URL-safe characters (the inbox store's ID pattern). */
export function newDocumentId(): string {
  return randomBytes(12).toString('base64url');
}
```

2. Replace `insert()` with:

```ts
  insert(d: NewDocument): DocumentRow {
    const id = newDocumentId();
    this.insertRow(id, d);
    return this.get(id)!;
  }

  private insertRow(id: string, d: NewDocument): void {
    const t = iso(this.now());
    this.db
      .prepare(
        `INSERT INTO documents (id, seq, created_at, updated_at, source, original_name, mime, size, sha256,
                                source_context, state, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
      )
      .run(
        id,
        this.nextSeq(),
        t,
        t,
        d.source,
        this.seal(id, 'original_name', d.originalName),
        d.mime,
        d.size,
        d.sha256,
        this.seal(id, 'source_context', d.sourceContext),
        t,
      );
  }

  /**
   * Combine (spec §2): inserts the combined document under a pre-made id (its
   * blob is already in the inbox) and discards every part into it, all or
   * nothing. Null, with nothing changed, when a part has left review since
   * the caller read it. Every step is synchronous, so nothing interleaves.
   */
  insertCombined(id: string, d: NewDocument, partIds: readonly string[]): DocumentRow | null {
    this.db.exec('BEGIN');
    try {
      this.insertRow(id, d);
      const discardedAt = this.now();
      for (const partId of partIds) {
        if (!this.transition(partId, 'needs_review', 'discarded', { combinedInto: id, discardedAt })) {
          this.db.exec('ROLLBACK');
          return null;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get(id);
  }
```

- [ ] **Step 4: Run the repo tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/repo.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/documents/repo.ts server/tests/documents/repo.test.ts
git commit -m "feat(documents): insert a combined document and discard its parts atomically"
```

---

### Task 3: `InboxStore.size`

**Files:**
- Modify: `server/src/documents/inbox-store.ts`
- Test: `server/tests/documents/inbox-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('InboxStore', ...)` in `server/tests/documents/inbox-store.test.ts` (the file's `store()` helper builds a fresh store; `InboxBlobMissingError` is already imported):

```ts
  it('reports a blob\'s stored size, a little over its plaintext', () => {
    const s = store();
    s.put('doc1', 'prepared', new Uint8Array(1000));
    const size = s.size('doc1', 'prepared');
    expect(size).toBeGreaterThanOrEqual(1000);
    expect(size).toBeLessThan(1100);
  });

  it('throws InboxBlobMissingError for the size of a missing blob', () => {
    const s = store();
    expect(() => s.size('nope', 'prepared')).toThrow(InboxBlobMissingError);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/inbox-store.test.ts`

Expected: FAIL with `s.size is not a function`.

- [ ] **Step 3: Implement**

In `server/src/documents/inbox-store.ts`, add `statSync` to the `node:fs` import, and add after `has()`:

```ts
  /**
   * The blob's size on disk: the sealed bytes, a fixed few dozen over the
   * plaintext. Close enough for a size check before loading blobs.
   */
  size(id: string, kind: BlobKind): number {
    try {
      return statSync(this.path(id, kind)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new InboxBlobMissingError(id, kind);
      throw err;
    }
  }
```

- [ ] **Step 4: Run the test**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/inbox-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/documents/inbox-store.ts server/tests/documents/inbox-store.test.ts
git commit -m "feat(documents): read an inbox blob's stored size"
```

---

### Task 4: `combineParts`

**Files:**
- Create: `server/src/documents/combine.ts`
- Modify: `server/src/prepare/tools.ts` (export `SHARP_FORMATS`)
- Test: `server/tests/documents/combine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/documents/combine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { combineParts } from '../../src/documents/combine.js';

const MAX = 50 * 1024 * 1024;

async function pdf(sizes: number[], opts: { encrypt?: boolean } = {}): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const s of sizes) d.addPage([s, s]);
  if (opts.encrypt) d.encrypt({ ownerPassword: 'owner', userPassword: '' });
  return d.save();
}

const widths = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));
const part = (id: string, bytes: Uint8Array, mime = 'application/pdf') => ({ id, bytes, mime });

describe('combineParts', () => {
  it('copies every page, in the order given', async () => {
    const out = await combineParts([part('b', await pdf([200, 210])), part('a', await pdf([100]))], MAX);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(await widths(out.pdf)).toEqual([200, 210, 100]);
  });

  it('reads a PDF from its header on, as the preparation tools do', async () => {
    const body = await pdf([100]);
    const junk = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, ...body]);
    const out = await combineParts([part('a', junk), part('b', await pdf([150]))], MAX);
    expect(out.kind).toBe('ok');
  });

  it('makes a photo one page, upright, with its long edge the height of A4', async () => {
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const out = await combineParts([part('a', await pdf([100])), part('b', png, 'image/png')], MAX);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const page = (await PDFDocument.load(out.pdf)).getPage(1);
    expect(Math.round(page.getWidth())).toBe(842);
    expect(Math.round(page.getHeight())).toBe(421);
  });

  it('refuses an encrypted PDF, naming the part', async () => {
    const out = await combineParts([part('a', await pdf([100])), part('locked', await pdf([100], { encrypt: true }))], MAX);
    expect(out).toEqual({ kind: 'refused', documentId: 'locked', reason: 'encrypted' });
  });

  it('refuses a corrupt PDF or one with no header', async () => {
    const corrupt = new TextEncoder().encode('%PDF-1.7 this is not a pdf');
    expect(await combineParts([part('a', await pdf([100])), part('bad', corrupt)], MAX)).toEqual({ kind: 'refused', documentId: 'bad', reason: 'unreadable' });
    const noHeader = new TextEncoder().encode('hello');
    expect(await combineParts([part('x', noHeader), part('a', await pdf([100]))], MAX)).toEqual({ kind: 'refused', documentId: 'x', reason: 'unreadable' });
  });

  it('refuses a type that has no pages', async () => {
    const out = await combineParts([part('a', await pdf([100])), part('t', new TextEncoder().encode('notes'), 'text/plain')], MAX);
    expect(out).toEqual({ kind: 'refused', documentId: 't', reason: 'unsupported_type' });
  });

  it('refuses an image sharp may not decode here', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const out = await combineParts([part('a', await pdf([100])), part('s', svg, 'image/svg+xml')], MAX);
    expect(out).toMatchObject({ kind: 'refused', documentId: 's' });
  });

  it('reports a result over the size limit', async () => {
    expect(await combineParts([part('a', await pdf([100])), part('b', await pdf([100]))], 10)).toEqual({ kind: 'too_large' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/combine.test.ts`

Expected: FAIL with a module-not-found error for `combine.js`.

- [ ] **Step 3: Export `SHARP_FORMATS`**

In `server/src/prepare/tools.ts`, change `const SHARP_FORMATS = ...` to `export const SHARP_FORMATS = ...`, keeping its comment.

- [ ] **Step 4: Implement `combine.ts`**

Create `server/src/documents/combine.ts`:

```ts
import { PDFDocument } from '@cantoo/pdf-lib';
import sharp, { type OutputInfo } from 'sharp';
import { pdfFromHeader, SHARP_FORMATS } from '../prepare/tools.js';

/** A photo's page: its long edge is A4's height, in points. */
const PAGE_LONG_EDGE_PT = 842;
/** Photos are downscaled to this long edge first: about 200 dpi on that page. */
const MAX_IMAGE_EDGE_PX = 2339;

export type CombineRefusal = 'encrypted' | 'unreadable' | 'unsupported_type';

export interface CombinePart {
  id: string;
  bytes: Uint8Array;
  mime: string;
}

export type CombineResult =
  | { kind: 'ok'; pdf: Uint8Array }
  | { kind: 'refused'; documentId: string; reason: CombineRefusal }
  | { kind: 'too_large' };

/**
 * Spec §2: one PDF from the parts, in order. A PDF's pages are copied (read
 * from its `%PDF-` header on, like the preparation tools); a photo becomes
 * one page, upright and flattened onto white. An encrypted PDF can't have
 * its pages copied, and other types have no pages: those are refused,
 * naming the part, so the user can leave it out.
 */
export async function combineParts(parts: readonly CombinePart[], maxBytes: number): Promise<CombineResult> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const refusal =
      part.mime === 'application/pdf'
        ? await addPdf(out, part.bytes)
        : part.mime.startsWith('image/')
          ? await addImage(out, part.bytes)
          : 'unsupported_type';
    if (refusal) return { kind: 'refused', documentId: part.id, reason: refusal };
  }
  const pdf = await out.save();
  return pdf.byteLength > maxBytes ? { kind: 'too_large' } : { kind: 'ok', pdf };
}

async function addPdf(out: PDFDocument, bytes: Uint8Array): Promise<CombineRefusal | null> {
  const body = pdfFromHeader(bytes);
  if (!body) return 'unreadable';
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(body, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return 'unreadable';
  }
  if (src.isEncrypted) return 'encrypted';
  try {
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  } catch {
    return 'unreadable';
  }
  return null;
}

async function addImage(out: PDFDocument, bytes: Uint8Array): Promise<CombineRefusal | null> {
  let format: string | undefined;
  try {
    ({ format } = await sharp(bytes).metadata());
  } catch {
    return 'unreadable';
  }
  if (!format || !SHARP_FORMATS.has(format)) return 'unsupported_type';
  let jpeg: { data: Buffer; info: OutputInfo };
  try {
    jpeg = await sharp(bytes)
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    return 'unreadable';
  }
  const image = await out.embedJpg(jpeg.data);
  const scale = PAGE_LONG_EDGE_PT / Math.max(jpeg.info.width, jpeg.info.height);
  const width = jpeg.info.width * scale;
  const height = jpeg.info.height * scale;
  out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  return null;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/combine.test.ts tests/prepare`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/documents/combine.ts server/src/prepare/tools.ts server/tests/documents/combine.test.ts
git commit -m "feat(documents): build one PDF from several documents"
```

---

### Task 5: `POST /api/documents/combine`, and restore clears `combinedInto`

**Files:**
- Modify: `server/src/http/routes-documents.ts`
- Test: `server/tests/http/routes-documents.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/http/routes-documents.test.ts`:

1. Add `import { PDFDocument } from '@cantoo/pdf-lib';` and `import type { DocumentPatch } from '../../src/documents/types.js';` to the imports.
2. Add these helpers after `approve()`:

```ts
async function pdfPages(sizes: number[], opts: { encrypt?: boolean } = {}): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const s of sizes) d.addPage([s, s]);
  if (opts.encrypt) d.encrypt({ ownerPassword: 'o', userPassword: '' });
  return d.save();
}

/** A PDF in review with its original in the inbox (no prepared blob unless a test adds one). */
async function reviewPdf(pipeline: Pipeline, sha256: string, sizes: number[] = [100], over: DocumentPatch = {}, bytes?: Uint8Array) {
  const body = bytes ?? (await pdfPages(sizes));
  const doc = pipeline.repo.insert({ source: 'scanner', originalName: `${sha256}.pdf`, mime: 'application/pdf', size: body.length, sha256, sourceContext: null });
  pipeline.inbox.put(doc.id, 'original', body);
  pipeline.repo.transition(doc.id, 'received', 'needs_review', { analysis: ANALYSIS, preparedMime: 'application/pdf', ...over });
  return doc;
}

const widthsOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));

function combineReq(app: App, cookie: string, ids: unknown) {
  return app.request('/api/documents/combine', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
}
```

3. In the existing `'requires a login on every router'` test, add these two entries to its `routes` list:

```ts
      ['POST', '/api/documents/combine'],
      ['POST', '/api/documents/some-id/reanalyze'],
```

The reanalyze entry fails until Task 9 adds that route, because an unknown route answers 404, not 401. So add it in Task 9 Step 1 instead, and only the combine entry here.

4. Add the tests:

```ts
describe('POST /api/documents/combine', () => {
  it('combines the parts in the order given and discards them into the new document', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ca', [100]);
    const b = await reviewPdf(pipeline, 'cb', [200, 210]);
    const res = await combineReq(app, cookie, [b.id, a.id]);
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string };
    expect(view).toMatchObject({ state: 'received', source: 'scanner', originalName: null, mime: 'application/pdf' });
    expect(await widthsOf(pipeline.inbox.get(view.id, 'original'))).toEqual([200, 210, 100]);
    expect(pipeline.repo.get(view.id)?.sourceContext).toBe('combined from 2 documents');
    for (const p of [a, b]) expect(pipeline.repo.get(p.id)).toMatchObject({ state: 'discarded', combinedInto: view.id });
    await pipeline.worker.wake();
  });

  it('uses a part\'s prepared PDF when it has one', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'pa', [100]);
    pipeline.inbox.put(a.id, 'prepared', await pdfPages([300]));
    const b = await reviewPdf(pipeline, 'pb', [150]);
    const res = await combineReq(app, cookie, [a.id, b.id]);
    const view = (await res.json()) as { id: string };
    expect(await widthsOf(pipeline.inbox.get(view.id, 'original'))).toEqual([300, 150]);
    await pipeline.worker.wake();
  });

  it('rejects bad input', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ia');
    for (const ids of [[a.id], [a.id, a.id], Array.from({ length: 11 }, (_, i) => `x${i}`), 'nope']) {
      const res = await combineReq(app, cookie, ids);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_input' });
    }
  });

  it('404s an unknown part and 409s one not in review', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'na');
    expect((await combineReq(app, cookie, [a.id, 'nope'])).status).toBe(404);
    const r = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 1, sha256: 'nr', sourceContext: null });
    const res = await combineReq(app, cookie, [a.id, r.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_in_review' });
  });

  it('refuses a part that may already be in Drive', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'da');
    const b = await reviewPdf(pipeline, 'db', [100], { filingTarget: { folderLinkId: 'BILLS', name: 'x.pdf' } });
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'possibly_in_drive' });
  });

  it('names a part that cannot be combined', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ea');
    const b = await reviewPdf(pipeline, 'eb', [], {}, await pdfPages([100], { encrypt: true }));
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'cannot_combine', documentId: b.id, reason: 'encrypted' });
    expect(pipeline.repo.get(a.id)?.state).toBe('needs_review');
  });

  it('refuses parts too large together before reading them', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'la');
    const big = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 50 * 1024 * 1024, sha256: 'lb', sourceContext: null });
    pipeline.repo.transition(big.id, 'received', 'needs_review', { analysis: ANALYSIS });
    const get = vi.spyOn(pipeline.inbox, 'get');
    const res = await combineReq(app, cookie, [a.id, big.id]);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'cannot_combine', reason: 'too_large' });
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves no blob behind when a part moved on meanwhile', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'ra');
    const b = await reviewPdf(pipeline, 'rb');
    vi.spyOn(pipeline.repo, 'insertCombined').mockReturnValue(null);
    const res = await combineReq(app, cookie, [a.id, b.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
    expect(pipeline.inbox.listIds().sort()).toEqual([a.id, b.id].sort());
  });

  it('restoring a part puts it back in review and forgets what it was combined into', async () => {
    const { app, cookie, pipeline } = await setup();
    const a = await reviewPdf(pipeline, 'sa');
    const b = await reviewPdf(pipeline, 'sb');
    await combineReq(app, cookie, [a.id, b.id]);
    const res = await app.request(`/api/documents/${a.id}/restore`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(pipeline.repo.get(a.id)).toMatchObject({ state: 'needs_review', combinedInto: null });
    await pipeline.worker.wake();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-documents.test.ts -t combine`

Expected: FAIL. The new route answers 404, and `combinedInto` is not cleared on restore.

- [ ] **Step 3: Move `folderPath` to a shared module**

Create `server/src/documents/folders.ts`:

```ts
import type { FolderChoice } from '../analyze/types.js';

/** The folder's own path; for a new folder, the one it will have once created (so it is under its parent's). */
export function folderPath(folder: FolderChoice): string {
  if (folder.kind === 'existing') return folder.path;
  return `${folder.parentPath === '/' ? '' : folder.parentPath}/${folder.name}`;
}
```

In `routes-documents.ts`, delete the private `folderPath` function and add `import { folderPath } from '../documents/folders.js';`. A `Decision['folder']` is assignable to `FolderChoice`, since its extra `createdLinkId` is optional.

- [ ] **Step 4: Implement the route**

In `server/src/http/routes-documents.ts`:

1. Add imports:

```ts
import { combineParts } from '../documents/combine.js';
import { newDocumentId } from '../documents/repo.js';
import { possiblyInDrive, toView } from '../documents/view.js';
```

Replace the existing `toView` import with the third line.

2. Add next to `ApproveSchema`:

```ts
const CombineSchema = z.object({ ids: z.array(z.string().min(1)).min(2).max(10) }).strict();
```

3. Add the route inside `documentRoutes`, before `r.get('/', ...)`:

```ts
  // Spec §2: several documents in review become one PDF, analysed and filed once.
  r.post('/combine', async (c) => {
    const body = CombineSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success || new Set(body.data.ids).size !== body.data.ids.length) return c.json({ error: 'invalid_input' }, 400);
    const parts: DocumentRow[] = [];
    for (const id of body.data.ids) {
      const part = repo.get(id);
      if (!part) return c.json({ error: 'not_found' }, 404);
      parts.push(part);
    }
    if (parts.some((p) => p.state !== 'needs_review')) return c.json({ error: 'not_in_review' }, 409);
    // Combining one that may already be in Drive could put its pages there twice.
    if (parts.some(possiblyInDrive)) return c.json({ error: 'possibly_in_drive' }, 409);

    // A prepared PDF already has its text layer, so OCR skips those pages later.
    const usePrepared = (p: DocumentRow) => p.preparedMime === 'application/pdf' && inbox.has(p.id, 'prepared');
    // Checked before any blob is loaded, so ten large parts are never in memory together.
    const inputBytes = parts.reduce((n, p) => n + (usePrepared(p) ? inbox.size(p.id, 'prepared') : p.size), 0);
    if (inputBytes > MAX_UPLOAD_BYTES) return c.json({ error: 'cannot_combine', reason: 'too_large' }, 422);

    const result = await combineParts(
      parts.map((p) =>
        usePrepared(p)
          ? { id: p.id, bytes: inbox.get(p.id, 'prepared'), mime: 'application/pdf' }
          : { id: p.id, bytes: inbox.get(p.id, 'original'), mime: p.mime },
      ),
      MAX_UPLOAD_BYTES,
    );
    if (result.kind === 'too_large') return c.json({ error: 'cannot_combine', reason: 'too_large' }, 422);
    if (result.kind === 'refused') return c.json({ error: 'cannot_combine', documentId: result.documentId, reason: result.reason }, 422);

    const id = newDocumentId();
    inbox.put(id, 'original', result.pdf);
    let created: DocumentRow | null;
    try {
      created = repo.insertCombined(
        id,
        {
          source: parts[0]!.source,
          originalName: null,
          mime: 'application/pdf',
          size: result.pdf.byteLength,
          sha256: createHash('sha256').update(result.pdf).digest('hex'),
          sourceContext: `combined from ${parts.length} documents`,
        },
        // With the seqs as read: a part that changed during the build (even
        // one that left review and came back) makes the whole combine a conflict.
        parts.map((p) => ({ id: p.id, seq: p.seq })),
      );
    } catch (err) {
      inbox.deleteAll(id);
      throw err;
    }
    if (!created) {
      inbox.deleteAll(id);
      return c.json({ error: 'conflict' }, 409);
    }
    logger.info({ documentId: id, parts: parts.length }, 'documents combined');
    const view = toView(created);
    void worker.wake();
    return c.json(view, 201);
  });
```

4. In the `/restore` route's `repo.transition(...)` patch, add `combinedInto: null,` after `discardedAt: null,`.

- [ ] **Step 5: Run the route tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-documents.test.ts`

Expected: PASS, the whole file.

- [ ] **Step 6: Commit**

```bash
git add server/src/documents/folders.ts server/src/http/routes-documents.ts server/tests/http/routes-documents.test.ts
git commit -m "feat(server): combine documents in review into one"
```

---

### Task 6: Anchor snapshot and current folder

**Files:**
- Create: `server/src/documents/anchor.ts`
- Modify: `server/src/drive/folder-tree.ts` (export `stripExtension`)
- Test: `server/tests/documents/anchor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/documents/anchor.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, ANALYSIS, TREE } from './harness.js';
import { currentAnchorFolder, snapshotAnchor } from '../../src/documents/anchor.js';
import type { Anchor, DocumentPatch, DocumentState } from '../../src/documents/types.js';

let h: ReturnType<typeof makeHarness> | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function row(to: DocumentState, patch: DocumentPatch = {}) {
  h ??= makeHarness();
  const doc = h.add();
  h.repo.transition(doc.id, 'received', to, patch);
  return h.repo.get(doc.id)!;
}

const NEW = { kind: 'new' as const, parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Certified' };

describe('snapshotAnchor', () => {
  it('takes a filed document\'s name without extension and the folder it was filed in', () => {
    const a = row('filed', {
      filingTarget: { folderLinkId: 'BILLS', name: 'Certified letter.pdf' },
      filedName: 'Certified letter (1).pdf',
      filedFolderPath: '/Bills',
    });
    expect(snapshotAnchor(a)).toEqual({ documentId: a.id, name: 'Certified letter (1)', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } });
  });

  it('refuses a filed document without its filing target', () => {
    expect(snapshotAnchor(row('filed', { filedName: 'x.pdf', filedFolderPath: '/Bills' }))).toBeNull();
  });

  it('takes a document in review\'s decision before its analysis', () => {
    expect(snapshotAnchor(row('needs_review', { analysis: ANALYSIS }))).toMatchObject({ name: ANALYSIS.name, folder: ANALYSIS.folder });
    const decided = row('needs_review', { analysis: ANALYSIS, decision: { name: 'Edited', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } } });
    expect(snapshotAnchor(decided)).toMatchObject({ name: 'Edited', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } });
  });

  it('keeps a proposed new folder, and treats one already created as existing', () => {
    expect(snapshotAnchor(row('needs_review', { analysis: { ...ANALYSIS, folder: NEW } }))?.folder).toEqual(NEW);
    const created = row('needs_review', { analysis: ANALYSIS, decision: { name: 'n', folder: { ...NEW, createdLinkId: 'CERT' } } });
    expect(snapshotAnchor(created)?.folder).toEqual({ kind: 'existing', linkId: 'CERT', path: '/Bills/Certified' });
  });

  it('refuses one in review with no name or folder, and any other state', () => {
    expect(snapshotAnchor(row('needs_review'))).toBeNull();
    expect(snapshotAnchor(row('needs_review', { analysis: { ...ANALYSIS, folder: null } }))).toBeNull();
    expect(snapshotAnchor(row('received', { analysis: ANALYSIS }))).toBeNull();
    expect(snapshotAnchor(row('discarded', { analysis: ANALYSIS, discardedAt: new Date() }))).toBeNull();
  });
});

describe('currentAnchorFolder', () => {
  const anchor = (folder: Anchor['folder']): Anchor => ({ documentId: 'a', name: 'n', folder });
  const EXCLUDE = ['/Archive'];

  it('takes an existing folder\'s current path', () => {
    const renamed = TREE.map((f) => (f.linkId === 'BILLS' ? { ...f, path: '/Household/Bills' } : f));
    expect(currentAnchorFolder(anchor({ kind: 'existing', linkId: 'BILLS', path: '/Bills' }), renamed, EXCLUDE)).toEqual({
      kind: 'existing',
      linkId: 'BILLS',
      path: '/Household/Bills',
    });
  });

  it('is null for a folder that is gone or now never-file-here', () => {
    expect(currentAnchorFolder(anchor({ kind: 'existing', linkId: 'GONE', path: '/Gone' }), TREE, EXCLUDE)).toBeNull();
    expect(currentAnchorFolder(anchor({ kind: 'existing', linkId: 'ARCHIVE', path: '/Archive' }), TREE, EXCLUDE)).toBeNull();
  });

  it('checks a new folder by its parent, and where it would be', () => {
    expect(currentAnchorFolder(anchor(NEW), TREE, EXCLUDE)).toEqual(NEW);
    expect(currentAnchorFolder(anchor({ ...NEW, parentLinkId: 'GONE' }), TREE, EXCLUDE)).toBeNull();
    expect(currentAnchorFolder(anchor({ ...NEW, parentLinkId: 'ARCHIVE', parentPath: '/Archive' }), TREE, EXCLUDE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/anchor.test.ts`

Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Export `stripExtension`**

In `server/src/drive/folder-tree.ts`, change `function stripExtension` to `export function stripExtension`.

- [ ] **Step 4: Implement `anchor.ts`**

Create `server/src/documents/anchor.ts`:

```ts
import type { FolderChoice } from '../analyze/types.js';
import { isUnderAny, stripExtension } from '../drive/folder-tree.js';
import { folderPath } from './folders.js';
import type { Anchor, Decision, DocumentRow } from './types.js';

/**
 * What "File with" pairs a document with (spec §3), or null when `a` can't
 * be an anchor. A filed document gives the name it was filed under and the
 * folder it went to; one in review gives what would be filed now (the
 * decision, else the analysis). A new folder already created counts as
 * existing.
 */
export function snapshotAnchor(a: DocumentRow): Anchor | null {
  if (a.state === 'filed') {
    if (!a.filingTarget || !a.filedName || !a.filedFolderPath) return null;
    return {
      documentId: a.id,
      name: stripExtension(a.filedName),
      folder: { kind: 'existing', linkId: a.filingTarget.folderLinkId, path: a.filedFolderPath },
    };
  }
  if (a.state !== 'needs_review') return null;
  const name = a.decision?.name ?? a.analysis?.name;
  // Typed as the decision's folder: inferred from both, TypeScript would drop its createdLinkId.
  const f: Decision['folder'] | null | undefined = a.decision?.folder ?? a.analysis?.folder;
  if (!name || !f) return null;
  if (f.kind === 'new' && f.createdLinkId) {
    return { documentId: a.id, name, folder: { kind: 'existing', linkId: f.createdLinkId, path: folderPath(f) } };
  }
  const folder: FolderChoice =
    f.kind === 'existing'
      ? { kind: 'existing', linkId: f.linkId, path: f.path }
      : { kind: 'new', parentLinkId: f.parentLinkId, parentPath: f.parentPath, name: f.name };
  return { documentId: a.id, name, folder };
}

/**
 * The anchor's folder as the tree has it now, or null when it (or a new
 * folder's parent) is gone, or it is now under a never-file-here path.
 */
export function currentAnchorFolder(
  anchor: Anchor,
  tree: readonly { linkId: string; path: string }[],
  excludePaths: readonly string[],
): FolderChoice | null {
  const pathOf = new Map(tree.map((f) => [f.linkId, f.path]));
  const f = anchor.folder;
  let now: FolderChoice;
  if (f.kind === 'existing') {
    const path = pathOf.get(f.linkId);
    if (!path) return null;
    now = { kind: 'existing', linkId: f.linkId, path };
  } else {
    const parentPath = pathOf.get(f.parentLinkId);
    if (!parentPath) return null;
    now = { kind: 'new', parentLinkId: f.parentLinkId, parentPath, name: f.name };
  }
  return isUnderAny(folderPath(now), excludePaths) ? null : now;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/anchor.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/documents/anchor.ts server/src/drive/folder-tree.ts server/tests/documents/anchor.test.ts
git commit -m "feat(documents): snapshot a related document's name and folder"
```

---

### Task 7: The `<related>` prompt block

**Files:**
- Modify: `server/src/analyze/types.ts`, `server/src/analyze/prompt.ts`
- Test: `server/tests/analyze/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('formatArrival', ...)` in `server/tests/analyze/prompt.test.ts`:

```ts
  it('is unchanged for a document with no related one', () => {
    // A guard for the eval baseline and the prompt cache: only an anchor changes this text.
    expect(formatArrival({ ...input, originalName: 'statement.pdf' }, null)).toBe(
      ['<arrival>', 'source: picker', 'type: application/pdf', 'size: 10 bytes', 'original filename: statement.pdf', '</arrival>', 'File this document.'].join('\n'),
    );
  });

  it('asks for a name that pairs with the related document, after the arrival', () => {
    const text = formatArrival({ ...input, originalName: null, anchor: { name: 'Certified letter "A"', folderPath: '/Legal/Acme' } }, null);
    expect(text).toBe(
      [
        '<arrival>',
        'source: picker',
        'type: application/pdf',
        'size: 10 bytes',
        '</arrival>',
        '<related>',
        `The user says this document belongs with one filed as "Certified letter 'A'" in /Legal/Acme.`,
        'It will be filed in that same folder. Choose a filename that pairs with that name: the same conventions, saying what this document is.',
        '</related>',
        'File this document.',
      ].join('\n'),
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/analyze/prompt.test.ts`

Expected: the first new test PASSES (today's output), and the second FAILS (no `<related>` block).

- [ ] **Step 3: Implement**

In `server/src/analyze/types.ts`, add to `AnalyzeInput`, after `sourceContext`:

```ts
  /**
   * A document the user says this one belongs with ("File with"): the prompt
   * asks for a filename that pairs with its name. The caller pins the folder.
   */
  anchor?: { name: string; folderPath: string };
```

In `server/src/analyze/prompt.ts`, replace the end of `formatArrival`:

```ts
  lines.push('</arrival>', 'File this document.');
  return lines.join('\n');
```

with:

```ts
  lines.push('</arrival>');
  if (input.anchor) {
    lines.push(
      '<related>',
      `The user says this document belongs with one filed as ${quote(input.anchor.name)} in ${input.anchor.folderPath}.`,
      'It will be filed in that same folder. Choose a filename that pairs with that name: the same conventions, saying what this document is.',
      '</related>',
    );
  }
  lines.push('File this document.');
  return lines.join('\n');
```

- [ ] **Step 4: Run the tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/analyze`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyze/types.ts server/src/analyze/prompt.ts server/tests/analyze/prompt.test.ts
git commit -m "feat(analyzer): ask for a paired name when filing with a related document"
```

---

### Task 8: `analyzeStage` pins the anchor's folder and forces review

**Files:**
- Modify: `server/src/documents/stages/analyze.ts`
- Test: `server/tests/documents/stages.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/documents/stages.test.ts`. Add `import type { Anchor } from '../../src/documents/types.js';` to the imports.

```ts
describe('analyzeStage re-analysis', () => {
  const BILLS = { kind: 'existing' as const, linkId: 'BILLS', path: '/Bills' };
  const anchor = (folder: Anchor['folder'] = BILLS): Anchor => ({ documentId: 'letter', name: 'Certified letter to Northwind', folder });
  const ROOT_ANSWER = okOutcome({ ...ANALYSIS, name: 'Return receipt', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } });

  function reanalysing(a: Anchor | null) {
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'received', { anchor: a, reanalyzed: true });
    return h.repo.get(doc.id)!;
  }

  it('files with the anchor: its folder, a paired name asked for, and always reviewed', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue(ROOT_ANSWER);
    const doc = reanalysing(anchor());
    await analyzeStage(doc, h.ctx);
    expect(h.analyze.mock.calls[0][0].anchor).toEqual({ name: 'Certified letter to Northwind', folderPath: '/Bills' });
    expect(h.repo.get(doc.id)).toMatchObject({
      state: 'preparing',
      reviewReason: 'filed with another document',
      analysis: { name: 'Return receipt', folder: BILLS },
    });
  });

  it('uses the anchor folder\'s current path', async () => {
    h = makeHarness();
    h.ctx.folderCache.save(TREE.map((f) => (f.linkId === 'BILLS' ? { ...f, path: '/Household/Bills' } : f)), new Date());
    const doc = reanalysing(anchor());
    await analyzeStage(doc, h.ctx);
    expect(h.analyze.mock.calls[0][0].anchor.folderPath).toBe('/Household/Bills');
    expect(h.repo.get(doc.id)?.analysis?.folder).toEqual({ ...BILLS, path: '/Household/Bills' });
  });

  it('asks for a folder when the anchor\'s is gone or never-file-here', async () => {
    h = makeHarness();
    h.ctx.folderCache.save(TREE.filter((f) => f.linkId !== 'BILLS'), new Date());
    const gone = reanalysing(anchor());
    await analyzeStage(gone, h.ctx);
    // The snapshot's path still helps the name.
    expect(h.analyze.mock.calls[0][0].anchor.folderPath).toBe('/Bills');
    expect(h.repo.get(gone.id)).toMatchObject({ reviewReason: "the related document's folder is no longer available", analysis: { folder: null } });

    const excluded = reanalysing(anchor({ kind: 'existing', linkId: 'ARCHIVE', path: '/Archive' }));
    await analyzeStage(excluded, h.ctx);
    expect(h.repo.get(excluded.id)?.analysis?.folder).toBeNull();
  });

  it('keeps an anchor\'s proposed new folder', async () => {
    h = makeHarness();
    const NEW = { kind: 'new' as const, parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Certified' };
    const doc = reanalysing(anchor(NEW));
    await analyzeStage(doc, h.ctx);
    expect(h.analyze.mock.calls[0][0].anchor.folderPath).toBe('/Bills/Certified');
    expect(h.repo.get(doc.id)?.analysis?.folder).toEqual(NEW);
  });

  it('reviews a plain re-analysis, with no related block', async () => {
    h = makeHarness();
    const doc = reanalysing(null);
    await analyzeStage(doc, h.ctx);
    expect(h.analyze.mock.calls[0][0]).not.toHaveProperty('anchor');
    expect(h.repo.get(doc.id)).toMatchObject({ reviewReason: 're-analysed', analysis: { folder: BILLS } });
  });

  it('keeps the analyzer\'s reason for an unusable answer', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue({ ...okOutcome(), status: 'refusal', detail: 'declined (cyber)' });
    const doc = reanalysing(anchor());
    await analyzeStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ analysis: null, reviewReason: 'analysis refusal: declined (cyber)' });
  });

  it('then goes to review even when it could auto-file', async () => {
    h = makeHarness();
    const doc = reanalysing(anchor());
    await analyzeStage(doc, h.ctx);
    await prepareStage(h.repo.get(doc.id)!, h.ctx);
    decideStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('needs_review');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/stages.test.ts -t "re-analysis"`

Expected: FAIL. No anchor is sent, the folder is not pinned, and `reviewReason` is null.

- [ ] **Step 3: Implement**

Replace `server/src/documents/stages/analyze.ts` from the `const settings = ...` line to the end with the code below. Also add these imports at the top:

```ts
import type { FolderChoice } from '../../analyze/types.js';
import { currentAnchorFolder } from '../anchor.js';
import { folderPath } from '../folders.js';
```

```ts
  const settings = ctx.settings.get();
  const folders = toFolderContexts(cache.tree, { excludePaths: settings.excludePaths });
  // "File with" (spec §3): the folder is the anchor's as the tree has it now,
  // null if it has gone or become never-file-here since.
  const anchor = doc.anchor;
  const anchorFolder = anchor ? currentAnchorFolder(anchor, cache.tree, settings.excludePaths) : null;
  const started = Date.now();
  const outcome = await ctx.analyzerFor(settings).analyze(
    {
      bytes: ctx.inbox.get(doc.id, 'original'),
      mimeType: doc.mime,
      originalName: doc.originalName,
      source: doc.source,
      sourceContext: doc.sourceContext ?? undefined,
      // The snapshot's path when the folder is gone: the pairing name still helps.
      ...(anchor ? { anchor: { name: anchor.name, folderPath: folderPath(anchorFolder ?? anchor.folder) } } : {}),
    },
    folders,
  );
  logger.info(
    {
      documentId: doc.id,
      model: outcome.model,
      status: outcome.status,
      confidence: outcome.status === 'ok' ? outcome.analysis.confidence : undefined,
      anchored: anchor !== null,
      inputTokens: outcome.usage.input_tokens,
      cacheReadTokens: outcome.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: outcome.usage.cache_creation_input_tokens ?? 0,
      outputTokens: outcome.usage.output_tokens,
      durationMs: Date.now() - started,
    },
    'document analysed',
  );

  let moved: boolean;
  if (outcome.status === 'ok') {
    const { textSnippet: _unused, ...analysis } = outcome.analysis;
    // Pinned in code: the model only names a document filed with another.
    if (anchor) analysis.folder = anchorFolder;
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', {
      analysis,
      reviewReason: reanalysisReason(doc, anchorFolder),
      attempts: 0,
      error: null,
    });
  } else {
    // Still prepared, so the review card gets a thumbnail and the file its
    // text layer; decideStage then sends it to review with this reason.
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', {
      analysis: null,
      reviewReason: `analysis ${outcome.status}: ${outcome.detail}`,
      attempts: 0,
      error: null,
    });
  }
  if (!moved) ctx.repo.applyRequestedDiscard(doc.id);
}

/**
 * Why a re-analysed document goes to review whatever its confidence (the
 * user asked for it from review), or null for an ordinary one. Fixed text:
 * decideStage logs the reason as it is, and reasons never carry names.
 */
function reanalysisReason(doc: DocumentRow, anchorFolder: FolderChoice | null): string | null {
  if (doc.anchor) return anchorFolder ? 'filed with another document' : "the related document's folder is no longer available";
  return doc.reanalyzed ? 're-analysed' : null;
}
```

- [ ] **Step 4: Run the stage tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/stages.test.ts tests/documents/worker.test.ts`

Expected: PASS, including the existing "clears a review reason an earlier, unusable answer left" test.

- [ ] **Step 5: Commit**

```bash
git add server/src/documents/stages/analyze.ts server/tests/documents/stages.test.ts
git commit -m "feat(documents): file a re-analysed document with its anchor, always reviewed"
```

---

### Task 9: `POST /api/documents/:id/reanalyze`

**Files:**
- Modify: `server/src/http/routes-documents.ts`
- Test: `server/tests/http/routes-documents.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/http/routes-documents.test.ts`. `reviewPdf` comes from Task 5. Also add `['POST', '/api/documents/some-id/reanalyze'],` to the `'requires a login on every router'` routes list.

```ts
function reanalyzeReq(app: App, cookie: string, id: string, body?: unknown) {
  return app.request(`/api/documents/${id}/reanalyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function filedLetter(pipeline: Pipeline) {
  const doc = pipeline.repo.insert({ source: 'scanner', originalName: 'letter.pdf', mime: 'application/pdf', size: 1, sha256: 'letter', sourceContext: null });
  pipeline.repo.transition(doc.id, 'received', 'filed', {
    analysis: ANALYSIS,
    filingTarget: { folderLinkId: 'BILLS', name: 'Certified letter to Northwind.pdf' },
    filedName: 'Certified letter to Northwind.pdf',
    filedFolderPath: '/Bills',
    driveNodeUid: 'N1',
  });
  return doc;
}

describe('POST /api/documents/:id/reanalyze', () => {
  it('analyses a document in review again from scratch, and reviews the result', async () => {
    const { app, cookie, pipeline, analyze } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const doc = await reviewPdf(pipeline, 'plain', [100], { decision: { name: 'x', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } }, userEdited: true });
    const res = await reanalyzeReq(app, cookie, doc.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'received', analysis: null, decision: null, anchorName: null });
    await pipeline.worker.wake();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(pipeline.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reanalyzed: true, reviewReason: 're-analysed', userEdited: false });
  });

  it('files a document with a filed one: same folder, paired name asked for', async () => {
    const { app, cookie, pipeline, analyze } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const letter = filedLetter(pipeline);
    const receipt = await reviewPdf(pipeline, 'receipt');
    analyze.mockResolvedValue(okOutcome({ ...ANALYSIS, name: 'Certified letter to Northwind - return receipt', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } }));
    const res = await reanalyzeReq(app, cookie, receipt.id, { anchorId: letter.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'received', anchorName: 'Certified letter to Northwind' });
    await pipeline.worker.wake();
    expect(analyze.mock.calls.at(-1)![0].anchor).toEqual({ name: 'Certified letter to Northwind', folderPath: '/Bills' });
    expect(pipeline.repo.get(receipt.id)).toMatchObject({
      state: 'needs_review',
      reviewReason: 'filed with another document',
      analysis: { name: 'Certified letter to Northwind - return receipt', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } },
    });
  });

  it('files a document with another in review, using its current proposal', async () => {
    const { app, cookie, pipeline } = await setup();
    pipeline.folderCache.save(TREE, new Date());
    const letter = await reviewPdf(pipeline, 'rl');
    const receipt = await reviewPdf(pipeline, 'rr');
    const res = await reanalyzeReq(app, cookie, receipt.id, { anchorId: letter.id });
    expect(await res.json()).toMatchObject({ anchorName: ANALYSIS.name });
    expect(pipeline.repo.get(receipt.id)?.anchor).toEqual({ documentId: letter.id, name: ANALYSIS.name, folder: ANALYSIS.folder });
    await pipeline.worker.wake();
  });

  it('refuses an anchor that cannot be one', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = await reviewPdf(pipeline, 'ia');
    const noFolder = await reviewPdf(pipeline, 'ib', [100], { analysis: { ...ANALYSIS, folder: null } });
    const waiting = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 1, sha256: 'ic', sourceContext: null });
    for (const anchorId of [doc.id, noFolder.id, waiting.id, 'nope']) {
      const res = await reanalyzeReq(app, cookie, doc.id, { anchorId });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'invalid_anchor' });
    }
    expect(pipeline.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('refuses a document not in review, or one that may already be in Drive', async () => {
    const { app, cookie, pipeline } = await setup();
    const waiting = pipeline.repo.insert({ source: 'picker', originalName: null, mime: 'application/pdf', size: 1, sha256: 'na', sourceContext: null });
    expect(await (await reanalyzeReq(app, cookie, waiting.id)).json()).toEqual({ error: 'not_in_review' });
    const sent = await reviewPdf(pipeline, 'nb', [100], { filingTarget: { folderLinkId: 'BILLS', name: 'x.pdf' } });
    const res = await reanalyzeReq(app, cookie, sent.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'possibly_in_drive' });
    expect((await reanalyzeReq(app, cookie, 'nope')).status).toBe(404);
  });

  it('rejects a malformed body', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = await reviewPdf(pipeline, 'mb');
    for (const body of [{ anchorId: 5 }, { other: 1 }]) {
      const res = await reanalyzeReq(app, cookie, doc.id, body);
      expect(res.status).toBe(400);
    }
    const truncated = await app.request(`/api/documents/${doc.id}/reanalyze`, { method: 'POST', headers: { cookie }, body: '{"anchorId":' });
    expect(truncated.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-documents.test.ts -t reanalyze`

Expected: FAIL with 404 for the route.

- [ ] **Step 3: Implement**

In `server/src/http/routes-documents.ts`:

1. Add `import { snapshotAnchor } from '../documents/anchor.js';` and `import type { Anchor } from '../documents/types.js';`. You can merge the latter into the existing `../documents/types.js` type import.
2. Add next to `CombineSchema`:

```ts
const ReanalyzeSchema = z.object({ anchorId: z.string().min(1).optional() }).strict();
```

3. Add the route after `/:id/approve`:

```ts
  // Spec §3: analyse a document in review again, optionally "with" another
  // (filed, or in review), whose folder it then takes.
  r.post('/:id/reanalyze', async (c) => {
    // The body first: the row is read after the last await, so the checks
    // below see what the transition's compare-and-set will.
    // As for approve: only an empty body means "no anchor".
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_input' }, 400);
      }
    }
    const body = ReanalyzeSchema.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_input' }, 400);
    const doc = repo.get(c.req.param('id'));
    if (!doc) return c.json({ error: 'not_found' }, 404);
    if (doc.state !== 'needs_review') return c.json({ error: 'not_in_review' }, 409);
    // Preparing skips a row with a filing target, so re-analysing it would
    // file the original and miss the earlier upload's SHA-1: a duplicate.
    if (possiblyInDrive(doc)) return c.json({ error: 'possibly_in_drive' }, 409);

    let anchor: Anchor | null = null;
    if (body.data.anchorId !== undefined) {
      const other = body.data.anchorId === doc.id ? null : repo.get(body.data.anchorId);
      anchor = other ? snapshotAnchor(other) : null;
      if (!anchor) return c.json({ error: 'invalid_anchor' }, 409);
    }

    const moved = repo.transition(doc.id, 'needs_review', 'received', {
      anchor,
      reanalyzed: true,
      analysis: null,
      decision: null,
      reviewReason: null,
      preparedMime: null,
      prepareNote: null,
      hasThumbnail: false,
      userEdited: false,
      attempts: 0,
      error: null,
      nextAttemptAt: new Date(),
    });
    if (!moved) return c.json({ error: 'conflict' }, 409);
    logger.info({ documentId: doc.id, anchored: anchor !== null }, 'document re-analysis requested');
    const view = toView(repo.get(doc.id)!);
    void worker.wake();
    return c.json(view);
  });
```

- [ ] **Step 4: Run the route tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-documents.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes-documents.ts server/tests/http/routes-documents.test.ts
git commit -m "feat(server): re-analyse a document in review, optionally with another"
```

---

### Task 10: Audit records `anchored`

**Files:**
- Modify: `server/src/documents/stages/file.ts`
- Test: `server/tests/documents/file-stage.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/tests/documents/file-stage.test.ts`:

1. Extend the existing audit expectation (line 45) to include `anchored: false`.
2. Add:

```ts
  it('marks a filing whose folder came from a related document, so calibration can leave it out', async () => {
    h = makeHarness();
    const doc = filingDoc(EXISTING, { anchor: { documentId: 'letter', name: 'Letter', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } } });
    await fileStage(doc, h.ctx);
    const audit = h.db.prepare(`SELECT detail FROM audit_log WHERE event = 'document_filed'`).get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ anchored: true });
    expect(audit.detail).not.toContain('Letter');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/file-stage.test.ts`

Expected: FAIL, because `anchored` is missing.

- [ ] **Step 3: Implement**

In `server/src/documents/stages/file.ts`, in the audit `JSON.stringify({...})`, add after `userEdited: doc.userEdited,`:

```ts
            // The folder came from a related document, not the model: leave these out when calibrating.
            anchored: doc.anchor !== null,
```

- [ ] **Step 4: Run the test**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/documents/file-stage.test.ts`

Expected: PASS.

- [ ] **Step 5: Server-wide check, then commit**

Run: `cd server && pnpm test && pnpm run typecheck`

Expected: all PASS.

```bash
git add server/src/documents/stages/file.ts server/tests/documents/file-stage.test.ts
git commit -m "feat(documents): record anchored filings in the audit log"
```

---

### Task 11: PWA types, API client and error bodies

**Files:**
- Modify: `pwa/src/api.ts`, `pwa/src/documents/types.ts`, `pwa/src/documents/api.ts`, `pwa/tests/documents/fixtures.ts`
- Test: `pwa/tests/documents/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `pwa/tests/documents/api.test.ts`:

```ts
  it('combines documents in the order given', async () => {
    const fetch = stubFetch({ id: 'new' });
    await documentsApi.combine(['b', 'a']);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/documents/combine');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ ids: ['b', 'a'] });
  });

  it('re-analyses with or without an anchor', async () => {
    const fetch = stubFetch({ id: 'x' });
    await documentsApi.reanalyze('a/b');
    await documentsApi.reanalyze('x', 'letter');
    expect(fetch.mock.calls[0]![0]).toBe('/api/documents/a%2Fb/reanalyze');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({});
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ anchorId: 'letter' });
  });

  it('keeps the error body\'s other fields', async () => {
    stubFetch({ error: 'cannot_combine', documentId: 'd2', reason: 'encrypted' }, 422);
    await expect(documentsApi.combine(['a', 'b'])).rejects.toMatchObject({
      status: 422,
      code: 'cannot_combine',
      body: { error: 'cannot_combine', documentId: 'd2', reason: 'encrypted' },
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/documents/api.test.ts`

Expected: FAIL with `documentsApi.combine is not a function`.

- [ ] **Step 3: Implement**

`pwa/src/api.ts`:

1. Change the `ApiError` constructor:

```ts
class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    /** The error response's JSON object, for fields beyond `error` (empty if it wasn't one). */
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
```

2. In `request`, replace `const code = errorCode(text);` and the `new ApiError(...)` line with:

```ts
    const body = errorBody(text);
    const code = typeof body.error === 'string' ? body.error : undefined;
    const error = new ApiError(code ?? 'request_failed', res.status, code, body);
```

3. Replace `errorCode()` with:

```ts
function errorBody(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

`pwa/src/documents/types.ts`: add to `DocumentView`, after `hasThumbnail`:

```ts
  /** On a part a combine discarded: the combined document's id. */
  combinedInto: string | null;
  /** The name of the document this one is being filed with, if any. */
  anchorName: string | null;
```

`pwa/src/documents/api.ts`: add after `retry`:

```ts
  combine: (ids: string[]) =>
    request<DocumentView>('/api/documents/combine', { method: 'POST', body: JSON.stringify({ ids }) }),
  reanalyze: (id: string, anchorId?: string) =>
    request<DocumentView>(doc(id, '/reanalyze'), { method: 'POST', body: JSON.stringify(anchorId ? { anchorId } : {}) }),
```

`pwa/tests/documents/fixtures.ts`: in `makeDoc`, add after `hasThumbnail: false,`:

```ts
    combinedInto: null,
    anchorName: null,
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd pwa && pnpm exec vitest run tests/documents && pnpm run typecheck`

Expected: PASS. Fix any other `DocumentView` literals the typecheck reports by adding the two fields.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/api.ts pwa/src/documents/types.ts pwa/src/documents/api.ts pwa/tests/documents/fixtures.ts pwa/tests/documents/api.test.ts
git commit -m "feat(pwa): API client for combine and re-analyze"
```

---

### Task 12: Activity rows say "Combined" and "Filed with"

**Files:**
- Modify: `pwa/src/ui/inbox/DocumentRows.tsx`
- Test: `pwa/tests/ui/DocumentRows.test.tsx` (new)

- [ ] **Step 1: Write the failing tests**

Create `pwa/tests/ui/DocumentRows.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { DiscardedRow, WaitingRow } from '../../src/ui/inbox/DocumentRows.js';
import { makeDoc } from '../documents/fixtures.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');

describe('DocumentRows', () => {
  it('says a discarded part was combined into another document, and still offers Restore', () => {
    const doc = makeDoc({ state: 'discarded', discardedAt: NOW.toISOString(), combinedInto: 'c1' });
    render(<ul><DiscardedRow doc={doc} now={NOW} onRestore={vi.fn()} /></ul>);
    expect(screen.getByText(/Combined into another document · Deleted in 7 days/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('shows a plain discard as before', () => {
    const doc = makeDoc({ state: 'discarded', discardedAt: NOW.toISOString() });
    render(<ul><DiscardedRow doc={doc} now={NOW} onRestore={vi.fn()} /></ul>);
    expect(screen.getByText('Deleted in 7 days')).toBeInTheDocument();
  });

  it('says what a waiting document is being filed with', () => {
    render(<ul><WaitingRow doc={makeDoc({ state: 'analyzing', anchorName: 'Certified letter' })} onDiscard={vi.fn()} /></ul>);
    expect(screen.getByText('Filed with “Certified letter”')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/DocumentRows.test.tsx`

Expected: FAIL for the combined and filed-with texts.

- [ ] **Step 3: Implement**

In `pwa/src/ui/inbox/DocumentRows.tsx`:

1. In `WaitingRow`, add after the status `<div class="muted">…</div>`:

```tsx
        {doc.anchorName && <div class="muted">Filed with “{doc.anchorName}”</div>}
```

2. In `DiscardedRow`, replace `<div class="muted">Deleted in {days} {days === 1 ? 'day' : 'days'}</div>` with:

```tsx
        <div class="muted">
          {doc.combinedInto ? 'Combined into another document · ' : ''}Deleted in {days} {days === 1 ? 'day' : 'days'}
        </div>
```

- [ ] **Step 4: Run the tests**

Run: `cd pwa && pnpm exec vitest run tests/ui/DocumentRows.test.tsx tests/ui/InboxScreen.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/ui/inbox/DocumentRows.tsx pwa/tests/ui/DocumentRows.test.tsx
git commit -m "feat(pwa): label combined parts and documents filed with another"
```

---

### Task 13: `DocumentChooser`

**Files:**
- Create: `pwa/src/ui/inbox/choose.ts`, `pwa/src/ui/inbox/DocumentChooser.tsx`
- Modify: `pwa/src/theme/theme.css`
- Test: `pwa/tests/ui/choose.test.ts`, `pwa/tests/ui/DocumentChooser.test.tsx`

- [ ] **Step 1: Write the failing pure tests**

Create `pwa/tests/ui/choose.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { anchorCandidates, anchorFolder, combineCandidates, matches } from '../../src/ui/inbox/choose.js';
import { makeDoc } from '../documents/fixtures.js';

describe('choose', () => {
  const current = makeDoc();
  const other = makeDoc();
  const sent = makeDoc({ possiblyInDrive: true });
  const noFolder = makeDoc({ analysis: { ...makeDoc().analysis!, folder: null } });
  const filed = makeDoc({ state: 'filed', filed: { name: 'Certified letter.pdf', folderPath: '/Legal', driveNodeUid: 'n', driveUrl: null } });

  it('offers other review cards that are not possibly in Drive for combining', () => {
    expect(combineCandidates(current, [current, other, sent]).map((d) => d.id)).toEqual([other.id]);
  });

  it('offers review cards with a folder, and filed documents with a name and folder, as anchors', () => {
    const c = anchorCandidates(current, [current, other, noFolder, sent], [filed, makeDoc({ state: 'filed', filed: null })]);
    expect(c.review.map((d) => d.id)).toEqual([other.id, sent.id]);
    expect(c.filed.map((d) => d.id)).toEqual([filed.id]);
  });

  it('labels an anchor by where it is or would be filed', () => {
    expect(anchorFolder(filed)).toBe('/Legal');
    expect(anchorFolder(other)).toBe('/Bills/Energy');
    expect(anchorFolder(noFolder)).toBeNull();
  });

  it('matches a search on name or folder, ignoring case', () => {
    expect(matches(filed, 'legal')).toBe(true);
    expect(matches(filed, 'CERTIFIED')).toBe(true);
    expect(matches(filed, 'water')).toBe(false);
    expect(matches(filed, '  ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/choose.test.ts`

Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Implement `choose.ts`**

Create `pwa/src/ui/inbox/choose.ts`:

```ts
import type { DocumentView } from '../../documents/types.js';
import { displayName, folderLabel } from './labels.js';

/** Other cards in review that can be combined with `current`. The server refuses one that may be in Drive. */
export function combineCandidates(current: DocumentView, review: readonly DocumentView[]): DocumentView[] {
  return review.filter((d) => d.id !== current.id && !d.possiblyInDrive);
}

/** Where an anchor is filed, or would be: null when it has no folder (the server refuses those). */
export function anchorFolder(d: DocumentView): string | null {
  if (d.state === 'filed') return d.filed?.folderPath ?? null;
  const f = d.decision?.folder ?? d.analysis?.folder;
  return f ? folderLabel(f) : null;
}

/** What "File with" can pair `current` with: other review cards, and recently filed documents. */
export function anchorCandidates(current: DocumentView, review: readonly DocumentView[], filed: readonly DocumentView[]) {
  return {
    review: review.filter((d) => d.id !== current.id && anchorFolder(d) !== null),
    filed: filed.filter((d) => d.filed?.name && anchorFolder(d) !== null),
  };
}

export function matches(d: DocumentView, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${displayName(d)} ${anchorFolder(d) ?? ''}`.toLowerCase().includes(q);
}
```

Run: `cd pwa && pnpm exec vitest run tests/ui/choose.test.ts`

Expected: PASS.

- [ ] **Step 4: Write the failing component tests**

Create `pwa/tests/ui/DocumentChooser.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { DocumentChooser } from '../../src/ui/inbox/DocumentChooser.js';
import { ApiError } from '../../src/api.js';
import { makeDoc } from '../documents/fixtures.js';

const letter = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Certified letter' } });
const receipt = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Return receipt' } });
const bill = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Water bill' } });
const filed = makeDoc({ state: 'filed', filed: { name: 'Lease.pdf', folderPath: '/Home', driveNodeUid: 'n', driveUrl: null } });

function renderChooser(mode: 'combine' | 'file-with', over: Partial<Parameters<typeof DocumentChooser>[0]> = {}) {
  const props = {
    mode,
    current: letter,
    review: [letter, receipt, bill],
    filed: [filed],
    onCombine: vi.fn(async () => {}),
    onFileWith: vi.fn(async () => {}),
    onCancel: vi.fn(),
    ...over,
  };
  render(<DocumentChooser {...props} />);
  return props;
}

describe('DocumentChooser: combine', () => {
  it('pins the current card first and combines in the chosen order', async () => {
    const p = renderChooser('combine');
    const confirm = screen.getByRole('button', { name: /^Combine/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    const order = screen.getByRole('list', { name: 'Page order' });
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Certified letter'),
      expect.stringContaining('Water bill'),
      expect.stringContaining('Return receipt'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Return receipt up' }));
    expect(screen.queryByRole('button', { name: 'Move Certified letter up' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Combine 3' }));
    await waitFor(() => expect(p.onCombine).toHaveBeenCalledWith([letter.id, receipt.id, bill.id]));
  });

  it('names the part that cannot be combined', async () => {
    renderChooser('combine', {
      onCombine: vi.fn().mockRejectedValue(new ApiError('cannot_combine', 422, 'cannot_combine', { error: 'cannot_combine', documentId: receipt.id, reason: 'encrypted' })),
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('“Return receipt” can’t be combined: it is password-protected.');
  });

  it('says the list changed on a conflict, and when the server is unreachable', async () => {
    const onCombine = vi.fn().mockRejectedValueOnce(new ApiError('conflict', 409, 'conflict')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderChooser('combine', { onCombine });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something changed; the list has been refreshed.');
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server. Try again.'));
  });
});

describe('DocumentChooser: file with', () => {
  it('lists review cards and recently filed documents, and files with the one chosen', async () => {
    const p = renderChooser('file-with');
    expect(screen.queryByRole('button', { name: /Certified letter/ })).toBeNull(); // not itself
    expect(screen.getByRole('heading', { name: 'In review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recently filed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Lease\.pdf.*\/Home/ }));
    await waitFor(() => expect(p.onFileWith).toHaveBeenCalledWith(filed.id));
  });

  it('narrows the lists by search', () => {
    renderChooser('file-with');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'water' } });
    expect(screen.getByRole('button', { name: /Water bill/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Return receipt/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lease/ })).toBeNull();
  });

  it('cancels', () => {
    const p = renderChooser('file-with');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/DocumentChooser.test.tsx`

Expected: FAIL with a module-not-found error.

- [ ] **Step 6: Implement `DocumentChooser.tsx`**

Create `pwa/src/ui/inbox/DocumentChooser.tsx`:

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api.js';
import type { DocumentView } from '../../documents/types.js';
import { anchorCandidates, anchorFolder, combineCandidates, matches } from './choose.js';
import { displayName } from './labels.js';

export type ChooserMode = 'combine' | 'file-with';

export interface DocumentChooserProps {
  mode: ChooserMode;
  current: DocumentView;
  /** Every card in review (the current one included; it is left out here). */
  review: DocumentView[];
  /** Recently filed documents, offered by File with. */
  filed: DocumentView[];
  /** Called with every id to combine, the current card's first. */
  onCombine: (ids: string[]) => Promise<void>;
  onFileWith: (anchorId: string) => Promise<void>;
  onCancel: () => void;
}

const REFUSAL: Record<string, string> = {
  encrypted: 'it is password-protected',
  signed: 'it is digitally signed',
  dynamic_form: 'it is a dynamic form that can’t be copied',
  unreadable: 'it could not be read',
  unsupported_type: 'it is not a PDF or photo',
};

function errorText(err: unknown, docs: readonly DocumentView[]): string {
  if (!(err instanceof ApiError)) return 'Could not reach the server. Try again.';
  switch (err.code) {
    case 'cannot_combine': {
      if (err.body.reason === 'too_large') return 'These documents are too large to combine.';
      const part = docs.find((d) => d.id === err.body.documentId);
      const why = REFUSAL[String(err.body.reason)] ?? 'it could not be read';
      return part ? `“${displayName(part)}” can’t be combined: ${why}.` : `One document can’t be combined: ${why}.`;
    }
    case 'possibly_in_drive':
      return 'This document may already be in Drive, so it can’t be changed.';
    case 'conflict':
    case 'not_in_review':
    case 'invalid_anchor':
    case 'not_found':
      return 'Something changed; the list has been refreshed.';
    default:
      return 'Could not do that. Try again.';
  }
}

/** Inline in the review card, like the folder picker: Combine with… or File with…. */
export function DocumentChooser({ mode, current, review, filed, onCombine, onFileWith, onCancel }: DocumentChooserProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);

  const all = [current, ...review, ...filed];
  const byId = new Map(all.map((d) => [d.id, d]));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err, all));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }
  function move(id: string, by: -1 | 1) {
    setChosen((c) => {
      const i = c.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const next = [...c];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  const row = (d: DocumentView) => (
    <>
      {displayName(d)}
      {anchorFolder(d) && <span class="muted"> · {anchorFolder(d)}</span>}
    </>
  );
  const anchors = anchorCandidates(current, review, filed);
  const section = (title: string, docs: DocumentView[]) =>
    docs.length > 0 && (
      <>
        <h4>{title}</h4>
        <ul class="folder-results">
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" class="folder-result" disabled={busy} onClick={() => void run(() => onFileWith(d.id))}>
                {row(d)}
              </button>
            </li>
          ))}
        </ul>
      </>
    );

  return (
    <div class="doc-chooser" role="group" aria-label={mode === 'combine' ? 'Combine with other documents' : 'File with another document'}>
      <input
        ref={searchRef}
        type="search"
        aria-label="Search documents"
        placeholder="Search documents"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      <div role="alert">{error && <p class="error-text">{error}</p>}</div>

      {mode === 'combine' ? (
        <>
          <ol class="folder-results chooser-order" aria-label="Page order">
            {[current.id, ...chosen].map((id, i) => {
              const d = byId.get(id)!;
              return (
                <li key={id}>
                  <span class="chooser-option">
                    {i + 1}. {displayName(d)}
                  </span>
                  {i > 0 && (
                    <>
                      <button type="button" class="btn btn-secondary btn-small btn-square" disabled={i === 1} aria-label={`Move ${displayName(d)} up`} onClick={() => move(id, -1)}>
                        ↑
                      </button>
                      <button type="button" class="btn btn-secondary btn-small btn-square" disabled={i === chosen.length} aria-label={`Move ${displayName(d)} down`} onClick={() => move(id, 1)}>
                        ↓
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          <ul class="folder-results" aria-label="Documents in review">
            {combineCandidates(current, review)
              .filter((d) => matches(d, query))
              .map((d) => (
                <li key={d.id}>
                  <label class="chooser-option">
                    <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => toggle(d.id)} />
                    <span>{row(d)}</span>
                  </label>
                </li>
              ))}
          </ul>
          <div class="actions">
            <button type="button" class="btn" disabled={busy || chosen.length === 0} onClick={() => void run(() => onCombine([current.id, ...chosen]))}>
              Combine {chosen.length + 1}
            </button>
            <button type="button" class="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {section('In review', anchors.review.filter((d) => matches(d, query)))}
          {section('Recently filed', anchors.filed.filter((d) => matches(d, query)))}
          <button type="button" class="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
```

Note: the useEffect focus mirrors `FolderPicker` (the focus happens after paint, which is fine here; nothing must stop at unmount).

- [ ] **Step 7: Add the styles**

Append to the picker block in `pwa/src/theme/theme.css` (after `.new-folder`):

```css
.doc-chooser { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.doc-chooser h4 { margin: 4px 0 0; font-size: 14px; }
.chooser-option {
  flex: 1; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  min-height: 44px; box-sizing: border-box; overflow-wrap: anywhere; cursor: pointer;
}
```

- [ ] **Step 8: Run the tests**

Run: `cd pwa && pnpm exec vitest run tests/ui/choose.test.ts tests/ui/DocumentChooser.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add pwa/src/ui/inbox/choose.ts pwa/src/ui/inbox/DocumentChooser.tsx pwa/src/theme/theme.css pwa/tests/ui/choose.test.ts pwa/tests/ui/DocumentChooser.test.tsx
git commit -m "feat(pwa): chooser for combining documents and filing one with another"
```

---

### Task 14: More menu on the review card, wired into the inbox

**Files:**
- Modify: `pwa/src/ui/inbox/ReviewCard.tsx`, `pwa/src/ui/inbox/InboxScreen.tsx`
- Test: `pwa/tests/ui/ReviewCard.test.tsx`, `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Write the failing ReviewCard tests**

Add to `pwa/tests/ui/ReviewCard.test.tsx`:

```tsx
describe('ReviewCard more menu', () => {
  function renderWithMenu(doc = makeDoc(), review = [doc, makeDoc()], filed: ReturnType<typeof makeDoc>[] = []) {
    const onCombine = vi.fn(async () => {});
    const onReanalyze = vi.fn(async () => {});
    render(
      <ReviewCard doc={doc} folders={folders} onApprove={vi.fn()} onDiscard={vi.fn()} review={review} filed={filed} onCombine={onCombine} onReanalyze={onReanalyze} />,
    );
    return { onCombine, onReanalyze };
  }

  it('offers Combine with…, File with… and Re-analyse', async () => {
    const { onReanalyze } = renderWithMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Combine with…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File with…' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyse' }));
    await waitFor(() => expect(onReanalyze).toHaveBeenCalledWith());
  });

  it('hides Combine with… and File with… when there is nothing to pick', () => {
    const doc = makeDoc();
    renderWithMenu(doc, [doc]);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('button', { name: 'Combine with…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'File with…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Re-analyse' })).toBeInTheDocument();
  });

  it('has no menu for a document that may already be in Drive', () => {
    renderWithMenu(makeDoc({ possiblyInDrive: true }));
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('opens the chooser and files with the document picked', async () => {
    const doc = makeDoc();
    const other = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Certified letter' } });
    const { onReanalyze } = renderWithMenu(doc, [doc, other]);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'File with…' }));
    fireEvent.click(screen.getByRole('button', { name: /Certified letter/ }));
    await waitFor(() => expect(onReanalyze).toHaveBeenCalledWith(other.id));
  });

  it('says what the document is being filed with', () => {
    renderWithMenu(makeDoc({ anchorName: 'Certified letter' }));
    expect(screen.getByText('Filed with “Certified letter”')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/ReviewCard.test.tsx`

Expected: FAIL, since there is no More button.

- [ ] **Step 3: Implement in `ReviewCard.tsx`**

1. Add imports:

```ts
import { anchorCandidates, combineCandidates } from './choose.js';
import { DocumentChooser, type ChooserMode } from './DocumentChooser.js';
```

Update the existing type import to include `DocumentView`; it already does.

2. Extend `ReviewCardProps`:

```ts
  /** Every card in review, and recently filed documents: what Combine with… and File with… offer. */
  review?: DocumentView[];
  filed?: DocumentView[];
  onCombine?: (ids: string[]) => Promise<void>;
  /** Re-analyze, or with an anchor id, File with. */
  onReanalyze?: (anchorId?: string) => Promise<void>;
```

3. Change the signature to `export function ReviewCard({ doc, folders, onApprove, onDiscard, review = [], filed = [], onCombine, onReanalyze }: ReviewCardProps) {` and add state:

```ts
  const [menu, setMenu] = useState(false);
  const [choosing, setChoosing] = useState<ChooserMode | null>(null);
  const canCombine = !!onCombine && combineCandidates(doc, review).length > 0;
  const anchors = anchorCandidates(doc, review, filed);
  const canFileWith = anchors.review.length + anchors.filed.length > 0;
```

4. Add a handler next to `discard()`:

```ts
  async function reanalyze() {
    if (!onReanalyze) return;
    setBusy(true);
    setError(null);
    try {
      await onReanalyze();
    } catch {
      setError('Could not re-analyse. Try again.');
    } finally {
      setBusy(false);
    }
  }
```

5. Under the confidence `<p>` block, add:

```tsx
      {doc.anchorName && <p class="muted">Filed with “{doc.anchorName}”</p>}
```

6. Replace the `<div class="actions">…</div>` block with the code below. The server refuses a card that may be in Drive, so it gets no menu at all.

```tsx
      <div class="actions">
        <button class="btn" disabled={busy || !name.trim() || !folder} onClick={() => void approve()}>
          Approve
        </button>
        <button class="btn btn-secondary" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
        {onReanalyze && !doc.possiblyInDrive && (
          <button
            class="btn btn-secondary"
            aria-expanded={menu}
            aria-controls={`more-${doc.id}`}
            disabled={busy}
            onClick={() => {
              setMenu((m) => !m);
              setChoosing(null);
            }}
          >
            <span aria-hidden="true">⋯ </span>More
          </button>
        )}
      </div>
      {menu && !choosing && onReanalyze && (
        <div class="actions" id={`more-${doc.id}`}>
          {canCombine && (
            <button class="btn btn-secondary btn-small" disabled={busy} onClick={() => setChoosing('combine')}>
              Combine with…
            </button>
          )}
          {canFileWith && (
            <button class="btn btn-secondary btn-small" disabled={busy} onClick={() => setChoosing('file-with')}>
              File with…
            </button>
          )}
          <button class="btn btn-secondary btn-small" disabled={busy} onClick={() => void reanalyze()}>
            Re-analyse
          </button>
        </div>
      )}
      {choosing && onReanalyze && (
        <DocumentChooser
          mode={choosing}
          current={doc}
          review={review}
          filed={filed}
          onCombine={async (ids) => {
            await onCombine?.(ids);
          }}
          onFileWith={(anchorId) => onReanalyze(anchorId)}
          onCancel={() => {
            setChoosing(null);
            setMenu(false);
          }}
        />
      )}
```

- [ ] **Step 4: Run the ReviewCard tests**

Run: `cd pwa && pnpm exec vitest run tests/ui/ReviewCard.test.tsx`

Expected: PASS. The old tests still render without the new props, so the More button is hidden there.

- [ ] **Step 5: Write the failing InboxScreen tests**

Add to `pwa/tests/ui/InboxScreen.test.tsx` (`setup` takes `over: Partial<DocumentsApi>`):

```tsx
  it('combines two cards from the More menu', async () => {
    const a = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Certified letter' } });
    const b = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Return receipt' } });
    const combined = makeDoc({ id: 'combined', state: 'received', analysis: null, seq: 1000 });
    const { api } = setup([a, b], { combine: vi.fn().mockResolvedValue(combined) });
    const card = screen.getByRole('article', { name: 'Review Certified letter' });
    fireEvent.click(within(card).getByRole('button', { name: 'More' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Combine with…' }));
    fireEvent.click(within(card).getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(api.combine).toHaveBeenCalledWith([a.id, b.id]));
    // The parts are read back (now discarded) and leave review.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(b.id));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Review Return receipt' })).toBeNull());
  });

  it('files a card with a recently filed document', async () => {
    const letter = makeDoc({ state: 'filed', filed: { name: 'Certified letter.pdf', folderPath: '/Legal', driveNodeUid: 'n', driveUrl: null } });
    const receipt = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Return receipt' } });
    const { api } = setup([letter, receipt], { reanalyze: vi.fn(async () => ({ ...receipt, state: 'received' as const, seq: 999 })) });
    const card = screen.getByRole('article', { name: 'Review Return receipt' });
    fireEvent.click(within(card).getByRole('button', { name: 'More' }));
    fireEvent.click(within(card).getByRole('button', { name: 'File with…' }));
    fireEvent.click(within(card).getByRole('button', { name: /Certified letter\.pdf/ }));
    await waitFor(() => expect(api.reanalyze).toHaveBeenCalledWith(receipt.id, letter.id));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Review Return receipt' })).toBeNull());
  });

  it('refreshes the list when a combine is refused as stale', async () => {
    const a = makeDoc();
    const b = makeDoc();
    const { api, sync } = setup([a, b], { combine: vi.fn().mockRejectedValue(new ApiError('conflict', 409, 'conflict')) });
    const poll = vi.spyOn(sync, 'poll');
    const card = screen.getAllByRole('article')[0]!;
    fireEvent.click(within(card).getByRole('button', { name: 'More' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Combine with…' }));
    fireEvent.click(within(card).getAllByRole('checkbox')[0]!);
    fireEvent.click(within(card).getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(api.combine).toHaveBeenCalled());
    await waitFor(() => expect(poll).toHaveBeenCalled());
    expect(await within(card).findByText('Something changed; the list has been refreshed.')).toBeInTheDocument();
  });
```

Add `within` to the testing-library import and `ApiError` from `../../src/api.js` if they're missing. The article role and name come from `aria-label={`Review ${name}`}` in `ReviewCard`.

- [ ] **Step 6: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/InboxScreen.test.tsx`

Expected: FAIL, because InboxScreen doesn't pass the new props yet.

- [ ] **Step 7: Wire `InboxScreen.tsx`**

Add after `const retry = ...`:

```ts
  // A refusal for a stale list (a part moved on, an anchor went away) asks
  // for fresh data; the chooser still says what happened.
  const refreshIfStale = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) void sync.poll();
  };
  const combine = async (ids: string[]) => {
    try {
      sync.upsert(await documents.combine(ids));
    } catch (err) {
      refreshIfStale(err);
      throw err;
    }
    // The parts are discarded now: read them back so they leave review.
    for (const id of ids) await readBack(id);
  };
  const reanalyze = async (id: string, anchorId?: string) => {
    try {
      sync.upsert(await documents.reanalyze(id, anchorId));
    } catch (err) {
      refreshIfStale(err);
      throw err;
    }
  };
```

Replace the `ReviewCard` render with:

```tsx
            <ReviewCard
              key={d.id}
              doc={d}
              folders={folders}
              review={g.review}
              filed={g.filed}
              onApprove={(b) => approve(d.id, b)}
              onDiscard={() => discard(d.id)}
              onCombine={combine}
              onReanalyze={(anchorId) => reanalyze(d.id, anchorId)}
            />
```

- [ ] **Step 8: Run the PWA suite and typecheck**

Run: `cd pwa && pnpm test && pnpm run typecheck`

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add pwa/src/ui/inbox/ReviewCard.tsx pwa/src/ui/inbox/InboxScreen.tsx pwa/tests/ui/ReviewCard.test.tsx pwa/tests/ui/InboxScreen.test.tsx
git commit -m "feat(pwa): combine, file with and re-analyze from the review card"
```

---

### Task 15: Docs and full verification

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-10-13-combine-and-file-with-design.md`

- [ ] **Step 1: Update the spec for the `reanalyzed` column**

1. In §1's SQL block, add:

```sql
-- reanalyzed: the user asked for a fresh analysis, so it always goes to review.
ALTER TABLE documents ADD COLUMN reanalyzed INTEGER NOT NULL DEFAULT 0 CHECK (reanalyzed IN (0, 1));
```

2. Add `reanalyzed: boolean` to the `DocumentRow`/`DocumentPatch` bullet.
3. In §3 **Transition**, add `reanalyzed: true` to the patch. Add one sentence: "`analyzeStage` records `'re-analysed'` from this flag; reusing `review_reason` would break the rule that a fresh analysis clears a stale reason."
4. In §4, change "listed with thumbnail and proposed name" to "listed with proposed name and folder". The chooser shows no thumbnails; the review cards above it already do.
5. In §5's network-failure row, change "An error in the sheet with Retry" to "An error in the chooser; pressing the action again retries".

- [ ] **Step 2: Update `CLAUDE.md`**

In the **Documents (`documents/`)** bullet, after the sentence ending "Filing sends the prepared blob only when the row records `preparedMime` and the blob exists.", add:

> Two user actions start from review (spec `2026-10-13-combine-and-file-with-design.md`). **Combine** (`POST /api/documents/combine`, `combine.ts`) builds one PDF from each part's prepared PDF, else its original. It inserts the new row and discards the parts into it (`combined_into`) in one transaction (`repo.insertCombined`); restoring a part undoes it. **Re-analyze** (`POST /:id/reanalyze`) sends a document back to `received`, optionally with a sealed **anchor** (`anchor.ts`): a filed document or another in review. `analyzeStage` then adds a `<related>` block to the prompt (only then, so the normal prompt is unchanged), pins the folder to the anchor's, and records a fixed review reason, so the result is always reviewed. Neither action is allowed on a row that may already be in Drive (`possibly_in_drive`). The audit entry's `anchored` flag marks filings whose folder came from code, not the model.

In the PWA paragraph, after "`ui/inbox/` (the home screen: review cards, folder picker, activity rows)", add ", `DocumentChooser` for Combine with… / File with…".

- [ ] **Step 3: Full verification**

Run from the repo root:

```bash
pnpm test && pnpm -r run typecheck && pnpm build
```

Expected: all PASS. Report the actual output. If anything fails, fix it before committing; don't paper over it.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-13-combine-and-file-with-design.md
git commit -m "docs: combine and file-with in CLAUDE.md and the spec"
```

---

### Task 16: Manual check (with the user)

This needs real Proton credentials and the real tools, so it is the user's step, assisted:

1. Build and run the Docker image locally (`docker build` per the repo's Dockerfile; run it with `--init`), sign in, and upload a two-page PDF and a phone photo.
2. **Combine:**
   - From the first card: More → Combine with… → check the second → Combine 2.
   - A new card appears after analysis. Its thumbnail is the first page, and the combined PDF has the pages in order and is searchable.
   - Discard the combined card, restore both parts, and confirm they're back in review.
3. **File with:**
   - Approve the letter so it is filed.
   - On the receipt: More → File with… → Recently filed → the letter.
   - The receipt comes back with "Filed with “…”", the letter's folder, and a paired name. Approve it.
4. Check the server log: no document or folder names in `document analysed`, `document decided`, `documents combined` or `document re-analysis requested`.

---

## Self-review

**Spec coverage:**

| Spec | Task |
|---|---|
| §1 data | 1 |
| §2 combine: build | 4 |
| §2 combine: precheck, transaction, route | 2, 3, 5 |
| §2 restore | 5 |
| §3 anchor snapshot and refresh | 6 |
| §3 prompt | 7 |
| §3 stage pinning and reasons | 8 |
| §3 route | 9 |
| Audit `anchored` | 10 |
| §4 PWA | 11–14 |
| §5 errors | 5, 9, 13 |
| Testing section | each task |
| Manual check | 16 |

**Type consistency:**

- `Anchor.folder` is `FolderChoice` throughout (`types.ts`, `anchor.ts`, the analyze stage).
- `folderPath()` takes `FolderChoice`; `Decision['folder']` is assignable to it.
- PWA `onReanalyze(anchorId?)` matches `documents.reanalyze(id, anchorId?)`.
- `combineCandidates`, `anchorCandidates`, `anchorFolder` and `matches` are named the same in `choose.ts`, `DocumentChooser` and `ReviewCard`.
