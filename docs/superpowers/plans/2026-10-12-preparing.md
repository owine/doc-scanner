# Preparing (AI document filing, slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Between analysis and filing, the server turns image-only PDFs and document photos into searchable PDFs with `ocrmypdf`, and makes a first-page thumbnail for the review card. A document is never lost or held up because a tool is missing, fails or is slow.

**Architecture:**
- The `prepare` stage (now a pass-through) calls injected `PrepareTools`: OCR a PDF, image→PDF, and thumbnail.
- Every analysed document goes through it, including one whose analysis came back unusable (refused, truncated or invalid); the decide stage then sends that one to review with the analyzer's reason.
- The real tools (`server/src/prepare/`) run `ocrmypdf`, `img2pdf` and Ghostscript as child processes. They run without a shell, from fixed argument lists, in a private temporary directory (also their `TMPDIR`), with timeouts that kill the whole process group.
- The prepared file and the thumbnail are stored encrypted in the inbox (the `prepared` and `thumbnail` blob kinds already exist). Filing sends the prepared blob when the row records one.
- An authenticated endpoint serves the thumbnail, and the review card shows it.
- The four tools are added to the Docker image as pinned `apk` packages, and CI smoke-tests them in the built image.

**Tech Stack:** Node 24 with tsx, `node:child_process`, `ocrmypdf` 16.11, `img2pdf` 0.6, Ghostscript 10.07, `sharp`, `node:sqlite`, Hono, and Preact 11 in the PWA, tested with Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`, §4 "Preparing and filing" and "Delivery slices" item 3.

---

## Decisions

**User, 2026-10-12**
- The OCR tools ship **in the main image**.
- Measured on `node:24.21.0-alpine` (Alpine 3.24.2), installing `ocrmypdf tesseract-ocr-data-eng py3-img2pdf ghostscript` adds **about 319 MB**. The base image is 226 MB.
- Versions: `ocrmypdf` 16.11.1-r2, Tesseract 5.5.2, `py3-img2pdf` 0.6.3-r1, `ghostscript` 10.07.1-r0. Python 3.14 comes in as a dependency.
- **Unusable analyses are prepared too.** A refused, truncated or invalid answer used to go straight from `analyzing` to `needs_review`, so its card had no thumbnail and its file no text layer. It now goes to `preparing` with the review reason recorded, and `decideStage` sends a row with no analysis to review with that reason.
- **CI smoke-tests the tools** in the built image on both architectures, so an `apk` bump that changes ocrmypdf's sidecar text or exit codes fails CI instead of quietly changing what gets filed.

**Behaviour, verified in that image before planning (and again in review)**
- **Born-digital PDF:** `ocrmypdf --skip-text --output-type pdf --sidecar s.txt` exits 0, and the sidecar holds only `[OCR skipped on page(s) 1]`. That is the signal to keep the original unchanged.
- **Image-only PDF:** it exits 0, and the sidecar holds the recognised text.
- **Encrypted PDF with a user password:** it exits **8**. A PDF with only an **owner** password (an empty user password, common for statements) is *not* refused: it exits 0, a born-digital one comes back unchanged, and an image-only one is OCR'd into an output without the owner restrictions. That is acceptable: the user can open it either way.
- **Digitally signed PDF:** it exits 2 with `DigitalSignatureError: Input PDF has a digital signature` on stderr. A PDF with an empty signature field counts too (ocrmypdf checks `/SigFlags`).
- **Dynamic XFA form:** it exits 2 with "This PDF contains dynamic XFA forms" on stderr. Treated like a signed PDF: kept as it is, with no note.
- **Tagged PDF:** with `--skip-text` it is only a warning; it exits 0.
- **Thumbnail:** `gs -dSAFER -sDEVICE=jpeg -dFirstPage=1 -dLastPage=1` renders the first page.
- **Temporary files:** ocrmypdf keeps its page images and recognised text in `$TMPDIR/ocrmypdf.io.*`. A timeout kill leaves them there, so every tool runs with `TMPDIR` set to its job directory.
- **Speed:** about 4.8 s a page for noisy 300 dpi pages with 2 CPUs; 20 clean pages in 4.5 s with 10 CPUs. The 5-minute limit is roughly 60 pages on 2 cores.

**What gets prepared**
- **PDFs:** every PDF is OCR'd with `--skip-text`. If no text was added (born-digital), or the PDF is encrypted, digitally signed or a dynamic XFA form, the original is filed unchanged.
- **Document photos:** when the analysis says `isDocument: true`, JPEG, PNG, WebP, TIFF, GIF and BMP go through `img2pdf`, then OCR, and become a searchable PDF. WebP and GIF are converted to JPEG with `sharp` first; BMP goes to `img2pdf` directly (sharp's prebuilt binary can't read BMP; img2pdf reads it through Pillow).
- **Left as they are:** ordinary photos, photos whose analysis was unusable (`isDocument` is unknown), HEIC (which sharp can't decode), Office files and everything else.
- **Fallback:** if a tool is missing, fails or times out (OCR 5 min, img2pdf 60 s, thumbnail 30 s), the **original** is filed. `prepare_note` records why, the PWA shows it, and the fallback is reported (status: error type only).

**Thumbnails**
- 400 px wide JPEG, quality 80, made from the prepared file if there is one, otherwise from the original.
- PDFs are rendered with Ghostscript, then resized with `sharp`. Images are made with `sharp` directly. Other types get none (an ordinary BMP photo included; a BMP document photo gets one from its prepared PDF).
- Stored encrypted. Deleted with the other blobs when the document is filed.

**Local development**
- The tools are optional. Without them, preparation falls back with the note "OCR is not installed on this server".
- Unit tests use fake tools.
- The real-tools integration test runs only where all three binaries are on `PATH`. A Docker smoke script exercises them in the built image, locally and in CI.

## Conventions for every task

- **Node:** before `pnpm`, run `export PATH="$HOME/.local/share/fnm/node-versions/v$(cat .nvmrc | tr -d v)/installation/bin:$PATH"` from the repo root.
- **Server tests:** `cd server && pnpm test`. For one file: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run <file>`. An `*.integration.test.ts` file is excluded by the default config, so run it with `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run --config vitest.integration.config.ts <file>`. Typecheck: `pnpm --filter @doc-scanner/server run typecheck`.
- **PWA tests:** `cd pwa && pnpm exec vitest run <file>`. Typecheck: `pnpm --filter @doc-scanner/pwa run typecheck`.
- **Strict TypeScript:** the PWA (src and tests) has `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` on; the server's `src` turns both off, and server tests are not typechecked.
- **Preact 11:** unmount-critical cleanups go in `useLayoutEffect`.
- **Data:** fictional only.
- **Commits:** Conventional Commits, signed. `git add` only the task's files, and never use `git stash`.
- **Privacy:** never log or report a tool's stdout/stderr, a document name, or document text. Log error **types** only. Temporary files hold plaintext, so they live in a fresh `mkdtemp` directory (mode 0700) that is always removed in `finally`. Every tool runs with `TMPDIR` set to the job directory, so its own temporary files are removed with it, even after a kill. A directory left by a crashed process is swept the next time the tools are created.

