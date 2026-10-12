# Preparing (AI document filing, slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Between analysis and filing, the server turns image-only PDFs and document photos into searchable PDFs with `ocrmypdf`, and makes a first-page thumbnail for the review card. A document is never lost or held up because a tool is missing, fails or is slow.

**Architecture:**
- The `prepare` stage (now a pass-through) calls injected `PrepareTools`: OCR a PDF, image→PDF, and thumbnail.
- The real tools (`server/src/prepare/`) run `ocrmypdf`, `img2pdf` and Ghostscript as child processes. They run without a shell, from fixed argument lists, in a private temporary directory, with timeouts that kill the whole process group.
- The prepared file and the thumbnail are stored encrypted in the inbox (the `prepared` and `thumbnail` blob kinds already exist). Filing already sends the prepared blob when there is one.
- An authenticated endpoint serves the thumbnail, and the review card shows it.
- The four tools are added to the Docker image as pinned `apk` packages.

**Tech Stack:** Node 24 with tsx, `node:child_process`, `ocrmypdf` 16.11, `img2pdf` 0.6, Ghostscript 10.07, `sharp`, `node:sqlite`, Hono, and Preact 11 in the PWA, tested with Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`, §4 "Preparing and filing" and "Delivery slices" item 3.

---

## Decisions

**User, 2026-10-12**
- The OCR tools ship **in the main image**.
- Measured on `node:24.21.0-alpine` (Alpine 3.24.2), installing `ocrmypdf tesseract-ocr-data-eng py3-img2pdf ghostscript` adds **about 319 MB**. The base image is 226 MB.
- Versions: `ocrmypdf` 16.11.1-r2, Tesseract 5.5.2, `py3-img2pdf` 0.6.3-r1, `ghostscript` 10.07.1-r0. Python 3.14 comes in as a dependency.

**Behaviour, verified in that image before planning**
- **Born-digital PDF:** `ocrmypdf --skip-text --output-type pdf --sidecar s.txt` exits 0, and the sidecar holds only `[OCR skipped on page(s) 1]`. That is the signal to keep the original unchanged.
- **Image-only PDF:** it exits 0, and the sidecar holds the recognised text.
- **Encrypted PDF:** it exits **8**.
- **Thumbnail:** `gs -dSAFER -sDEVICE=jpeg -dFirstPage=1 -dLastPage=1` renders the first page.

**What gets prepared**
- **PDFs:** every PDF is OCR'd with `--skip-text`. If no text was added (born-digital), or the PDF is encrypted or digitally signed, the original is filed unchanged.
- **Document photos:** when the analysis says `isDocument: true`, JPEG, PNG, WebP, TIFF, GIF and BMP go through `img2pdf`, then OCR, and become a searchable PDF. WebP, GIF and BMP are converted to JPEG with `sharp` first.
- **Left as they are:** ordinary photos, HEIC (which sharp can't decode), Office files and everything else.
- **Fallback:** if a tool is missing, fails or times out (OCR 5 min, img2pdf 60 s, thumbnail 30 s), the **original** is filed. `prepare_note` records why, the PWA shows it, and the fallback is reported (status: error type only).

**Thumbnails**
- 400 px wide JPEG, quality 80, made from the prepared file if there is one, otherwise from the original.
- PDFs are rendered with Ghostscript, then resized with `sharp`. Images are made with `sharp` directly. Other types get none.
- Stored encrypted. Deleted with the other blobs when the document is filed.

**Local development**
- The tools are optional. Without them, preparation falls back with the note "OCR is not installed on this server".
- Unit tests use fake tools.
- The real-tools integration test runs only where all three binaries are on `PATH`. A Docker smoke script exercises them in the built image.

## Conventions for every task

- **Node:** before `pnpm`, run `export PATH="$HOME/.local/share/fnm/node-versions/v$(cat .nvmrc | tr -d v)/installation/bin:$PATH"` from the repo root.
- **Server tests:** `cd server && pnpm test`. For one file: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run <file>`. Typecheck: `pnpm --filter @doc-scanner/server run typecheck`.
- **PWA tests:** `cd pwa && pnpm exec vitest run <file>`. Typecheck: `pnpm --filter @doc-scanner/pwa run typecheck`.
- **Strict TypeScript:** `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.
- **Preact 11:** unmount-critical cleanups go in `useLayoutEffect`.
- **Data:** fictional only.
- **Commits:** Conventional Commits, signed. `git add` only the task's files, and never use `git stash`.
- **Privacy:** never log or report a tool's stdout/stderr, a document name, or document text. Log error **types** only. Temporary files hold plaintext, so they live in a fresh `mkdtemp` directory (mode 0700) that is always removed in `finally`.

## File map

| File | Responsibility |
|---|---|
| `server/src/prepare/run.ts` | `runTool`: spawn without a shell, timeout kills the process group; `ToolMissingError`, `ToolTimeoutError` |
| `server/src/prepare/tools.ts` | `PrepareTools` interface + `createPrepareTools()` (ocrmypdf / img2pdf / gs / sharp) |
| `server/src/prepare/sidecar.ts` | `ocrAddedText(sidecar)`: did OCR add any text? |
| `server/src/migrations/007_prepare.sql` | `documents.prepare_note`, `documents.has_thumbnail` |
| `server/src/documents/{types,repo,view,inbox-store}.ts` | the two fields; `InboxStore.remove(id, kind)` |
| `server/src/documents/deps.ts`, `pipeline.ts` | `prepare: PrepareTools` dependency |
| `server/src/documents/stages/prepare.ts` | the stage |
| `server/src/documents/stages/file.ts` | clears `hasThumbnail` when filed |
| `server/src/http/routes-documents.ts` | `GET /api/documents/:id/thumbnail` |
| `pwa/src/documents/types.ts`, `pwa/src/ui/inbox/{ReviewCard,DocumentRows}.tsx`, `theme.css` | thumbnail on the card, note on rows |
| `Dockerfile` | pinned `apk` packages |
| `server/scripts/smoke-prepare.ts` | exercises the real tools in the built image |

---

## Task 1: `runTool`

**Files:**
- Create: `server/src/prepare/run.ts`
- Test: `server/tests/prepare/run.test.ts`

The test uses `process.execPath` (node itself) as the "tool", so no external binary is needed.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { runTool, ToolMissingError, ToolTimeoutError } from '../../src/prepare/run.js';

const node = process.execPath;

describe('runTool', () => {
  it('returns the exit code and output without throwing on a non-zero exit', async () => {
    const r = await runTool(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { timeoutMs: 10_000 });
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('passes arguments verbatim, with no shell', async () => {
    const r = await runTool(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi); rm -rf /'], { timeoutMs: 10_000 });
    expect(r.stdout).toBe('$(echo hi); rm -rf /');
  });

  it('rejects with ToolMissingError when the program does not exist', async () => {
    await expect(runTool('/nonexistent/doc-scanner-tool', [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(ToolMissingError);
  });

  it('kills a tool that runs too long, children included', async () => {
    // The child spawns a grandchild that would outlive a plain kill.
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(g.pid));
      setInterval(() => {}, 1000);`;
    let grandchild = 0;
    const started = Date.now();
    await expect(
      runTool(node, ['-e', script], { timeoutMs: 300, onStdout: (s) => { grandchild = Number(s); } }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(grandchild, 0)).toThrow(); // gone
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement.** `server/src/prepare/run.ts`:

```ts
import { spawn } from 'node:child_process';

export class ToolMissingError extends Error {
  override name = 'ToolMissingError';
}

export class ToolTimeoutError extends Error {
  override name = 'ToolTimeoutError';
}

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
  /** Test hook: called with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
}

/**
 * Runs a program with fixed arguments: no shell, so nothing in an argument is
 * interpreted. A non-zero exit resolves (the caller decides what it means);
 * a missing program or a timeout rejects. On timeout the whole process group
 * is killed, so a tool's own children (ocrmypdf runs tesseract) go too.
 *
 * The output is for the caller to classify only: never log or report it, it
 * can quote a document.
 */
export function runTool(cmd: string, args: readonly string[], o: RunOptions): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      detached: true, // its own process group, killed as one on timeout
      stdio: ['ignore', 'pipe', 'pipe'],
      // ocrmypdf parallelises pages itself; one thread per tesseract avoids oversubscription.
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      stdout += s;
      o.onStdout?.(s);
    });
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      stderr += s;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, o.timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new ToolMissingError(`${cmd} is not installed`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new ToolTimeoutError(`${cmd} took longer than ${o.timeoutMs} ms`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
```

- [ ] **Step 4: Run the test (3×) and typecheck.** All pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): run external tools safely with a group-killing timeout"`