## File map

| File | Responsibility |
|---|---|
| `server/src/prepare/run.ts` | `runTool`: spawn without a shell, extra env, bounded output, timeout kills the process group; `ToolMissingError`, `ToolTimeoutError` |
| `server/src/prepare/tools.ts` | `PrepareTools` interface + `createPrepareTools()` (ocrmypdf / img2pdf / gs / sharp), `sweepStaleTempDirs()` |
| `server/src/prepare/sidecar.ts` | `ocrAddedText(sidecar)`: did OCR add any text? |
| `server/src/migrations/007_prepare.sql` | `documents.prepare_note`, `documents.has_thumbnail` |
| `server/src/documents/{types,repo,view,inbox-store}.ts` | the two fields; `InboxStore.remove(id, kind)` |
| `server/src/documents/stages/{analyze,decide}.ts` | unusable analyses go through preparing, then to review with their reason |
| `server/src/documents/deps.ts`, `pipeline.ts` | `prepare: PrepareTools` dependency |
| `server/src/documents/stages/prepare.ts` | the stage |
| `server/src/documents/stages/file.ts` | clears `hasThumbnail` when filed; sends a prepared blob only when the row records one |
| `server/src/http/routes-documents.ts` | `GET /api/documents/:id/thumbnail`; a retry re-prepares |
| `pwa/src/documents/types.ts`, `pwa/src/ui/inbox/{ReviewCard,DocumentRows}.tsx`, `theme.css` | thumbnail on the card, note on rows |
| `Dockerfile` | pinned `apk` packages |
| `server/scripts/smoke-prepare.ts` | exercises the real tools in the built image |
| `.github/workflows/ci.yml` | runs the smoke script in the image CI builds |

---

## Task 1: `runTool`

**Files:**
- Create: `server/src/prepare/run.ts`
- Test: `server/tests/prepare/run.test.ts`

The test uses `process.execPath` (node itself) as the "tool", so no external binary is needed.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { MAX_OUTPUT_CHARS, runTool, ToolMissingError, ToolTimeoutError } from '../../src/prepare/run.js';

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

  it('adds the given environment variables to the inherited ones', async () => {
    const r = await runTool(node, ['-e', 'process.stdout.write(process.env.TMPDIR + " " + process.env.OMP_THREAD_LIMIT)'], {
      timeoutMs: 10_000,
      env: { TMPDIR: '/job/dir' },
    });
    expect(r.stdout).toBe('/job/dir 1');
  });

  it('keeps only the end of a long output, where a tool says what went wrong', async () => {
    const r = await runTool(node, ['-e', 'process.stderr.write("x".repeat(200000) + "END")'], { timeoutMs: 10_000 });
    expect(r.stderr).toHaveLength(MAX_OUTPUT_CHARS);
    expect(r.stderr.endsWith('END')).toBe(true);
  });

  it('rejects with ToolMissingError when the program does not exist', async () => {
    await expect(runTool('/nonexistent/doc-scanner-tool', [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(ToolMissingError);
  });

  it('kills a tool that runs too long, children included', async () => {
    // The child spawns a grandchild that would outlive a plain kill.
    // On Linux a killed grandchild stays a zombie until PID 1 reaps it, so in
    // Docker run this with an init process (`docker run --init`).
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
    expect(grandchild).toBeGreaterThan(0);
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
  /** Added to the inherited environment, e.g. TMPDIR pointing at the job's private directory. */
  env?: Record<string, string>;
  /** Test hook: called with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
}

/**
 * Output kept per stream. The end is kept, not the start: a tool says what
 * went wrong last, after any warnings.
 */
export const MAX_OUTPUT_CHARS = 64 * 1024;

const keepEnd = (buf: string, chunk: string) => (buf + chunk).slice(-MAX_OUTPUT_CHARS);

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
      env: { ...process.env, OMP_THREAD_LIMIT: '1', ...o.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      stdout = keepEnd(stdout, s);
      o.onStdout?.(s);
    });
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      stderr = keepEnd(stderr, s);
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
    - Add `prepareNote: null` and `hasThumbnail: false` to the `row()` fixture.
    - `prepareNote` is passed through.
    - `hasThumbnail` is true while not filed.
    - It is false for a filed row even if the flag is set.
  - `file-stage.test.ts`: after filing, the row's `hasThumbnail` is false and the `thumbnail` blob is gone.

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
    - Booleans are already written by `toSql` (true → 1); map them back on read as `autoFiled` is: `prepareNote: r.prepare_note as string | null,` and `hasThumbnail: r.has_thumbnail === 1,` in `fromRow`.
    - Do not add either column to the sealed set.

- [ ] **Step 5: `InboxStore.remove`.** Next to `deleteAll` (`rmSync` is already imported from `node:fs`):

```ts
  /** Deletes one blob; nothing to do if it isn't there. */
  remove(id: string, kind: BlobKind): void {
    rmSync(this.path(id, kind), { force: true });
  }
```

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
- Test: `server/tests/prepare/sidecar.test.ts`, `server/tests/prepare/tools.test.ts`, `server/tests/prepare/tools.integration.test.ts`

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

`server/tests/prepare/tools.test.ts` runs everywhere: it fakes `runTool`, so it checks how each tool is run and how its result is read without the binaries.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

vi.mock('../../src/prepare/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/prepare/run.js')>()),
  runTool: vi.fn(),
}));

import { runTool } from '../../src/prepare/run.js';
import { createPrepareTools, sweepStaleTempDirs, TEMP_PREFIX, ToolFailedError } from '../../src/prepare/tools.js';

const run = vi.mocked(runTool);
interface Call {
  cmd: string;
  args: readonly string[];
  cwd: string | undefined;
  tmp: string | undefined;
  mode: number;
}
let calls: Call[];

/** A fake tool: records how it was run, writes `files` into its working directory, exits with `code`. */
function fakeTool(files: Record<string, string | Uint8Array>, code = 0, stderr = '') {
  run.mockImplementation(async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, tmp: o.env?.TMPDIR, mode: statSync(o.cwd!).mode & 0o777 });
    for (const [name, data] of Object.entries(files)) writeFileSync(join(o.cwd!, name), data);
    return { code, stdout: '', stderr };
  });
}

beforeEach(() => {
  calls = [];
  run.mockReset();
});

const PDF = new TextEncoder().encode('%PDF-1.7 fictional');

describe('PrepareTools (fake binaries)', () => {
  it('runs a tool in a private job directory, with TMPDIR there, and removes it afterwards', async () => {
    fakeTool({ 'side.txt': 'Northwind Energy', 'out.pdf': 'OCR' });
    await createPrepareTools().ocrPdf(PDF);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.cmd).toBe('ocrmypdf');
    expect(c.cwd!.startsWith(join(tmpdir(), TEMP_PREFIX))).toBe(true);
    expect(c.tmp).toBe(c.cwd);
    expect(c.mode).toBe(0o700);
    expect(existsSync(c.cwd!)).toBe(false);
  });

  it.each([
    ['an encrypted PDF', 8, ''],
    ['a signed PDF', 2, 'DigitalSignatureError: Input PDF has a digital signature. OCR would alter the document,'],
    ['a dynamic XFA form', 2, 'InputFileError: This PDF contains dynamic XFA forms created by Adobe LiveCycle Designer'],
  ])('keeps %s as it is', async (_what, code, stderr) => {
    fakeTool({}, code, stderr);
    expect(await createPrepareTools().ocrPdf(PDF)).toEqual({ kind: 'protected' });
  });

  it('fails on any other error exit', async () => {
    fakeTool({}, 2, 'InputFileError: something else');
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolFailedError);
  });

  it('keeps a PDF whose pages all had text', async () => {
    fakeTool({ 'side.txt': '[OCR skipped on page(s) 1-2]\n', 'out.pdf': 'rewritten' });
    expect(await createPrepareTools().ocrPdf(PDF)).toEqual({ kind: 'unchanged' });
  });

  it('returns the OCRed PDF when text was added', async () => {
    fakeTool({ 'side.txt': 'Northwind Energy', 'out.pdf': 'OCR' });
    const r = await createPrepareTools().ocrPdf(PDF);
    expect(r.kind === 'ocred' && new TextDecoder().decode(r.pdf)).toBe('OCR');
  });

  it('hands BMP to img2pdf as it is, and converts WebP to JPEG first', async () => {
    fakeTool({ 'out.pdf': '%PDF-' });
    const tools = createPrepareTools();
    await tools.imageToPdf(new TextEncoder().encode('BM fictional'), 'image/bmp');
    const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).webp().toBuffer();
    await tools.imageToPdf(new Uint8Array(webp), 'image/webp');
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['img2pdf', '-o', 'out.pdf', 'in.bmp'],
      ['img2pdf', '-o', 'out.pdf', 'in.jpeg'],
    ]);
    expect(calls.every((c) => c.tmp === c.cwd)).toBe(true);
  });

  it('renders a PDF thumbnail with Ghostscript in SAFER mode', async () => {
    const page = await sharp({ create: { width: 1275, height: 1650, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    fakeTool({ 'page.jpg': page });
    const t = await createPrepareTools().thumbnail(PDF, 'application/pdf');
    expect(calls[0]!.cmd).toBe('gs');
    expect(calls[0]!.args[0]).toBe('-dSAFER');
    expect(calls[0]!.tmp).toBe(calls[0]!.cwd);
    expect((await sharp(t!).metadata()).width).toBe(400);
  });
});

describe('sweepStaleTempDirs', () => {
  it('removes job directories left by a crashed process and keeps a running job’s', () => {
    const old = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const fresh = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const anHourAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, anHourAgo, anHourAgo);
    sweepStaleTempDirs();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
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
    // A page image of that text, as a phone would capture it (Ghostscript renders Letter at 1275 px).
    scanJpeg = (await tools.thumbnail(born, 'application/pdf', { width: 1275 }))!;
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

- [ ] **Step 2: Run them and see them fail.** The sidecar and tools tests fail because the modules don't exist yet. The integration test fails the same way where the tools are installed, and is skipped where they aren't.

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
import { readdirSync, rmSync, statSync } from 'node:fs';
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

/** Every job directory starts with this, so a crashed process's can be found again. */
export const TEMP_PREFIX = 'docscanner-prepare-';
/** No job runs this long, so a directory untouched for longer belongs to a process that died. */
const STALE_TEMP_MS = 2 * OCR_TIMEOUT_MS;

/** img2pdf takes these directly (BMP through Pillow, which sharp's prebuilt binary lacks); WebP and GIF go through JPEG first. */
const IMG2PDF_NATIVE = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/bmp']);

export class ToolFailedError extends Error {
  override name = 'ToolFailedError';
}

export type OcrResult =
  | { kind: 'ocred'; pdf: Uint8Array }
  /** Every page already had text: file the original. */
  | { kind: 'unchanged' }
  /** Encrypted, digitally signed or a dynamic XFA form: OCR would break it or can't read it, so file the original. */
  | { kind: 'protected' };

export interface PrepareTools {
  ocrPdf(pdf: Uint8Array): Promise<OcrResult>;
  imageToPdf(image: Uint8Array, mime: string): Promise<Uint8Array>;
  /** A JPEG of the first page or the image, or null when the type can't be rendered. */
  thumbnail(bytes: Uint8Array, mime: string, o?: { width?: number }): Promise<Uint8Array | null>;
}

/**
 * Removes job directories a crashed process left behind (inTempDir's finally
 * never ran): they hold a document's plaintext. Only old ones, so a job
 * running in another process is left alone.
 */
export function sweepStaleTempDirs(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (now - statSync(dir).mtimeMs > STALE_TEMP_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * A private directory (mode 0700) for one job's plaintext, always removed
 * afterwards. Tools run with it as their working directory and their TMPDIR,
 * so their own temporary files (ocrmypdf's page images and text) go with it,
 * even when a timeout kills them.
 */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createPrepareTools(): PrepareTools {
  sweepStaleTempDirs();
  return {
    async ocrPdf(pdf) {
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), pdf);
        const r = await runTool(
          'ocrmypdf',
          ['--skip-text', '--output-type', 'pdf', '--jobs', '2', '-l', 'eng', '--sidecar', 'side.txt', 'in.pdf', 'out.pdf'],
          { timeoutMs: OCR_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } },
        );
        // 8: encrypted with a password. A digitally signed PDF is refused (unless
        // told to invalidate the signature, which we never do), and so is a
        // dynamic XFA form; both are filed as they are.
        if (r.code === 8 || (r.code !== 0 && /digital signature|XFA/i.test(r.stderr))) return { kind: 'protected' };
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
        const r = await runTool('img2pdf', ['-o', 'out.pdf', name], { timeoutMs: IMG2PDF_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } });
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
          return null; // HEIC, BMP and anything else sharp can't decode
        }
      }
      if (mime !== 'application/pdf') return null;
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), bytes);
        // 150 dpi renders a Letter page 1275 px wide: plenty for a 400 px card.
        // -dSAFER keeps the PDF from touching files.
        const r = await runTool(
          'gs',
          ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=jpeg', '-dJPEGQ=85', '-r150', '-dFirstPage=1', '-dLastPage=1', '-sOutputFile=page.jpg', 'in.pdf'],
          { timeoutMs: THUMBNAIL_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } },
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
  - `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/prepare` runs the sidecar and fake-tool tests.
  - `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run --config vitest.integration.config.ts tests/prepare` runs the integration test. If the tools are installed locally, it should pass. If not, it is skipped; say so in the report, because Task 8 checks it in Docker.
  - On macOS the tools are `brew install ocrmypdf` (this brings Tesseract and Ghostscript) plus `brew install img2pdf`. Installing them is optional; don't install anything without asking.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): OCR, image-to-PDF and thumbnail tools"`

---

## Task 4: The prepare stage

**Files:**
- Modify: `server/src/documents/stages/{analyze,decide,prepare,file}.ts`, `server/src/documents/deps.ts`, `server/src/documents/pipeline.ts`, `server/tests/documents/harness.ts`, `server/tests/http/routes-documents.test.ts`
- Test: `server/tests/documents/{stages,worker,file-stage,prepare-stage}.test.ts`

Part A routes unusable analyses through preparing (its own commit). Part B is the stage.

### Part A: unusable analyses go through preparing

- [ ] **Step 1: Write the failing tests.**
  - `stages.test.ts`, in `describe('analyzeStage')`, the test `'sends an unusable answer to review with the reason'` becomes:

```ts
  it('sends an unusable answer on to preparing, with the reason for review', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue({ ...okOutcome(), status: 'refusal', detail: 'declined (cyber)' });
    const doc = h.add();
    await analyzeStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'preparing', analysis: null, reviewReason: 'analysis refusal: declined (cyber)' });
  });
```

  - `stages.test.ts`, in `describe('analyzeStage retry state and recovery')`, the test `'resets retry state when an unusable answer goes to review'` becomes:

```ts
  it('resets retry state when an unusable answer moves on', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue({ ...okOutcome(), status: 'refusal', detail: 'declined' });
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'received', { attempts: 2, error: 'x' });
    await analyzeStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'preparing', attempts: 0, error: null });
  });
```

  - `stages.test.ts`, add to `describe('decideStage')`:

```ts
  it('sends a document whose analysis was unusable to review with the recorded reason', () => {
    h = makeHarness();
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'ready', { reviewReason: 'analysis refusal: declined' });
    decideStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'analysis refusal: declined' });
  });
```

  - `worker.test.ts`: add `okOutcome` to the import from `./harness.js`, and add to `describe('DocumentWorker')`:

```ts
  it('prepares a document whose analysis was unusable, then sends it to review with the reason', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue({ ...okOutcome(), status: 'invalid', detail: 'schema mismatch' });
    const doc = h.add();
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', analysis: null, reviewReason: 'analysis invalid: schema mismatch' });
  });
```

- [ ] **Step 2: Run them and see the first three fail.** (The worker test already passes: the end state is the same, only the path changes.)

- [ ] **Step 3: Implement.**
  - `stages/analyze.ts`, replace the final `if (outcome.status === 'ok') { … } else { … }` block with:

```ts
  let moved: boolean;
  if (outcome.status === 'ok') {
    const { textSnippet: _unused, ...analysis } = outcome.analysis;
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', { analysis, reviewReason: null, attempts: 0, error: null });
  } else {
    // Still prepared, so the review card gets a thumbnail and the file its
    // text layer; decideStage then sends it to review with this reason.
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', { reviewReason: `analysis ${outcome.status}: ${outcome.detail}`, attempts: 0, error: null });
  }
  if (!moved) ctx.repo.applyRequestedDiscard(doc.id);
```

  - `stages/decide.ts`, in `decideStage`, replace `const reason = reviewReason(a, ctx.settings.get());` with:

```ts
  // No analysis: the model's answer was unusable, and analyzeStage recorded why.
  const reason = a ? reviewReason(a, ctx.settings.get()) : (doc.reviewReason ?? 'no analysis');
```

- [ ] **Step 4: Run `stages.test.ts`, `worker.test.ts`, the server suite and the typecheck.** All pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(documents): prepare documents whose analysis was unusable"`

### Part B: the stage

- [ ] **Step 6: Wire the dependency.**
  - `deps.ts`: add `import type { PrepareTools } from '../prepare/tools.js';`, and `prepare: PrepareTools;` as the last field of `PipelineDeps`.
  - `pipeline.ts`: add `import { createPrepareTools, type PrepareTools } from '../prepare/tools.js';`. Add to `PipelineOptions`:

```ts
  /** The OCR, image-to-PDF and thumbnail tools; the real ones by default. */
  prepare?: PrepareTools;
```

    and pass `prepare: o.prepare ?? createPrepareTools(),` into the `DocumentWorker` deps, after `report: captureDocumentFailure,`.
  - `harness.ts`: add `import type { OcrResult } from '../../src/prepare/tools.js';`, this function before `makeHarness`:

```ts
/** Fake preparation tools: born-digital PDFs, no thumbnails. Override per test. */
export function fakePrepare() {
  return {
    ocrPdf: vi.fn<(pdf: Uint8Array) => Promise<OcrResult>>().mockResolvedValue({ kind: 'unchanged' }),
    imageToPdf: vi.fn<(image: Uint8Array, mime: string) => Promise<Uint8Array>>().mockRejectedValue(new Error('not used')),
    thumbnail: vi.fn<(bytes: Uint8Array, mime: string, o?: { width?: number }) => Promise<Uint8Array | null>>().mockResolvedValue(null),
  };
}
```

    and in `makeHarness`, `const prepare = fakePrepare();` after `refreshFolderCache`, with `prepare` added both to `ctx` and to the returned object (after `report`).
  - `routes-documents.test.ts`: add `fakePrepare` to the import from `../documents/harness.js`, and `prepare: fakePrepare(),` to the `createPipeline({ … })` call in `setup()`, after `liveSession`, so route tests never run real tools.
  - Run the server suite: existing stage and worker tests still pass.

- [ ] **Step 7: Write the failing tests.** `server/tests/documents/prepare-stage.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, ANALYSIS } from './harness.js';
import { prepareStage } from '../../src/documents/stages/prepare.js';
import { InboxBlobMissingError } from '../../src/documents/inbox-store.js';
import { ToolMissingError, ToolTimeoutError } from '../../src/prepare/run.js';
import { ToolFailedError } from '../../src/prepare/tools.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h.cleanup());

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const THUMB = enc('thumb-jpeg');

/** A document in `preparing` with its original in the inbox. */
function preparing(mime: string, bytes = enc('original bytes'), isDocument = true) {
  const doc = h.add(bytes, mime);
  h.repo.transition(doc.id, 'received', 'preparing', { analysis: { ...ANALYSIS, isDocument } });
  return h.repo.get(doc.id)!;
}

describe('prepareStage', () => {
  it('keeps a born-digital PDF and thumbnails the original', async () => {
    h = makeHarness();
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', preparedMime: 'application/pdf', prepareNote: null, hasThumbnail: true });
    expect(dec(h.prepare.thumbnail.mock.calls[0]![0])).toBe('original bytes');
    expect(dec(h.inbox.get(doc.id, 'thumbnail'))).toBe('thumb-jpeg');
  });

  it('stores an OCRed PDF and thumbnails it', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'ocred', pdf: enc('B') });
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('B');
    expect(h.repo.get(doc.id)?.preparedMime).toBe('application/pdf');
    expect(dec(h.prepare.thumbnail.mock.calls[0]![0])).toBe('B');
  });

  it('files a protected PDF as it is, with no note', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'protected' });
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', prepareNote: null });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('turns a document photo into a searchable PDF', async () => {
    h = makeHarness();
    h.prepare.imageToPdf.mockResolvedValue(enc('IMGPDF'));
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'ocred', pdf: enc('OCR') });
    const doc = preparing('image/jpeg');
    await prepareStage(doc, h.ctx);
    expect(h.prepare.imageToPdf).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/jpeg');
    expect(dec(h.prepare.ocrPdf.mock.calls[0]![0])).toBe('IMGPDF');
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('OCR');
    expect(h.repo.get(doc.id)?.preparedMime).toBe('application/pdf');
  });

  it('keeps the plain image PDF of a photo OCR found nothing in', async () => {
    h = makeHarness();
    h.prepare.imageToPdf.mockResolvedValue(enc('IMGPDF'));
    const doc = preparing('image/png');
    await prepareStage(doc, h.ctx);
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('IMGPDF');
    expect(h.repo.get(doc.id)?.preparedMime).toBe('application/pdf');
  });

  it('leaves an ordinary photo alone', async () => {
    h = makeHarness();
    const doc = preparing('image/jpeg', enc('x'), false);
    await prepareStage(doc, h.ctx);
    expect(h.prepare.imageToPdf).not.toHaveBeenCalled();
    expect(h.prepare.ocrPdf).not.toHaveBeenCalled();
    expect(h.prepare.thumbnail).toHaveBeenCalledOnce();
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)?.preparedMime).toBe('image/jpeg');
  });

  it('does not OCR an Office or text file, and records no thumbnail it could not make', async () => {
    h = makeHarness();
    const doc = preparing('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await prepareStage(doc, h.ctx);
    expect(h.prepare.ocrPdf).not.toHaveBeenCalled();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', hasThumbnail: false });
    expect(h.inbox.has(doc.id, 'thumbnail')).toBe(false);
  });

  it.each([
    [new ToolMissingError('ocrmypdf is not installed'), 'Filed without a text layer: OCR is not installed on this server.'],
    [new ToolTimeoutError('ocrmypdf took longer than 300000 ms'), 'Filed without a text layer: OCR took too long.'],
    [new ToolFailedError('ocrmypdf exited 2'), 'Filed without a text layer: OCR failed.'],
    [new Error('anything else'), 'Filed without a text layer: OCR failed.'],
  ])('files the original with a note when OCR throws %s', async (err, note) => {
    h = makeHarness();
    h.prepare.ocrPdf.mockRejectedValue(err);
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', preparedMime: 'application/pdf', prepareNote: note });
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.report.mock.calls[0]![1]).toBe('prepare');
  });

  it('still files the original when reporting the fallback fails', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockRejectedValue(new ToolTimeoutError('slow'));
    h.report.mockImplementation(() => {
      throw new Error('reporter down');
    });
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', prepareNote: 'Filed without a text layer: OCR took too long.' });
  });

  it('removes blobs an earlier, crashed run left', async () => {
    h = makeHarness();
    const doc = preparing('text/plain');
    h.inbox.put(doc.id, 'prepared', enc('stale'));
    h.inbox.put(doc.id, 'thumbnail', enc('stale'));
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.inbox.has(doc.id, 'thumbnail')).toBe(false);
  });

  it('ignores a thumbnail failure', async () => {
    h = makeHarness();
    h.prepare.thumbnail.mockRejectedValue(new Error('boom'));
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', hasThumbnail: false });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('applies a discard requested while it worked, and drops what it prepared', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'ocred', pdf: enc('B') });
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const doc = preparing('application/pdf');
    h.repo.requestDiscard(doc.id);
    await prepareStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.inbox.has(doc.id, 'thumbnail')).toBe(false);
    expect(h.inbox.has(doc.id, 'original')).toBe(true); // restorable
  });

  it('prepares a document whose analysis was unusable', async () => {
    h = makeHarness();
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const pdf = h.add(enc('pdf bytes'), 'application/pdf');
    h.repo.transition(pdf.id, 'received', 'preparing', { reviewReason: 'analysis refusal: declined' });
    await prepareStage(h.repo.get(pdf.id)!, h.ctx);
    expect(h.prepare.ocrPdf).toHaveBeenCalledOnce();
    expect(h.repo.get(pdf.id)).toMatchObject({ state: 'ready', hasThumbnail: true, reviewReason: 'analysis refusal: declined' });
    const photo = h.add(enc('jpeg bytes'), 'image/jpeg');
    h.repo.transition(photo.id, 'received', 'preparing', { reviewReason: 'analysis refusal: declined' });
    await prepareStage(h.repo.get(photo.id)!, h.ctx);
    expect(h.prepare.imageToPdf).not.toHaveBeenCalled(); // isDocument is unknown
  });

  it('throws when the original is missing, so the worker fails it as before', async () => {
    h = makeHarness();
    const doc = preparing('application/pdf');
    h.inbox.deleteAll(doc.id);
    await expect(prepareStage(doc, h.ctx)).rejects.toBeInstanceOf(InboxBlobMissingError);
  });
});
```

  Add to `file-stage.test.ts`:

```ts
  it('ignores a prepared blob the row does not record', async () => {
    h = makeHarness();
    const doc = h.add(new TextEncoder().encode('photo bytes'), 'image/jpeg');
    // As left by a preparation whose result was thrown away (a discard, then a restore).
    h.inbox.put(doc.id, 'prepared', new TextEncoder().encode('%PDF- fictional'));
    h.repo.transition(doc.id, 'received', 'filing', { decision: EXISTING, analysis: ANALYSIS });
    await fileStage(h.repo.get(doc.id)!, h.ctx);
    const [name, bytes, mime] = h.drive.uploadFile.mock.calls[0]!;
    expect([name, new TextDecoder().decode(bytes), mime]).toEqual(['Northwind Energy Sep 2026.jpg', 'photo bytes', 'image/jpeg']);
  });
```

- [ ] **Step 8: Run them and see them fail.**

- [ ] **Step 9: Implement.** Replace `server/src/documents/stages/prepare.ts`:

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
    try {
      // These errors never carry a name or document text, so nothing to redact.
      ctx.report(err, 'prepare', []);
    } catch {
      // Reporting is best effort; the original is filed either way.
    }
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
  if (!moved) {
    // A discard won: drop this run's result, so a restored document never
    // files a prepared blob its row doesn't describe.
    ctx.inbox.remove(doc.id, 'prepared');
    ctx.inbox.remove(doc.id, 'thumbnail');
    ctx.repo.applyRequestedDiscard(doc.id);
  }
}
```

  In `stages/file.ts`, replace `const kind = ctx.inbox.has(doc.id, 'prepared') ? 'prepared' : 'original';` with:

```ts
    // Only a prepared blob the row records (preparedMime is written with it):
    // one left by a run whose result was thrown away doesn't count.
    const kind = doc.preparedMime !== null && ctx.inbox.has(doc.id, 'prepared') ? 'prepared' : 'original';
```

- [ ] **Step 10: Run the stage tests, the server suite (3×) and the typecheck.** All pass.

- [ ] **Step 11: Commit.** `git commit -m "feat(documents): prepare searchable PDFs and thumbnails before filing"`

---

## Task 5: Thumbnail endpoint, and retries re-prepare

**Files:**
- Modify: `server/src/http/routes-documents.ts`
- Test: `server/tests/http/routes-documents.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - Add `['GET', '/api/documents/some-id/thumbnail'],` after `['GET', '/api/documents/some-id'],` in the 401 table of `'requires a login on every router'`.
  - Append:

```ts
describe('thumbnail', () => {
  it('serves the thumbnail blob', async () => {
    const { app, cookie, pipeline } = await setup();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 't1', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'needs_review', { hasThumbnail: true });
    pipeline.inbox.put(doc.id, 'thumbnail', new Uint8Array([0xff, 0xd8, 1, 2]));
    const res = await app.request(`/api/documents/${doc.id}/thumbnail`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xd8, 1, 2]);
  });

  it('is not found for an unknown id, no thumbnail, a filed document or a missing blob', async () => {
    const { app, cookie, pipeline } = await setup();
    const add = (sha256: string) =>
      pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256, sourceContext: null });
    const none = add('n1');
    const filed = add('n2');
    pipeline.repo.transition(filed.id, 'received', 'filed', { hasThumbnail: true });
    pipeline.inbox.put(filed.id, 'thumbnail', new Uint8Array([1]));
    const blobless = add('n3');
    pipeline.repo.transition(blobless.id, 'received', 'needs_review', { hasThumbnail: true });
    for (const id of ['nope', none.id, filed.id, blobless.id]) {
      const res = await app.request(`/api/documents/${id}/thumbnail`, { headers: { cookie } });
      expect([id, res.status]).toEqual([id, 404]);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });
});
```

  - In `'discards, restores and retries'`, replace everything from `pipeline.repo.transition(doc.id, 'needs_review', 'failed', { error: 'x' });` to the end of the test with:

```ts
    pipeline.repo.transition(doc.id, 'needs_review', 'failed', { error: 'x' });
    pipeline.inbox.put(doc.id, 'original', new TextEncoder().encode('statement'));
    expect((await post('retry')).status).toBe(200);
    await pipeline.worker.wake(); // the prepare stage awaits its tools: let the drain finish
    // Retry resumes at `preparing` (the failure may have cost the text layer
    // or the thumbnail), so preparedMime is recorded; the worker then decides
    // at once, and with auto-filing off that means review again.
    expect(pipeline.repo.get(doc.id)).toMatchObject({
      state: 'needs_review',
      preparedMime: 'application/pdf',
      reviewReason: 'auto-filing is off',
      error: null,
      attempts: 0,
    });
  });
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - Change the inbox import: add `import { InboxBlobMissingError } from '../documents/inbox-store.js';` after the `pipeline.js` import.
  - `restartState` becomes:

```ts
/** Where a failed document picks up on retry: as late as what it already has allows. */
function restartState(d: DocumentRow): DocumentState {
  // An analysed document is prepared again: a failure there may have cost its text layer or thumbnail.
  return d.decision ? 'filing' : d.analysis ? 'preparing' : 'received';
}
```

  - In `documentRoutes`, before `r.get('/:id', …)`:

```ts
  r.get('/:id/thumbnail', (c) => {
    const doc = repo.get(c.req.param('id'));
    if (!doc || !doc.hasThumbnail || doc.state === 'filed' || !inbox.has(doc.id, 'thumbnail')) {
      return c.json({ error: 'not_found' }, 404);
    }
    let jpeg: Uint8Array<ArrayBuffer>;
    try {
      // Copied into a plain Uint8Array<ArrayBuffer>: a Buffer is not a BodyInit to the type checker.
      jpeg = new Uint8Array(inbox.get(doc.id, 'thumbnail'));
    } catch (err) {
      // Filing deletes the inbox blobs, and may have done so since has().
      if (err instanceof InboxBlobMissingError) return c.json({ error: 'not_found' }, 404);
      throw err;
    }
    return new Response(jpeg, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' },
    });
  });