---

## Task 2: Storage: migration 007, fields, `InboxStore.remove`

**Files:**
- Create: `server/src/migrations/007_prepare.sql`
- Modify: `server/src/documents/{types,repo,view,inbox-store}.ts`, `server/src/documents/stages/file.ts`
- Test: `server/tests/db.test.ts`, `server/tests/documents/{repo,view,inbox-store,file-stage}.test.ts`, plus any hand-built `DocumentRow` fixture. Find them with `grep -rn "driveUrl: null" server/tests`.

- [ ] **Step 1: Write the failing tests.**
  - `db.test.ts`: every version assertion goes from 6 to 7, including the re-open count. Add a test that `documents` has the `prepare_note` and `has_thumbnail` columns, and that `has_thumbnail` rejects a value of 2.
  - `repo.test.ts`: `prepareNote` and `hasThumbnail` round-trip through a transition. `prepare_note` is stored as plain text, because it only ever holds fixed sentences.
  - `inbox-store.test.ts`: `remove(id, 'thumbnail')` deletes that one blob, leaves the others, and is a no-op when the blob is absent.
  - `view.test.ts`:
    - `prepareNote` is passed through.
    - `hasThumbnail` is true while not filed.
    - It is false for a filed row even if the flag is set.
  - `file-stage.test.ts`: after filing, the row's `hasThumbnail` is false.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Migration.** `server/src/migrations/007_prepare.sql`:

```sql
-- Schema version 7: what preparing a document recorded (spec §4, slice 3).
-- prepare_note: a fixed sentence shown with a document filed without the
-- text layer it should have had (OCR missing, failed or slow). Plaintext:
-- it never holds a name or document text.
-- has_thumbnail: an encrypted first-page thumbnail waits in the inbox.
ALTER TABLE documents ADD COLUMN prepare_note TEXT;
ALTER TABLE documents ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0 CHECK (has_thumbnail IN (0, 1));
```

- [ ] **Step 4: Fields.**
  - `types.ts`:
    - Add `prepareNote: string | null;` and `hasThumbnail: boolean;` to `DocumentRow`.
    - Add `prepareNote?: string | null;` and `hasThumbnail?: boolean;` to `DocumentPatch`.
  - `repo.ts`:
    - Add `prepareNote: 'prepare_note'` and `hasThumbnail: 'has_thumbnail'` to the column map.
    - Write booleans exactly as `autoFiled` and `uploadUnverified` are written, and map them back on read.
    - Do not add either column to the sealed set.

- [ ] **Step 5: `InboxStore.remove`.** Next to `deleteAll`:

```ts
  /** Deletes one blob; nothing to do if it isn't there. */
  remove(id: string, kind: BlobKind): void {
    rmSync(this.path(id, kind), { force: true });
  }
```

Use whatever `fs` import style the file already has.

- [ ] **Step 6: View.** Add to `toView`:

```ts
    prepareNote: d.prepareNote,
    // The blobs are deleted once a document is filed.
    hasThumbnail: d.hasThumbnail && d.state !== 'filed',
```

- [ ] **Step 7: Filing.** In `stages/file.ts`, the `filing → filed` patch gets `hasThumbnail: false`. The inbox blobs, the thumbnail among them, are deleted right after.

- [ ] **Step 8: Run the test files, the server suite and the typecheck.** All pass.

- [ ] **Step 9: Commit.** `git commit -m "feat(documents): record preparation notes and thumbnails"`

---

## Task 3: `PrepareTools`

**Files:**
- Create: `server/src/prepare/sidecar.ts`, `server/src/prepare/tools.ts`
- Test: `server/tests/prepare/sidecar.test.ts`, `server/tests/prepare/tools.integration.test.ts`

- [ ] **Step 1: Write the failing tests.**

`server/tests/prepare/sidecar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ocrAddedText } from '../../src/prepare/sidecar.js';

describe('ocrAddedText', () => {
  it('is false when every page was skipped', () => {
    expect(ocrAddedText('[OCR skipped on page(s) 1]')).toBe(false);
    expect(ocrAddedText('[OCR skipped on page(s) 1-3]\n')).toBe(false);
    expect(ocrAddedText('[OCR skipped on page(s) 1]\f[OCR skipped on page(s) 2]\f')).toBe(false);
  });
  it('is false for nothing recognised', () => {
    expect(ocrAddedText('')).toBe(false);
    expect(ocrAddedText(' \n\f \n')).toBe(false);
  });
  it('is true when any page gained text', () => {
    expect(ocrAddedText('[OCR skipped on page(s) 1]\fNorthwind Energy\nAmount due')).toBe(true);
    expect(ocrAddedText('Northwind Energy')).toBe(true);
  });
});
```

`server/tests/prepare/tools.integration.test.ts` runs only when all three tools are installed. It builds its fixtures with the tools themselves, from fictional text:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { createPrepareTools } from '../../src/prepare/tools.js';

const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const available = has('ocrmypdf') && has('img2pdf') && has('gs');