```

- [ ] **Step 4: Run the test file, the server suite and the typecheck.**

- [ ] **Step 5: Commit.** `git commit -m "feat(http): serve document thumbnails, and re-prepare retried documents"`

---

## Task 6: PWA: thumbnail and note

**Files:**
- Modify: `pwa/src/documents/types.ts`, `pwa/src/ui/inbox/ReviewCard.tsx`, `pwa/src/ui/inbox/DocumentRows.tsx`, `pwa/src/theme/theme.css`, `pwa/tests/documents/fixtures.ts`
- Test: `pwa/tests/ui/ReviewCard.test.tsx`, `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `fixtures.ts`: `makeDoc` gets `prepareNote: null,` and `hasThumbnail: false,` after `discardedAt: null,`.
  - Append to `describe('ReviewCard')`:

```tsx
  it('shows the first-page thumbnail when there is one', () => {
    renderCard(makeDoc({ id: 'a/b c', hasThumbnail: true }));
    const img = screen.getByRole('img', { name: 'First page preview' });
    expect(img).toHaveAttribute('src', '/api/documents/a%2Fb%20c/thumbnail');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('shows no thumbnail without one', () => {
    renderCard();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('hides a thumbnail that fails to load', () => {
    renderCard(makeDoc({ hasThumbnail: true }));
    const img = screen.getByRole('img', { name: 'First page preview' }) as HTMLImageElement;
    fireEvent.error(img);
    expect(img.hidden).toBe(true);
  });

  it('shows the preparation note, muted', () => {
    renderCard(makeDoc({ prepareNote: 'Filed without a text layer: OCR failed.' }));
    expect(screen.getByText('Filed without a text layer: OCR failed.')).toHaveClass('muted');
  });
```

  - `InboxScreen.test.tsx`, in `'lists filed documents with who filed them and a Drive link'`: the second `makeDoc` gets `prepareNote: 'Filed without a text layer: OCR took too long.',` (before `filed:`), and after the `open in drive` assertion add:

```tsx
    expect(within(filed).getByText('Filed without a text layer: OCR took too long.')).toBeInTheDocument();
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - `types.ts`: add `prepareNote: string | null;` and `hasThumbnail: boolean;` to `DocumentView`, after `discardedAt`.
  - `ReviewCard.tsx`: put the image first inside the article:

```tsx
      {/* Hidden if it won't load (a signed-out session, a document filed meanwhile) rather than shown broken. */}
      {doc.hasThumbnail && (
        <img
          class="review-thumb"
          src={`/api/documents/${encodeURIComponent(doc.id)}/thumbnail`}
          alt="First page preview"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).hidden = true;
          }}
        />
      )}
```

    Add `{doc.prepareNote && <p class="muted">{doc.prepareNote}</p>}` after the rationale line.
  - `DocumentRows.tsx` `FiledRow`: after `<div class="muted">{doc.filed?.folderPath ?? ''}</div>` add `{doc.prepareNote && <div class="muted">{doc.prepareNote}</div>}`.
  - `theme.css`, after `.review-card .rationale { … }`:

```css
.review-thumb { float: right; width: 96px; margin: 0 0 8px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); }
@media (min-width: 600px) { .review-thumb { width: 140px; } }
.review-card::after { content: ''; display: block; clear: both; }
```

  The image is same-origin, so the session cookie goes with it (SameSite=Strict allows a same-site subresource), and the service worker doesn't intercept `/api`.

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
- Their own dependencies (Tesseract, Python, qpdf, pikepdf, Pillow, jbig2enc, pngquant, unpaper) are pulled in unpinned, so they follow the pinned versions.
- Renovate's `apk` datasource bumps the pins (`renovate.json`, `branch=v3.24`, `community` merged). CI's smoke step (Task 8) runs each bump against the real tools.

If a pinned version is no longer in the Alpine 3.24 index when you build, use `apk policy <pkg>` in the base image to find the current one. Use that, and say so in your report.

- [ ] **Step 2: Build the image.** `docker build -t doc-scanner:prepare .`, then record its size: `docker run --rm --entrypoint sh doc-scanner:prepare -c 'du -sxm /'` (compare with the same on an image built from `main`; `docker image inspect --format '{{.Size}}'` overstates it with the containerd image store).

- [ ] **Step 3: Commit.** `git commit -m "build(docker): add ocrmypdf, img2pdf and Ghostscript to the image"`

---

## Task 8: Docker smoke script, locally and in CI

**Files:**
- Create: `server/scripts/smoke-prepare.ts`
- Modify: `.github/workflows/ci.yml`

This exercises the real tools inside the built image. The runtime image doesn't contain `server/scripts`, so the script is mounted in. Always run the image with `--init`: a PID 1 that reaps killed tool processes, as tini does in production.

- [ ] **Step 1: Write the script.** `server/scripts/smoke-prepare.ts`:

```ts
/**
 * Exercises the real preparation tools inside the built Docker image (CI runs
 * it on every build). Run it with an init process (`docker run --init`).
 * Prints one line per check, never document text; exits non-zero on a failure.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { runTool, ToolTimeoutError } from '../src/prepare/run.js';
import { createPrepareTools } from '../src/prepare/tools.js';

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}`);
  if (!ok) failures++;
}

/** Adds an (unsigned) signature to a PDF's form, as ocrmypdf checks for one. pikepdf comes with ocrmypdf. */
const SIGN = `
import sys, pikepdf
from pikepdf import Array, Dictionary, Name, String
pdf = pikepdf.open(sys.argv[1])
sig = pdf.make_indirect(Dictionary(Type=Name.Sig, Filter=Name('/Adobe.PPKLite'), SubFilter=Name('/adbe.pkcs7.detached'), ByteRange=Array([0, 0, 0, 0]), Contents=String(bytes(64))))
field = pdf.make_indirect(Dictionary(FT=Name.Sig, T=String('Signature1'), V=sig, Type=Name.Annot, Subtype=Name.Widget, Rect=Array([0, 0, 0, 0]), P=pdf.pages[0].obj))
pdf.pages[0].obj.Annots = Array([field])
pdf.Root.AcroForm = Dictionary(Fields=Array([field]), SigFlags=3)
pdf.save(sys.argv[2])
`;