async function textPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Northwind Energy', { x: 56, y: 720, size: 28, font });
  page.drawText('Electricity Bill - September 2026', { x: 56, y: 680, size: 18, font });
  return doc.save();
}

describe.skipIf(!available)('PrepareTools (real binaries)', () => {
  const tools = createPrepareTools();
  let born: Uint8Array;
  let scanJpeg: Uint8Array;

  beforeAll(async () => {
    born = await textPdf();
    // A page image of that text, as a phone would capture it.
    scanJpeg = (await tools.thumbnail(born, 'application/pdf', { width: 1700 }))!;
  });

  it('leaves a born-digital PDF unchanged', async () => {
    expect(await tools.ocrPdf(born)).toEqual({ kind: 'unchanged' });
  });

  it('adds a text layer to an image-only PDF', async () => {
    const imageOnly = await tools.imageToPdf(scanJpeg, 'image/jpeg');
    const r = await tools.ocrPdf(imageOnly);
    expect(r.kind).toBe('ocred');
  });

  it('turns a PNG photo into a PDF', async () => {
    const png = await sharp(scanJpeg).png().toBuffer();
    const pdf = await tools.imageToPdf(new Uint8Array(png), 'image/png');
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('makes JPEG thumbnails of PDFs and images', async () => {
    const t1 = await tools.thumbnail(born, 'application/pdf');
    const t2 = await tools.thumbnail(scanJpeg, 'image/jpeg');
    for (const t of [t1, t2]) {
      const meta = await sharp(t!).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeLessThanOrEqual(400);
    }
    expect(await tools.thumbnail(new TextEncoder().encode('not a picture'), 'text/plain')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail.** The sidecar test fails because the module doesn't exist yet. The integration test fails the same way where the tools are installed, and is skipped where they aren't.

- [ ] **Step 3: Implement.**

`server/src/prepare/sidecar.ts`:

```ts
/** ocrmypdf writes this placeholder to the sidecar for a page that already had text. */
const SKIPPED = /\[OCR skipped on page\(s\) [^\]]*\]/g;

/** Whether ocrmypdf recognised any text: its sidecar holds more than skip placeholders and blank space. */
export function ocrAddedText(sidecar: string): boolean {
  return /\S/.test(sidecar.replace(SKIPPED, ''));
}
```

`server/src/prepare/tools.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { runTool } from './run.js';
import { ocrAddedText } from './sidecar.js';

export const OCR_TIMEOUT_MS = 5 * 60_000;
const IMG2PDF_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 30_000;
const THUMBNAIL_WIDTH = 400;

/** img2pdf takes these directly; other image types are converted to JPEG first. */
const IMG2PDF_NATIVE = new Set(['image/jpeg', 'image/png', 'image/tiff']);

export class ToolFailedError extends Error {
  override name = 'ToolFailedError';
}

export type OcrResult =
  | { kind: 'ocred'; pdf: Uint8Array }
  /** Every page already had text: file the original. */
  | { kind: 'unchanged' }
  /** Encrypted or digitally signed: OCR would break it, so file the original. */
  | { kind: 'protected' };

export interface PrepareTools {
  ocrPdf(pdf: Uint8Array): Promise<OcrResult>;
  imageToPdf(image: Uint8Array, mime: string): Promise<Uint8Array>;
  /** A JPEG of the first page or the image, or null when the type can't be rendered. */
  thumbnail(bytes: Uint8Array, mime: string, o?: { width?: number }): Promise<Uint8Array | null>;
}

/** A private directory for one job's plaintext, always removed afterwards. */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'docscanner-prepare-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createPrepareTools(): PrepareTools {
  return {
    async ocrPdf(pdf) {
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), pdf);
        const r = await runTool(
          'ocrmypdf',
          ['--skip-text', '--output-type', 'pdf', '--jobs', '2', '-l', 'eng', '--sidecar', 'side.txt', 'in.pdf', 'out.pdf'],
          { timeoutMs: OCR_TIMEOUT_MS, cwd: dir },
        );
        // 8: encrypted. A digitally signed PDF is refused (unless told to invalidate the signature, which we never do).
        if (r.code === 8 || (r.code !== 0 && /digital signature/i.test(r.stderr))) return { kind: 'protected' };
        if (r.code !== 0) throw new ToolFailedError(`ocrmypdf exited ${r.code}`);
        const sidecar = await readFile(join(dir, 'side.txt'), 'utf8');
        if (!ocrAddedText(sidecar)) return { kind: 'unchanged' };
        return { kind: 'ocred', pdf: new Uint8Array(await readFile(join(dir, 'out.pdf'))) };
      });
    },

    async imageToPdf(image, mime) {
      return inTempDir(async (dir) => {
        const native = IMG2PDF_NATIVE.has(mime);
        const input = native ? image : new Uint8Array(await sharp(image).rotate().jpeg({ quality: 90 }).toBuffer());
        const name = native ? `in.${mime.split('/')[1]}` : 'in.jpeg';
        await writeFile(join(dir, name), input);
        const r = await runTool('img2pdf', ['-o', 'out.pdf', name], { timeoutMs: IMG2PDF_TIMEOUT_MS, cwd: dir });
        if (r.code !== 0) throw new ToolFailedError(`img2pdf exited ${r.code}`);
        return new Uint8Array(await readFile(join(dir, 'out.pdf')));
      });
    },

    async thumbnail(bytes, mime, o = {}) {
      const width = o.width ?? THUMBNAIL_WIDTH;
      const fromImage = async (img: Uint8Array) =>
        new Uint8Array(await sharp(img).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
      if (mime.startsWith('image/')) {
        try {
          return await fromImage(bytes);
        } catch {
          return null; // HEIC and anything sharp can't decode
        }
      }
      if (mime !== 'application/pdf') return null;
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), bytes);
        // ~150 dpi is enough for a 400 px card and a 1700 px test page; -dSAFER keeps the PDF from touching files.
        const r = await runTool(
          'gs',
          ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=jpeg', '-dJPEGQ=85', '-r150', '-dFirstPage=1', '-dLastPage=1', '-sOutputFile=page.jpg', 'in.pdf'],
          { timeoutMs: THUMBNAIL_TIMEOUT_MS, cwd: dir },
        );
        if (r.code !== 0) return null; // encrypted, corrupt
        try {
          return await fromImage(new Uint8Array(await readFile(join(dir, 'page.jpg'))));
        } catch {
          return null;
        }
      });
    },
  };
}
```

- [ ] **Step 4: Run the tests and the typecheck.**
  - If the tools are installed locally, the integration test should pass. If not, it is skipped; say so in the report, because Task 8 checks it in Docker.
  - On macOS the tools are `brew install ocrmypdf` (this brings Tesseract and Ghostscript) plus `brew install img2pdf`. Installing them is optional; don't install anything without asking.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): OCR, image-to-PDF and thumbnail tools"`

---

## Task 4: The prepare stage

**Files:**
- Modify: `server/src/documents/stages/prepare.ts`, `server/src/documents/deps.ts`, `server/src/documents/pipeline.ts`, `server/tests/documents/harness.ts`
- Test: `server/tests/documents/prepare-stage.test.ts`

- [ ] **Step 1: Wire the dependency.**
  - In `deps.ts`, `PipelineDeps` gets `prepare: PrepareTools;`.
  - `pipeline.ts` gains an optional `prepare?: PrepareTools` in `PipelineOptions`, defaulting to `createPrepareTools()`, and passes it into the worker deps.
  - `harness.ts` gets a `fakePrepare()`, used by default, with `ocrPdf` → `{ kind: 'unchanged' }`, `imageToPdf` rejecting `new Error('not used')`, and `thumbnail` → `null`. Expose it so tests can override it. Existing stage and worker tests must keep passing.

- [ ] **Step 2: Write the failing tests.** `server/tests/documents/prepare-stage.test.ts`. Use the harness, a row in `preparing` with an `original` blob, and fake tools. Each case:
  1. **Born-digital PDF.** `ocrPdf` gives `unchanged`. No `prepared` blob; `ready` with `preparedMime: 'application/pdf'` and `prepareNote: null`. A thumbnail of the original is stored, and `hasThumbnail` is true.
  2. **Image-only PDF.** `ocrPdf` gives `ocred` with bytes B. The `prepared` blob is B, `preparedMime` is `application/pdf`, and the thumbnail is made from B (assert the bytes `thumbnail` was called with).
  3. **Protected PDF.** `ocrPdf` gives `protected`. No prepared blob and no note.
  4. **Document photo** (`image/jpeg`, `analysis.isDocument: true`). `imageToPdf`, then `ocrPdf`. The prepared blob is the OCR'd PDF. If OCR says `unchanged`, it is the plain image PDF instead. `preparedMime` is `application/pdf` in both cases.
  5. **Ordinary photo** (`isDocument: false`). No tool other than `thumbnail` is called. No prepared blob, and `preparedMime` is `image/jpeg`.
  6. **Office or text file.** No OCR. `thumbnail` gives null, so `hasThumbnail` is false.
  7. **Fallbacks.** Each case below files the original: no prepared blob, `ready`, and `ctx.report` called once with stage `'prepare'`.
     - `ToolMissingError`: note "Filed without a text layer: OCR is not installed on this server."
     - `ToolTimeoutError`: note "Filed without a text layer: OCR took too long."
     - `ToolFailedError`: note "Filed without a text layer: OCR failed."
     - Any other error: note "Filed without a text layer: OCR failed."
  8. **Stale blobs from an earlier run.** A `prepared` blob left by a crashed run is removed when this run prepares nothing, and the same goes for a `thumbnail` blob.
  9. **Thumbnail failure.** `thumbnail` throwing is ignored: `ready`, `hasThumbnail` false, nothing reported.
  10. **Pending discard.** With a discard pending, the transition loses and the discard is applied (current behaviour).
  11. **Missing original.** An `InboxBlobMissingError` is thrown out of the stage, so the worker retries or fails it as before.

- [ ] **Step 3: Run them and see them fail.**

- [ ] **Step 4: Implement.** Replace `server/src/documents/stages/prepare.ts`:

```ts
import { logger } from '../../logger.js';
import { errorName } from '../../observability/error-name.js';
import { ToolMissingError, ToolTimeoutError } from '../../prepare/run.js';
import type { StageContext } from '../deps.js';
import type { DocumentRow } from '../types.js';

/** Photos of documents become PDFs; these are the image types worth converting. */
const DOCUMENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/gif', 'image/bmp']);

function fallbackNote(err: unknown): string {
  if (err instanceof ToolMissingError) return 'Filed without a text layer: OCR is not installed on this server.';
  if (err instanceof ToolTimeoutError) return 'Filed without a text layer: OCR took too long.';
  return 'Filed without a text layer: OCR failed.';
}

/**
 * Spec §4: image-only PDFs and document photos become searchable PDFs; the
 * result goes to the inbox's `prepared` blob, which filing sends instead of
 * the original. A failure here never costs the document: the original is
 * filed, with a note. Then a first-page thumbnail for the review card.
 */
export async function prepareStage(doc: DocumentRow, ctx: StageContext): Promise<void> {
  const original = ctx.inbox.get(doc.id, 'original'); // a missing original is a real failure: the worker retries it
  let prepared: { bytes: Uint8Array; mime: string } | null = null;
  let note: string | null = null;

  try {
    if (doc.mime === 'application/pdf') {
      const r = await ctx.prepare.ocrPdf(original);
      if (r.kind === 'ocred') prepared = { bytes: r.pdf, mime: 'application/pdf' };
    } else if (DOCUMENT_IMAGE_TYPES.has(doc.mime) && doc.analysis?.isDocument) {
      const pdf = await ctx.prepare.imageToPdf(original, doc.mime);
      const r = await ctx.prepare.ocrPdf(pdf);
      prepared = { bytes: r.kind === 'ocred' ? r.pdf : pdf, mime: 'application/pdf' };
    }
  } catch (err) {
    prepared = null;
    note = fallbackNote(err);
    logger.warn({ documentId: doc.id, errName: errorName(err) }, 'document preparation fell back to the original');
    ctx.report(err, 'prepare', []);
  }

  let thumbnail: Uint8Array | null = null;
  try {
    thumbnail = await ctx.prepare.thumbnail(prepared?.bytes ?? original, prepared?.mime ?? doc.mime);
  } catch (err) {
    logger.warn({ documentId: doc.id, errName: errorName(err) }, 'could not make a thumbnail');
  }

  // A crashed earlier run may have left blobs this run doesn't want.
  if (prepared) ctx.inbox.put(doc.id, 'prepared', prepared.bytes);
  else ctx.inbox.remove(doc.id, 'prepared');
  if (thumbnail) ctx.inbox.put(doc.id, 'thumbnail', thumbnail);
  else ctx.inbox.remove(doc.id, 'thumbnail');

  const moved = ctx.repo.transition(doc.id, 'preparing', 'ready', {
    preparedMime: prepared?.mime ?? doc.mime,
    prepareNote: note,
    hasThumbnail: thumbnail !== null,
    attempts: 0,
    error: null,
  });
  if (!moved) ctx.repo.applyRequestedDiscard(doc.id);
}
```

Check the real `ctx.report` signature in `deps.ts`, and how the worker passes sensitive values (`worker.ts` `sensitiveValues`), and adapt. The errors here never carry names, so an empty list is right.

- [ ] **Step 5: Run the stage tests, the server suite (3×) and the typecheck.** All pass.

- [ ] **Step 6: Commit.** `git commit -m "feat(documents): prepare searchable PDFs and thumbnails before filing"`

---

## Task 5: Thumbnail endpoint

**Files:**
- Modify: `server/src/http/routes-documents.ts`
- Test: `server/tests/http/routes-documents.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - A document with `hasThumbnail` and a `thumbnail` blob gets a `200` response:
    - `content-type: image/jpeg`;
    - `cache-control: private, max-age=300`;
    - `x-content-type-options: nosniff`;
    - the body is the blob's bytes.
  - These cases all return 404 `not_found`:
    - an unknown id;
    - no thumbnail;
    - a filed document;
    - a set flag with no blob.
  - Without a session the endpoint returns 401. Add it to the existing 401 table.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** In `documentRoutes`, before `r.get('/:id', …)`:

```ts
  r.get('/:id/thumbnail', (c) => {
    const doc = repo.get(c.req.param('id'));
    if (!doc || !doc.hasThumbnail || doc.state === 'filed' || !inbox.has(doc.id, 'thumbnail')) {
      return c.json({ error: 'not_found' }, 404);
    }
    return new Response(inbox.get(doc.id, 'thumbnail'), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' },
    });
  });
```

- [ ] **Step 4: Run the test file, the server suite and the typecheck.**

- [ ] **Step 5: Commit.** `git commit -m "feat(http): serve document thumbnails"`

---

## Task 6: PWA: thumbnail and note

**Files:**
- Modify: `pwa/src/documents/types.ts`, `pwa/src/ui/inbox/ReviewCard.tsx`, `pwa/src/ui/inbox/DocumentRows.tsx`, `pwa/src/theme/theme.css`, `pwa/tests/documents/fixtures.ts`
- Test: `pwa/tests/ui/ReviewCard.test.tsx`, `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - The review card shows `<img>` with `src` `/api/documents/<id>/thumbnail` (id URL-encoded), `alt="First page preview"` and `loading="lazy"` when `hasThumbnail` is set, and no image otherwise.
  - The review card shows `prepareNote`, muted, when it is set.
  - A filed row shows its `prepareNote` under the folder path.
  - The fixture `makeDoc` gets `prepareNote: null` and `hasThumbnail: false`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - `types.ts`: add `prepareNote: string | null;` and `hasThumbnail: boolean;` to `DocumentView`.
  - `ReviewCard.tsx`: put the image first inside the article:

```tsx
      {doc.hasThumbnail && (
        <img class="review-thumb" src={`/api/documents/${encodeURIComponent(doc.id)}/thumbnail`} alt="First page preview" loading="lazy" />
      )}
```

    Add `{doc.prepareNote && <p class="muted">{doc.prepareNote}</p>}` after the rationale.
  - `DocumentRows.tsx` `FiledRow`: show `doc.prepareNote` as a muted line under the folder.
  - `theme.css`:

```css
.review-thumb { float: right; width: 96px; margin: 0 0 8px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); }
@media (min-width: 600px) { .review-thumb { width: 140px; } }
.review-card::after { content: ''; display: block; clear: both; }
```

- [ ] **Step 4: Run the tests (full PWA suite 3×) and the typecheck.**

- [ ] **Step 5: Commit.** `git commit -m "feat(pwa): show the first-page thumbnail and preparation notes"`

---

## Task 7: Docker image

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add the packages.** Extend the runtime stage's `apk add` with the tools, pinned to the measured versions:

```dockerfile
RUN apk add --no-cache \
  tini=0.19.0-r3 \
  ocrmypdf=16.11.1-r2 \
  tesseract-ocr-data-eng=5.5.2-r0 \
  py3-img2pdf=0.6.3-r1 \
  ghostscript=10.07.1-r0
```

Expand the comment above it:
- These are slice 3's OCR tools (spec §4). They add about 319 MB, measured 2026-10-12.
- Their own dependencies (Tesseract, Python, qpdf, pikepdf, jbig2enc, pngquant, unpaper) are pulled in unpinned, so they follow the pinned versions.
- Renovate's `apk` datasource bumps the pins (`renovate.json`, `branch=v3.24`, `community` merged).

If a pinned version is no longer in the Alpine 3.24 index when you build, use `apk policy <pkg>` in the base image to find the current one. Use that, and say so in your report.

- [ ] **Step 2: Build the image.** `docker build -t doc-scanner:prepare .`, then record its size with `docker image inspect doc-scanner:prepare --format '{{.Size}}'`.

- [ ] **Step 3: Commit.** `git commit -m "build(docker): add ocrmypdf, img2pdf and Ghostscript to the image"`

---

## Task 8: Docker smoke script

**Files:**
- Create: `server/scripts/smoke-prepare.ts`

This exercises the real tools inside the built image. The runtime image doesn't contain `server/scripts`, so the script is mounted in.

- [ ] **Step 1: Write the script.** It should:
  1. build a born-digital PDF from fictional text with pdf-lib (as the integration test does);
  2. thumbnail it at 1700 px into a page JPEG;
  3. `imageToPdf` that JPEG into an image-only PDF;
  4. assert that `ocrPdf(born)` is `unchanged` and `ocrPdf(imageOnly)` is `ocred`;
  5. make an encrypted copy with `qpdf --encrypt u o 256 -- in out`, via `runTool`, and assert that `ocrPdf(encrypted)` is `protected`;
  6. assert thumbnails exist for the PDF and the JPEG;
  7. print one line per check (`ok …` / `FAIL …`) and exit non-zero on any failure.

  It must not print document text.

- [ ] **Step 2: Run it in the image.**

```bash
docker run --rm -v "$PWD/server/scripts:/app/server/scripts:ro" --entrypoint sh doc-scanner:prepare \
  -c "cd server && node --import tsx scripts/smoke-prepare.ts"
```

All checks print `ok`. Also run the integration test in the image:

```bash
docker run --rm -v "$PWD/server:/src:ro" --entrypoint sh doc-scanner:prepare -c \
  "cp -r /src/tests /app/server/tests && cd /app/server && NODE_OPTIONS=--import=tsx node_modules/.bin/vitest run tests/prepare"
```

If vitest isn't available in the runtime image, say so; the smoke script is the required check.

- [ ] **Step 3: Commit.** `git commit -m "test(server): smoke-test the OCR tools in the Docker image"`

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/observability.md`, the spec

- [ ] **Step 1: `CLAUDE.md`.**
  - In the server architecture list, add a `prepare/` bullet:
    - what runs (ocrmypdf `--skip-text`, img2pdf for document photos, Ghostscript and sharp for thumbnails);
    - the fallback rule (a tool missing, failing or timing out files the original, with `prepare_note`);
    - safety (no shell, a private temporary directory removed afterwards, a process-group kill on timeout, tool output never logged);
    - local development: the tools are optional, `brew install ocrmypdf img2pdf`, and the unit tests use fakes.
  - Mention the Docker smoke script.
- [ ] **Step 2: `README.md`.** Mark slice 3 as done in the status paragraph. If the README has a deploy or image-size note, add the ~319 MB OCR tooling.
- [ ] **Step 3: `docs/observability.md`.** Add a row: "Preparation fell back to the original (OCR tool missing, failed or timed out)", tagged `document.stage: prepare`, with the error type only. The document is still filed. Make sure the existing `document.stage` description doesn't claim `prepare` only means "failed after 3 attempts"; reword the row if it does.
- [ ] **Step 4: Spec.** In "Delivery slices", give slice 3 this plan's path. In §4, note the measured size and the decisions above: `--skip-text` with the sidecar test, protected PDFs, the photo types, and the timeouts.
- [ ] **Step 5: Commit.** `git commit -m "docs: describe preparing documents with OCR and thumbnails"`

---

## Task 10: Verify end to end, then open the PR

- [ ] **Step 1: Full checks.** Run both suites and both typechecks, `pnpm --filter @doc-scanner/pwa build` and the Docker build plus the smoke script.
- [ ] **Step 2: Browser run (Playwright, with the user)**, against the **Docker image**, so the real tools are used.
  - Start it like this:

    ```bash
    docker run --rm -p 3000:3000 -e SESSION_ENCRYPTION_KEY=… -e ANTHROPIC_API_KEY=… -e INSECURE_COOKIES=true -e PWA_DIST_PATH=/app/pwa/dist -v <tmp>:/data doc-scanner:prepare
    ```

    Take the API key from 1Password inline (`op read …`). Never write it to disk.
  - The user signs in through the Playwright window.
  - Generate fictional test files into the repo's locally excluded `.playwright-mcp/`:
    - an image-only PDF (a rasterised fictional bill);
    - a JPEG photo of one;
    - a born-digital PDF.
  - Upload each with **Add**, then check:
    1. Each reaches Needs review with a thumbnail on its card.
    2. The image-only PDF and the photo become searchable PDFs. Show it from the server side: the row's `preparedMime` is `application/pdf` and there is no `prepareNote`.
    3. The born-digital PDF is unchanged: there is no `prepared` blob.
    4. **Only with the user's yes:** approve the scanned bill into a test folder and confirm the filed file is searchable in Drive.
  - Ask before filing anything into the real Drive.
- [ ] **Step 3: Open the PR.**
  - Title: `feat(server): searchable PDFs and thumbnails (AI filing slice 3)`.
  - The description includes the measured image size and the decisions above.
  - Follow the repo's PR workflow.