const doc = await PDFDocument.create({ updateMetadata: false });
const font = await doc.embedFont(StandardFonts.Helvetica);
const first = doc.addPage([612, 792]);
first.drawText('Northwind Energy', { x: 56, y: 720, size: 28, font });
first.drawText('Electricity Bill - September 2026', { x: 56, y: 680, size: 18, font });
const born = await doc.save();

const tools = createPrepareTools();
const page = await tools.thumbnail(born, 'application/pdf', { width: 1275 });
check('Ghostscript renders a PDF page', page !== null);
const imageOnly = await tools.imageToPdf(page!, 'image/jpeg');
check('img2pdf makes a PDF from a JPEG', Buffer.from(imageOnly.subarray(0, 5)).toString() === '%PDF-');
check('a born-digital PDF is left unchanged', (await tools.ocrPdf(born)).kind === 'unchanged');
check('an image-only PDF gains a text layer', (await tools.ocrPdf(imageOnly)).kind === 'ocred');
check('thumbnails a PDF', (await tools.thumbnail(born, 'application/pdf')) !== null);
check('thumbnails a JPEG', (await tools.thumbnail(page!, 'image/jpeg')) !== null);

const dir = await mkdtemp(join(tmpdir(), 'smoke-'));
try {
  await writeFile(join(dir, 'in.pdf'), born);
  const enc = await runTool('qpdf', ['--encrypt', 'u', 'o', '256', '--', 'in.pdf', 'enc.pdf'], { timeoutMs: 30_000, cwd: dir });
  check('qpdf encrypts a copy', enc.code === 0);
  check('an encrypted PDF is kept as it is', (await tools.ocrPdf(new Uint8Array(await readFile(join(dir, 'enc.pdf'))))).kind === 'protected');

  const sign = await runTool('python3', ['-I', '-c', SIGN, 'in.pdf', 'signed.pdf'], { timeoutMs: 30_000, cwd: dir });
  check('pikepdf adds a signature field', sign.code === 0);
  check('a signed PDF is kept as it is', (await tools.ocrPdf(new Uint8Array(await readFile(join(dir, 'signed.pdf'))))).kind === 'protected');

  // ocrmypdf must keep its work files (page images, recognised text) under
  // TMPDIR, so a killed job leaves nothing in the shared temporary directory.
  const many = await PDFDocument.create();
  const image = await many.embedJpg(page!);
  for (let i = 0; i < 40; i++) many.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  await writeFile(join(dir, 'many.pdf'), await many.save());
  const before = new Set(await readdir(tmpdir()));
  let killed = false;
  try {
    await runTool('ocrmypdf', ['--skip-text', '--output-type', 'pdf', '--jobs', '2', '-l', 'eng', 'many.pdf', 'out.pdf'], {
      timeoutMs: 2000,
      cwd: dir,
      env: { TMPDIR: dir },
    });
  } catch (err) {
    killed = err instanceof ToolTimeoutError;
  }
  const outside = (await readdir(tmpdir())).filter((f) => f.startsWith('ocrmypdf') && !before.has(f));
  const inside = (await readdir(dir)).filter((f) => f.startsWith('ocrmypdf'));
  check('a killed OCR leaves its work files only in its job directory', killed && outside.length === 0 && inside.length > 0);
} finally {
  await rm(dir, { recursive: true, force: true });
}

process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 2: Run it in the image.**

```bash
docker run --rm --init -v "$PWD/server/scripts:/app/server/scripts:ro" --entrypoint sh doc-scanner:prepare \
  -c "cd server && node --import tsx scripts/smoke-prepare.ts"
```

All checks print `ok`. Also run the unit and integration tests in the image (the image keeps the server's dev dependencies, vitest included; with no vitest config copied in, vitest's defaults pick up the integration file too):

```bash
docker run --rm --init -v "$PWD/server:/src:ro" --entrypoint sh doc-scanner:prepare -c \
  "cp -r /src/tests /app/server/tests && cd /app/server && NODE_OPTIONS=--import=tsx node_modules/.bin/vitest run tests/prepare"
```

All pass, the real-binaries integration test included.

- [ ] **Step 3: Run it in CI.** In `.github/workflows/ci.yml`, job `docker-build`, add `load: true` to the `Build ${{ matrix.platform }}` step's `with:` (after `push: false`), so the image lands in the runner's Docker:

```yaml
          push: false
          # Loaded into the runner's Docker, so the smoke step can run it.
          load: true
```

  and add a step after it, at the same indentation as the build step:

```yaml
      - name: Smoke-test the OCR tools (${{ matrix.platform }})
        # The real ocrmypdf, img2pdf and Ghostscript in the built image. Catches
        # an apk bump that changes their output or exit codes, which the sidecar
        # check and the protected-PDF detection rely on. --init reaps killed tools.
        run: |
          docker run --rm --init \
            -v "$PWD/server/scripts:/app/server/scripts:ro" \
            --entrypoint sh doc-scanner:ci \
            -c "cd server && node --import tsx scripts/smoke-prepare.ts"
```

  Check the workflow: `actionlint -ignore 'label ".+" is unknown' .github/workflows/ci.yml` (Homebrew; it runs shellcheck on the `run:` script too, and the ignore covers the `ubuntu-26.04` labels its list doesn't know yet). Without actionlint, at least parse it: `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml")'`.

- [ ] **Step 4: Commit.** `git commit -m "test(server): smoke-test the OCR tools in the Docker image, locally and in CI"`

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/observability.md`, the spec

- [ ] **Step 1: `CLAUDE.md`.**
  - In the server architecture list, add a `prepare/` bullet:
    - what runs (ocrmypdf `--skip-text`, img2pdf for document photos, Ghostscript and sharp for thumbnails);
    - the fallback rule (a tool missing, failing or timing out files the original, with `prepare_note`);
    - safety (no shell, a private temporary directory that is also the tools' `TMPDIR` and is removed afterwards, stale ones swept at start, a process-group kill on timeout, tool output never logged);
    - local development: the tools are optional, `brew install ocrmypdf img2pdf`, and the unit tests use fakes.
  - In the documents bullet, note that an unusable analysis also goes through `preparing`, then to review with its reason.
  - Mention the Docker smoke script, that CI runs it on every image build, and that the image must run with an init (`--init`, or tini as in production).
- [ ] **Step 2: `README.md`.** Mark slice 3 as done in the status paragraph. If the README has a deploy or image-size note, add the ~319 MB OCR tooling.
- [ ] **Step 3: `docs/observability.md`.** Add a row: "Preparation fell back to the original (OCR tool missing, failed or timed out)", tagged `document.stage: prepare`, with the error type only. The document is still filed. Make sure the existing `document.stage` description doesn't claim `prepare` only means "failed after 3 attempts"; reword the row if it does.
- [ ] **Step 4: Spec.**
  - In "Delivery slices", give slice 3 this plan's path.
  - In §4, note the measured size and the decisions above: `--skip-text` with the sidecar test, protected PDFs (password, signature, XFA; owner-only passwords are processed), the photo types (BMP through img2pdf), the timeouts, and the limitations below.
  - In §1's state diagram, show that an unusable analysis goes `analyzing → preparing → ready → needs_review`.
- [ ] **Step 5: Commit.** `git commit -m "docs: describe preparing documents with OCR and thumbnails"`

---

## Task 10: Verify end to end, then open the PR

- [ ] **Step 1: Full checks.** Run both suites and both typechecks, `pnpm --filter @doc-scanner/pwa build`, the Docker build, and both Task 8 `docker run` commands.
- [ ] **Step 2: Browser run (Playwright, with the user)**, against the **Docker image**, so the real tools are used.
  - Start it like this:

    ```bash
    docker run --rm --init -p 3000:3000 -e SESSION_ENCRYPTION_KEY=… -e ANTHROPIC_API_KEY=… -e INSECURE_COOKIES=true -e PWA_DIST_PATH=/app/pwa/dist -v <tmp>:/data doc-scanner:prepare
    ```

    Take the API key from 1Password inline (`op read …`). Never write it to disk.
  - The user signs in through the Playwright window.
  - Generate fictional test files into the repo's locally excluded `.playwright-mcp/`:
    - an image-only PDF (a rasterised fictional bill);
    - a JPEG photo of one;
    - a born-digital PDF.
  - Upload each with **Add**, then check:
    1. Each reaches Needs review with a thumbnail on its card.
    2. The image-only PDF and the photo become searchable PDFs. Show it from the server side: `<tmp>/inbox/<id>.prepared.bin` exists for both (`preparedMime` alone proves nothing for a PDF, which is a PDF either way), the photo's row has `preparedMime: application/pdf`, and neither has a `prepareNote`.
    3. The born-digital PDF is unchanged: there is no `<tmp>/inbox/<id>.prepared.bin`.
    4. **Only with the user's yes:** approve the scanned bill into a test folder and confirm the filed file is searchable in Drive.
  - Ask before filing anything into the real Drive.
- [ ] **Step 3: Open the PR.**
  - Title: `feat(server): searchable PDFs and thumbnails (AI filing slice 3)`.
  - The description includes the measured image size, the decisions above, and the known limitations below.
  - Follow the repo's PR workflow.

---

## Known limitations and follow-ups

- **`--skip-text` skips a page with any text.** A scan whose pages carry a little digital text (a copier's header, a Bates or page-number stamp) is treated as born-digital and stays unsearchable. `--redo-ocr` would handle it, at the cost of re-processing every born-digital PDF; revisit if real use shows such scans.
- **The container runs as root.** Ghostscript and ocrmypdf parse untrusted PDFs as root inside it (`-dSAFER` sandboxes Ghostscript's file access, but not a parser bug). Follow-up: run the image as the `node` user, which needs the `/data` volume's ownership handled for existing installs.
- **One worker, one document at a time.** A long OCR (up to the 5-minute limit, about 60 noisy pages on 2 cores) holds up every other document, filings included. Fine for personal use; revisit if it bites.
- **Owner-password-only PDFs** are OCR'd when image-only, and the output drops the owner restrictions (see Decisions).
