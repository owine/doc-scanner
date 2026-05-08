# Phase 5 — AI Vision Organize Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phone captures pages → server-side Haiku 4.5 vision OCRs + suggests filename + folder in one call → PWA assembles searchable PDF locally → user confirms → PDF lands in Proton Drive. Offline-resilient via outbox + background sync. **No client-side Tesseract** (retired after iOS Safari incompatibilities surfaced).

**Architecture:** Vertical slices: (0) folder cache → (1) vision classify → (2) PDF + upload → (3) FTS5 few-shot history → (4) outbox + background sync. Phase 4's `pdf/build.ts` and `scans-store` v2 schema are retained; everything under `pwa/src/ocr/` and the vendored tesseract assets are deleted.

**Tech Stack:** Server — Node 24 / Hono / TypeScript / better-sqlite3 (FTS5) / `@anthropic-ai/sdk` (multi-image vision tool-use) / `sharp` / vendored Proton Drive SDK. PWA — Preact / Vite / IndexedDB (`idb`) / `@cantoo/pdf-lib` / hand-written Service Worker.

**Spec:** `docs/superpowers/specs/2026-05-08-phase-5-ai-organize-design.md` — read first; v2 supersedes the v1 client-OCR design.

---

## Pre-Phase-5 Prerequisites

### Pre-Task A: Merge `phase-4-ocr-pdf` to main as-is

The branch contains both the now-defunct client-OCR code and the still-useful pieces (`pdf/build.ts`, `scans-store` v2, `ScanViewerScreen` download, the spec/plan docs themselves). Rather than cherry-pick selectively, merge as-is and let Phase 5's first task delete what's no longer needed. CI passes (broken iOS-Safari path is silent on desktop test environments). Phase 5's first task immediately removes the dead code, so main is only briefly carrying it.

- [ ] **Step A.1** — From `phase-4-ocr-pdf`: `git rebase main` (resolve any lockfile conflicts with `--theirs` then `npm install`).
- [ ] **Step A.2** — Push: `git push origin phase-4-ocr-pdf`.
- [ ] **Step A.3** — `gh pr create --base main --title "Phase 4: OCR + searchable PDF (client OCR retired in Phase 5)" --body "..."`. PR description notes that client-side Tesseract did not work on iOS Safari and Phase 5 retires it in favour of Haiku vision.
- [ ] **Step A.4** — Wait for CI green. Merge.

### Pre-Task B: Branch `phase-5-ai-organize`

- [ ] **Step B.1** — On a clean main: `git pull && eval "$(fnm env)" && fnm use 24.15.0 && npm install`. Verify lockfile diff is empty.
- [ ] **Step B.2** — `git checkout -b phase-5-ai-organize`.
- [ ] **Step B.3** — `git push -u origin phase-5-ai-organize`.

---

## Slice 0 — Phase 4 Retirement + Folder Cache

### Task 0.0: Retire Phase 4 client OCR

**Files (deletions / modifications):**
- Delete: `pwa/src/ocr/` (entire directory: types.ts, tesseract-worker.ts, worker-client.ts, queue.ts + tests)
- Delete: `pwa/public/ocr/eng.traineddata.gz`
- Delete: `pwa/public/ocr/README.md` (or update if generic)
- Delete: `pwa/scripts/copy-tesseract-assets.mjs`
- Modify: `pwa/package.json` — remove `predev` + `prebuild` scripts; remove `tesseract.js` dep
- Modify: `pwa/public/sw.js` — remove `/ocr/*` and `/assets/ocr-core-*` cache patterns; bump CACHE_NAME
- Modify: `pwa/vite.config.ts` — remove `ocr/queue`/`ocr/worker-client` mention from `manualChunks`
- Modify: `pwa/src/scanner/types.ts` — remove `PdfStatus`, `ocrText`/`ocrWords` fields on Page (kept later, but renamed to come from server)
- Modify: `pwa/src/scanner/scans-store.ts` — remove OCR queue integration, drop `pdfStatus`/`ocrError`-related methods. Keep page blob storage + PDF blob storage.
- Modify: `pwa/src/ui/SavedScansScreen.tsx` — replace OCR progress labels with simple upload-status labels (slice 1 will fully populate these).
- Modify: `pwa/src/ui/App.tsx` — remove `OcrQueue` instantiation
- Modify: `pwa/src/ui/ScannerScreen.tsx` — `done()` no longer enqueues OCR; sets `uploadStatus='pending_classify'` (slice 1 wires this).
- Modify: `.gitignore` — remove tesseract vendored-asset entries
- Modify: `package.json` (root) — remove `tesseract.js` dep if it's at root

- [ ] **Step 0.0.1** — Run the deletions: `rm -rf pwa/src/ocr pwa/public/ocr/eng.traineddata.gz pwa/public/ocr/README.md pwa/scripts/copy-tesseract-assets.mjs`.
- [ ] **Step 0.0.2** — Update `pwa/package.json` (delete predev/prebuild + tesseract.js dep).
- [ ] **Step 0.0.3** — Update root `package.json` if tesseract.js is hoisted.
- [ ] **Step 0.0.4** — `npm install` to update lockfile.
- [ ] **Step 0.0.5** — Update `pwa/public/sw.js` (drop OCR cache patterns; bump `CACHE_NAME` to `docscanner-scanner-v7`).
- [ ] **Step 0.0.6** — Update `pwa/vite.config.ts` (drop OCR chunk routing).
- [ ] **Step 0.0.7** — Update `pwa/src/scanner/types.ts`: drop `PdfStatus`. The `Page` interface keeps `blob` but drops `ocrText`/`ocrWords` (these will come from server in slice 1; new fields on `Scan` will hold them).
- [ ] **Step 0.0.8** — Update `pwa/src/scanner/scans-store.ts`: drop `setPdfStatus`, `findPendingPdf`, `clearScanOcr`. Drop the `pdfs` blob-store usage for storing in-progress PDF (we'll re-add as `pdfBlob` field on Scan in slice 2). Run remaining tests; expect failures, fix or delete obsolete tests.
- [ ] **Step 0.0.9** — Update `pwa/src/ui/SavedScansScreen.tsx`: replace `pdfStatus` labels with placeholder `uploadStatus` labels (`Idle` / `Processing...` / `Ready` etc.). Slice 1 will wire actual states.
- [ ] **Step 0.0.10** — Update `pwa/src/ui/App.tsx` + `ScannerScreen.tsx` to remove `OcrQueue` references.
- [ ] **Step 0.0.11** — Run `npm test` from root. Fix any compile errors / dropped tests.
- [ ] **Step 0.0.12** — Run `npm --workspaces run typecheck` and `npm --workspaces run build`. Both should pass.
- [ ] **Step 0.0.13** — Commit: `chore(pwa): retire client-side Tesseract OCR (replaced by Haiku vision in Phase 5)`. The commit message should explicitly note that Phase 5 v2 spec replaces this functionality.

### Task 0.1: `server/src/drive/folder-cache.ts`

**Files:**
- Create: `server/src/drive/folder-cache.ts`
- Test: `server/src/drive/folder-cache.test.ts`

- [ ] **Step 0.1.1** — Write failing test for empty Drive (only root, no children):

```ts
import { describe, it, expect, vi } from 'vitest';
import { FolderCache } from './folder-cache.js';

function fakeSdk(tree: Record<string, Array<{ uid: string; name: string; type: string }>>) {
  async function* iter(uid: string) {
    for (const child of tree[uid] ?? []) yield { ok: true, value: child };
  }
  return {
    getMyFilesRootFolder: vi.fn().mockResolvedValue({ ok: true, value: { uid: 'root', name: 'My Files' } }),
    iterateFolderChildren: iter,
  };
}

describe('FolderCache', () => {
  it('returns just the root path when no subfolders exist', async () => {
    const cache = new FolderCache(fakeSdk({}) as never);
    await cache.refresh();
    expect(cache.getTree()).toEqual([{ linkId: 'root', path: '/' }]);
  });
});
```

- [ ] **Step 0.1.2** — Run: FAIL (module not found).

- [ ] **Step 0.1.3** — Implement minimal:

```ts
// server/src/drive/folder-cache.ts
import type { ProtonDriveClient } from '@protontech/drive-sdk';

interface FolderEntry { linkId: string; path: string; }

function unwrap<T>(maybe: { ok: true; value: T } | { ok: false }): T {
  if (!maybe.ok) throw new Error('SDK returned non-ok result');
  return maybe.value;
}

export class FolderCache {
  private tree: FolderEntry[] = [];

  constructor(private readonly sdk: Pick<ProtonDriveClient, 'getMyFilesRootFolder' | 'iterateFolderChildren'>) {}

  getTree(): FolderEntry[] { return this.tree; }

  async refresh(): Promise<void> {
    const root = unwrap(await this.sdk.getMyFilesRootFolder());
    const out: FolderEntry[] = [{ linkId: root.uid, path: '/' }];
    await this.walk(root.uid, '/', out);
    this.tree = out;
  }

  private async walk(folderUid: string, parentPath: string, out: FolderEntry[]): Promise<void> {
    for await (const childMaybe of this.sdk.iterateFolderChildren(folderUid)) {
      if (!childMaybe.ok) continue;
      const child = childMaybe.value;
      if (String(child.type) !== 'folder') continue;
      const path = parentPath === '/' ? `/${child.name}` : `${parentPath}/${child.name}`;
      out.push({ linkId: child.uid, path });
      await this.walk(child.uid, path, out);
    }
  }
}
```

- [ ] **Step 0.1.4** — Run: PASS.

- [ ] **Step 0.1.5** — Add tests one at a time. Order is **depth-first, parent-before-children**:
  - Two top-level folders → root + 2.
  - Nested 2 levels → all paths returned.
  - Skips files (type ≠ 'folder').
  - `refresh()` replaces (not appends).

- [ ] **Step 0.1.6** — Commit: `feat(drive): folder-cache walks Drive tree, exposes flattened path list`.

### Task 0.2: `GET /api/drive/folders` route

**Files:**
- Modify: `server/src/http/routes-drive.ts`
- Test: `server/src/http/routes-drive.test.ts` (create or extend)

- [ ] **Step 0.2.1** — Write happy-path test (FolderCache mocked).
- [ ] **Step 0.2.2** — Add route to `driveRoutes(deps)`:

```ts
r.get('/folders', async (c) => {
  const auth = c.get('auth');
  if (!auth?.liveSession) return c.json({ error: 'not_authenticated' }, 401);
  if (c.req.query('refresh') === '1') await auth.liveSession.folderCache.refresh();
  return c.json({ folders: auth.liveSession.folderCache.getTree() });
});
```

- [ ] **Step 0.2.3** — Wire `FolderCache` instantiation: extend `liveSession` to include a lazily-initialised `folderCache: FolderCache`. Per-session lifetime (folder UIDs differ per Proton account; singleton would leak state).
- [ ] **Step 0.2.4** — Three tests green (happy path, refresh, unauth).
- [ ] **Step 0.2.5** — Commit: `feat(server): GET /api/drive/folders returns walked Drive tree`.

### Task 0.3: PWA `api.getFolders()`

**Files:**
- Modify: `pwa/src/api.ts`
- Test: `pwa/src/api.test.ts` (additions)

- [ ] **Step 0.3.1** — TDD `getFolders()`: happy + refresh + 401 throws (3 tests).
- [ ] **Step 0.3.2** — Implement:

```ts
export async function getFolders(refresh = false): Promise<{ folders: { linkId: string; path: string }[] }> {
  const url = refresh ? '/api/drive/folders?refresh=1' : '/api/drive/folders';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`getFolders failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 0.3.3** — Commit: `feat(pwa): api.getFolders() hits new server route`.

---

## Slice 1 — Vision Classify

End state: scan multi-page → server returns OCR + suggestion → ConfirmCard renders. No PDF assembly or upload yet.

### Task 1: Install slice-1 server deps

- [ ] **Step 1.1** — `npm --workspace @doc-scanner/server install @anthropic-ai/sdk sharp`.
- [ ] **Step 1.2** — Verify pinned versions; `npm ls sharp` shows correct prebuild for dev arch.
- [ ] **Step 1.3** — Commit: `feat(deps): add @anthropic-ai/sdk and sharp for Phase 5 vision classify`.

### Task 2: `server/src/classify/image.ts`

**Files:**
- Create: `server/src/classify/image.ts`
- Test: `server/src/classify/image.test.ts`

- [ ] **Step 2.1** — Write failing test for small PNG pass-through.
- [ ] **Step 2.2** — Run: FAIL.
- [ ] **Step 2.3** — Implement:

```ts
// server/src/classify/image.ts
import sharp from 'sharp';

export class UndecodableImageError extends Error {}

const MAX_LONG_EDGE = 1024;
const MAX_BYTES = 1.5 * 1024 * 1024;

export async function normaliseForClassify(input: Uint8Array): Promise<Uint8Array> {
  let meta;
  try { meta = await sharp(input).metadata(); }
  catch { throw new UndecodableImageError('sharp could not decode input bytes'); }
  if (!meta.format) throw new UndecodableImageError('unrecognised format');

  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const formatOk = meta.format === 'jpeg' || meta.format === 'png';
  if (formatOk && longEdge <= MAX_LONG_EDGE && input.byteLength <= MAX_BYTES) {
    return input;
  }
  // Re-encode as JPEG q=85 — smaller payload than PNG for photos; OCR
  // quality unchanged at 1024px since text is a tiny fraction of the byte
  // budget. Document scans encode well as JPEG without visible artifacts.
  const buf = await sharp(input)
    .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(buf);
}
```

- [ ] **Step 2.4** — Run: PASS.
- [ ] **Step 2.5** — Add 3 more tests one at a time:
  - 4000×3000 PNG → JPEG, ≤1024 long-edge, ≤1.5 MB.
  - Corrupt header → throws `UndecodableImageError`.
  - Performance: 4000×3000 normalises in <200 ms.
- [ ] **Step 2.6** — Commit: `feat(classify): image.ts normalises to ≤1024px JPEG for vision input`.

### Task 3: `server/src/classify/haiku.ts` — multi-image vision tool-use

**Files:**
- Create: `server/src/classify/haiku.ts`
- Create: `server/src/classify/types.ts`
- Test: `server/src/classify/haiku.test.ts`

- [ ] **Step 3.1** — Define types:

```ts
// server/src/classify/types.ts
export interface ClassifyInput {
  pages: Uint8Array[];
  folders: { linkId: string; path: string }[];
  examples?: PastExample[];
}
export interface PastExample {
  ocrSnippet: string;
  finalName: string;
  folderPath: string;
}
export interface ClassifyResult {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
  pageOcr: PageOcr[];
}
export interface PageOcr {
  text: string;
  words: { text: string; x: number; y: number; w: number; h: number }[];
}
```

- [ ] **Step 3.2** — Write failing single-page happy-path test (Anthropic SDK mocked).

```ts
// classify/haiku.test.ts (sketch)
mockCreate.mockResolvedValue({
  content: [{
    type: 'tool_use', name: 'extract_and_suggest',
    input: {
      suggestedName: 'Tax Receipt 2026',
      suggestedFolderLinkId: 'folder-tax',
      confidence: 0.9,
      rationale: 'IRS Form 1040',
      pageOcr: [{ text: 'IRS Form 1040', words: [{ text: 'IRS', x: 0.1, y: 0.1, w: 0.1, h: 0.05 }] }],
    },
  }],
  usage: { input_tokens: 1500, output_tokens: 200 },
});
const result = await classify({
  pages: [new Uint8Array([0xff, 0xd8])],   // JPEG magic bytes
  folders: [{ linkId: 'folder-tax', path: '/Tax' }],
});
expect(result?.pageOcr.length).toBe(1);
expect(result?.suggestedName).toBe('Tax Receipt 2026');
```

- [ ] **Step 3.3** — Implement (force tool-use, multi-image content blocks):

```ts
// server/src/classify/haiku.ts
import Anthropic from '@anthropic-ai/sdk';
import type { ClassifyInput, ClassifyResult, PastExample } from './types.js';
import { logger } from '../logger.js';

export class ImageTooLargeError extends Error {}

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;

const FILING_TOOL = {
  name: 'extract_and_suggest',
  description: 'Extract OCR text from each page and propose a filename and destination folder.',
  input_schema: {
    type: 'object' as const,
    required: ['suggestedName', 'suggestedFolderLinkId', 'confidence', 'rationale', 'pageOcr'],
    properties: {
      suggestedName: { type: 'string' as const, description: 'Filename without extension. ASCII, no slashes, ≤80 chars.' },
      suggestedFolderLinkId: { type: 'string' as const, description: 'Must be one of the linkIds from the provided folders list.' },
      confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
      rationale: { type: 'string' as const, maxLength: 200 },
      pageOcr: {
        type: 'array' as const,
        description: 'Per-page OCR results, in input page order.',
        items: {
          type: 'object' as const,
          required: ['text', 'words'],
          properties: {
            text: { type: 'string' as const },
            words: {
              type: 'array' as const,
              items: {
                type: 'object' as const,
                required: ['text', 'x', 'y', 'w', 'h'],
                properties: {
                  text: { type: 'string' as const },
                  x: { type: 'number' as const, minimum: 0, maximum: 1 },
                  y: { type: 'number' as const, minimum: 0, maximum: 1 },
                  w: { type: 'number' as const, minimum: 0, maximum: 1 },
                  h: { type: 'number' as const, minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: TIMEOUT_MS });
  return client;
}

function sanitiseName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9 .,'_-]/g, '').slice(0, 80).trim();
  return cleaned.length > 0 ? cleaned : 'Document';
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function formatExamples(examples: PastExample[] | undefined): string {
  if (!examples?.length) return '';
  return ['<examples>', ...examples.map((e) => `OCR: ${e.ocrSnippet}  →  filed as "${e.finalName}" in ${e.folderPath}`), '</examples>'].join('\n');
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult | null> {
  for (const page of input.pages) {
    if (page.byteLength > MAX_IMAGE_BYTES) throw new ImageTooLargeError(`page ${page.byteLength} > ${MAX_IMAGE_BYTES}`);
  }
  const folderLines = input.folders.map((f) => `${f.linkId}: ${f.path}`).join('\n');
  const examplesBlock = formatExamples(input.examples);
  const imageBlocks = input.pages.map((page) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: Buffer.from(page).toString('base64') },
  }));

  const start = performance.now();
  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4000,    // larger budget than v1: per-page OCR for multi-page docs
      tool_choice: { type: 'tool', name: FILING_TOOL.name },
      tools: [FILING_TOOL],
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `For each page image below, extract OCR text (full reading order) and word bounding boxes (normalised 0-1). Then suggest a filename and destination folder for the entire document.\n\nAvailable folders:\n${folderLines}`,
            cache_control: { type: 'ephemeral' },
          },
          ...imageBlocks,
          ...(examplesBlock ? [{ type: 'text' as const, text: examplesBlock }] : []),
        ],
      }],
    });
  } catch (err) {
    logger.warn({ err }, 'classify: anthropic call failed');
    return null;
  }

  const block = response.content.find((b: { type: string }) => b.type === 'tool_use') as
    | { type: 'tool_use'; input: Record<string, unknown> } | undefined;
  if (!block) {
    logger.warn({ response }, 'classify: no tool_use block in response');
    return null;
  }
  const raw = block.input as Partial<ClassifyResult>;
  if (!raw.suggestedName || !raw.suggestedFolderLinkId
      || typeof raw.confidence !== 'number' || typeof raw.rationale !== 'string'
      || !Array.isArray(raw.pageOcr) || raw.pageOcr.length !== input.pages.length) {
    logger.warn({ raw, expectedPages: input.pages.length }, 'classify: tool_use input malformed');
    return null;
  }

  const sanitisedName = NAME_REGEX.test(raw.suggestedName) ? raw.suggestedName : sanitiseName(raw.suggestedName);
  const folderOk = input.folders.some((f) => f.linkId === raw.suggestedFolderLinkId);
  const finalLinkId = folderOk ? raw.suggestedFolderLinkId : '';

  const pageOcr = raw.pageOcr.map((p) => ({
    text: typeof p.text === 'string' ? p.text : '',
    words: Array.isArray(p.words) ? p.words.map((w) => ({
      text: String(w.text ?? ''),
      x: clamp01(Number(w.x) || 0),
      y: clamp01(Number(w.y) || 0),
      w: clamp01(Number(w.w) || 0),
      h: clamp01(Number(w.h) || 0),
    })) : [],
  }));

  const elapsed = Math.round(performance.now() - start);
  logger.info({ elapsed, pages: input.pages.length, model: MODEL,
    inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens }, 'classify: ok');
  return { suggestedName: sanitisedName, suggestedFolderLinkId: finalLinkId, confidence: raw.confidence, rationale: raw.rationale, pageOcr };
}
```

- [ ] **Step 3.4** — Run: PASS on happy path.
- [ ] **Step 3.5** — Add 5 more tests one at a time:
  - Multi-page (3 pages in, 3 OCR out).
  - Page-count mismatch → null.
  - Hallucinated folder linkId → empty `suggestedFolderLinkId`.
  - SDK throws → null.
  - Page >3 MB raw → throws `ImageTooLargeError` (no API call).
- [ ] **Step 3.6** — All 6 tests green. Commit: `feat(classify): haiku.ts vision multi-image OCR + filing tool-use`.

### Task 4: `routes-classify.ts`

**Files:**
- Create: `server/src/http/routes-classify.ts`
- Modify: `server/src/http/server.ts`
- Test: `server/src/http/routes-classify.test.ts`

- [ ] **Step 4.1** — Inspect existing route conventions.
- [ ] **Step 4.2** — Write failing happy-path test (multi-page multipart):

```ts
const fd = new FormData();
fd.set('page_0', new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }), 'p0.jpg');
fd.set('page_1', new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }), 'p1.jpg');
const res = await app.request('/api/classify', { method: 'POST', body: fd });
```

- [ ] **Step 4.3** — Implement:

```ts
// server/src/http/routes-classify.ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ClassifyResult, PastExample } from '../classify/types.js';
import { normaliseForClassify, UndecodableImageError } from '../classify/image.js';

interface FolderCache { getTree(): { linkId: string; path: string }[]; }
interface History { findRecent(limit: number): PastExample[]; }

interface Deps {
  classify: (input: { pages: Uint8Array[]; folders: { linkId: string; path: string }[]; examples?: PastExample[] }) => Promise<ClassifyResult | null>;
  folderCache: FolderCache;
  history?: History;
}

export function classifyRoutes(deps: Deps) {
  const app = new Hono();
  app.post('/classify', bodyLimit({ maxSize: 20 * 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }), async (c) => {
    const form = await c.req.formData();
    const pages: Uint8Array[] = [];
    for (let i = 0; ; i++) {
      const part = form.get(`page_${i}`);
      if (!(part instanceof Blob)) break;
      try { pages.push(await normaliseForClassify(new Uint8Array(await part.arrayBuffer()))); }
      catch (err) {
        if (err instanceof UndecodableImageError) return c.json({ error: 'undecodable_image', page: i }, 422);
        throw err;
      }
    }
    if (pages.length === 0) return c.json({ error: 'no_pages' }, 400);

    const folders = deps.folderCache.getTree();
    const examples = deps.history?.findRecent(3) ?? [];
    const suggestion = await deps.classify({ pages, folders, examples });
    return c.json({ suggestion });
  });
  return app;
}
```

- [ ] **Step 4.4** — Add tests:
  - 21 MB body → 413.
  - Zero pages → 400.
  - Non-contiguous indices (page_0, page_2 but no page_1) → only page_0 considered (loop breaks).
  - Undecodable page → 422.
  - Classify returns null → 200 with `{ suggestion: null }`.
- [ ] **Step 4.5** — Wire into `server.ts`. Pass `auth.liveSession.folderCache`. Inject `history: undefined` for slice 1.
- [ ] **Step 4.6** — Commit: `feat(server): POST /api/classify wires multi-image vision pipeline`.

### Task 5: PWA scans-store — uploadStatus axis (slice 1 portion)

**Files:**
- Modify: `pwa/src/scanner/types.ts`
- Modify: `pwa/src/scanner/scans-store.ts`
- Test: `pwa/src/scanner/scans-store.test.ts`

- [ ] **Step 5.1** — Extend types:

```ts
export type UploadStatus = 'idle' | 'pending_classify' | 'awaiting_confirm' | 'pending_upload' | 'done';
export interface UploadSuggestion {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
}
export interface PageOcr {
  text: string;
  words: { text: string; x: number; y: number; w: number; h: number }[];
}
export interface Scan {
  // ... existing capture fields ...
  uploadStatus: UploadStatus;
  uploadError: string | null;
  suggestion?: UploadSuggestion;
  pageOcr?: PageOcr[];
  pdfBlob?: Blob;          // populated in slice 2 after assembly
  finalName?: string;
  finalFolderLinkId?: string;
  driveNodeUid?: string;
  driveWebUrl?: string;
}
```

- [ ] **Step 5.2** — Migrate scans-store to v3 schema (bump db version, default `uploadStatus='idle'`, `uploadError=null`).
- [ ] **Step 5.3** — TDD `setUploadStatus(scanId, next, patch?)` with transition map:

```ts
const ALLOWED: Record<UploadStatus, UploadStatus[]> = {
  idle: ['pending_classify'],
  pending_classify: ['awaiting_confirm'],
  awaiting_confirm: ['pending_upload', 'idle'],
  pending_upload: ['done' /* slice-4 adds 'needs_attention' */],
  done: [],
};
```

- [ ] **Step 5.4** — Tests (one at a time): legal idle → pending_classify, illegal done → pending_upload throws, awaiting_confirm → pending_upload writes `finalName`, pending_upload → done writes `driveNodeUid`/`driveWebUrl`, concurrent transitions serialised, `findPending()` returns pending rows ordered by `updatedAt`.
- [ ] **Step 5.5** — Add helper methods: `getPageBlobs(scanId)` (read all page blobs from store), `setSuggestionAndOcr(scanId, suggestion, pageOcr)` (atomic patch on classify response). 2 more tests.
- [ ] **Step 5.6** — All 8 tests green. Commit: `feat(pwa): scans-store uploadStatus axis + slice-1 helpers`.

### Task 6: PWA `api.classify()`

**Files:**
- Modify: `pwa/src/api.ts`
- Test: `pwa/src/api.test.ts`

- [ ] **Step 6.1** — TDD pre-flight size checks (per-page ≤ 2 MB, total ≤ 18 MB).
- [ ] **Step 6.2** — Implement:

```ts
export async function classify(pages: Blob[]): Promise<{ suggestion: ClassifyResult | null }> {
  if (pages.length === 0) throw new Error('no pages');
  let total = 0;
  for (const p of pages) {
    if (p.size > 2 * 1024 * 1024) throw new Error('page too large (PWA pre-flight)');
    total += p.size;
  }
  if (total > 18 * 1024 * 1024) throw new Error('total payload too large (PWA pre-flight)');
  const fd = new FormData();
  pages.forEach((p, i) => fd.set(`page_${i}`, p, `page_${i}.jpg`));
  const res = await fetch('/api/classify', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 413 || res.status === 422) return { suggestion: null };
    throw new Error(`classify failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 6.3** — Tests: happy multipart shape, 413/422 mapping, total-too-large pre-flight (4 tests).
- [ ] **Step 6.4** — Commit: `feat(pwa): api.classify() multi-page upload with pre-flight guards`.

### Task 7: PWA `ConfirmCard.tsx`

**Files:**
- Create: `pwa/src/ui/ConfirmCard.tsx`
- Test: `pwa/src/ui/ConfirmCard.test.tsx`

- [ ] **Step 7.1** — Inspect existing UI patterns (`SavedScansScreen.tsx` for style).
- [ ] **Step 7.2** — TDD render with full suggestion → fields pre-filled.
- [ ] **Step 7.3** — Implement (filename input with regex validation, folder picker, rationale + confidence badge, Save/Dismiss, Refresh-folders link):

```tsx
// pwa/src/ui/ConfirmCard.tsx
import { useState } from 'preact/hooks';
import type { UploadSuggestion } from '../scanner/types';

const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;

interface Props {
  scanId: string;
  suggestion: UploadSuggestion | null;
  folders: { linkId: string; path: string }[];
  onSave(name: string, folderLinkId: string): Promise<void>;
  onDismiss(): void;
  onRefreshFolders(): Promise<void>;
}

export function ConfirmCard({ suggestion, folders, onSave, onDismiss, onRefreshFolders }: Props) {
  const [name, setName] = useState(suggestion?.suggestedName ?? '');
  const [folderId, setFolderId] = useState(suggestion?.suggestedFolderLinkId ?? '');
  const [busy, setBusy] = useState(false);
  const valid = NAME_REGEX.test(name) && folderId.length > 0;

  return (
    <div class="confirm-card">
      <label>Filename<input aria-label="filename" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
      <label>Folder
        <select value={folderId} onChange={(e) => setFolderId((e.target as HTMLSelectElement).value)}>
          <option value="">— pick a folder —</option>
          {folders.map((f) => <option key={f.linkId} value={f.linkId}>{f.path}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => onRefreshFolders()}>↻ Refresh folders</button>
      {suggestion && (
        <p class="rationale">
          <em>{suggestion.rationale}</em>
          {suggestion.confidence < 0.6 && <span class="badge">Low confidence</span>}
        </p>
      )}
      <div class="actions">
        <button disabled={!valid || busy} onClick={async () => { setBusy(true); try { await onSave(name, folderId); } finally { setBusy(false); } }}>Save</button>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7.4** — Add 5 more tests one at a time.
- [ ] **Step 7.5** — Commit: `feat(pwa): ConfirmCard for AI suggestions`.

### Task 8: Wire scanner-session + App.tsx (slice 1 integration)

**Files:**
- Modify: `pwa/src/scanner/scanner-session.ts`
- Modify: `pwa/src/ui/App.tsx`

- [ ] **Step 8.1** — When scan transitions to `completed` (existing capture flow), set `uploadStatus='pending_classify'`.
- [ ] **Step 8.2** — App.tsx watches for `pending_classify` scans:
  - Read all page blobs via `scansStore.getPageBlobs(scanId)`.
  - Call `api.classify(pageBlobs)`.
  - On success: `scansStore.setSuggestionAndOcr(scanId, suggestion, pageOcr)` then `setUploadStatus('awaiting_confirm')`.
  - On failure / null suggestion: `setUploadStatus('awaiting_confirm', { suggestion: undefined, pageOcr: undefined })` (empty card; PDF won't get OCR layer).
- [ ] **Step 8.3** — Render `<ConfirmCard>` for `awaiting_confirm` scans. `onSave` for slice 1 stub: `setUploadStatus('idle')` + toast "would upload here".
- [ ] **Step 8.4** — Manual smoke (browser, not phone): scan → confirm card appears with mock suggestion (use a dev-mode mock if Anthropic key isn't yet active).
- [ ] **Step 8.5** — Commit: `feat(pwa): wire scan → classify → ConfirmCard end-to-end`.

### Task 9: Slice 1 acceptance + push

- [ ] **Step 9.1** — Full test suite, typecheck, build.
- [ ] **Step 9.2** — Push. CI green.

---

## Slice 2 — PDF Assembly + Upload

End state: scan → AI → user confirms → real PDF lands in Drive. Tag-worthy demoable milestone.

### Task 10: Empirical SDK collision-behaviour test

**Files:** none (manual). See spec for procedure.

- [ ] **Step 10.1** — Use existing `POST /api/drive/test-upload` to upload same name twice.
- [ ] **Step 10.2** — Capture SDK error shape; document in `server/src/drive/client.ts` comment block.
- [ ] **Step 10.3** — Commit (docs-only): `docs(drive): document Proton SDK name-collision behaviour`.

### Task 11: Extend `drive/client.ts::uploadFile`

**Files:**
- Modify: `server/src/drive/client.ts`
- Test: `server/src/drive/client.test.ts`

- [ ] **Step 11.1** — TDD back-compat (no opts → root folder).
- [ ] **Step 11.2** — Refactor signature; preserve behaviour when `opts` omitted. Add `UploadCollisionExhausted` class.
- [ ] **Step 11.3** — Implement collision retry per spec.
- [ ] **Step 11.4** — Add 4 more tests (with parentFolderUid, collision once succeeds with `(2)`, four collisions throws, non-collision propagates).
- [ ] **Step 11.5** — Commit: `feat(drive): uploadFile accepts parentFolderUid + collision retry`.

### Task 12: Adapter for Phase 4 `pdf/build.ts`

**Files:**
- Modify: `pwa/src/pdf/build.ts` (add a normalised-coords input variant, or new wrapper)
- Test: `pwa/src/pdf/build.test.ts`

`pdf/build.ts` was written for Tesseract pixel-coordinate output; Haiku returns 0-1 normalised. Pick one of:
- (a) Change `build.ts` to accept `{ blob, ocrText, ocrWords: NormalisedWord[] }` and multiply by image dimensions internally.
- (b) Convert at the call site in App.tsx before calling.

(a) is cleaner — the build module already does the coord math; just adjust its input shape.

- [ ] **Step 12.1** — Read existing `pdf/build.ts` to understand current input shape and coord math.
- [ ] **Step 12.2** — TDD: a new test that passes normalised coords + an image of known dimensions; assert PDF text positions align with the (image-dimension × normalised-coord) products.
- [ ] **Step 12.3** — Update `build.ts` to accept normalised coords (+ optional image dimensions for the conversion). Old tests should still pass with a small adapter or be updated.
- [ ] **Step 12.4** — Commit: `feat(pwa): pdf/build accepts normalised word coordinates from Haiku`.

### Task 13: `routes-upload.ts`

**Files:**
- Create: `server/src/http/routes-upload.ts`
- Modify: `server/src/http/server.ts`
- Test: `server/src/http/routes-upload.test.ts`

Same as the original plan. Multipart: `pdf`, `name`, `folderLinkId`, `ocrText`. Calls `drive/client.uploadFile` with `parentFolderUid`. Records audit log. Returns `{ driveNodeUid, driveWebUrl, finalName }` or 409/401/413.

- [ ] **Step 13.1** — TDD happy path → audit row → 200 with finalName.
- [ ] **Step 13.2** — Implement.
- [ ] **Step 13.3** — Tests for 401 refresh path, body limit, collision exhausted.
- [ ] **Step 13.4** — Commit: `feat(server): POST /api/upload sends PDFs to Drive`.

### Task 14: PWA `api.upload()`

- [ ] **Step 14.1** — TDD pre-flight (50 MB cap), multipart shape, response mapping.
- [ ] **Step 14.2** — Implement: `upload(pdf, name, folderLinkId, ocrText)`.
- [ ] **Step 14.3** — Commit: `feat(pwa): api.upload() to /api/upload`.

### Task 15: PWA scans-store transitions for slice 2

- [ ] **Step 15.1** — Add tests for `pending_upload` → `done` with `driveNodeUid`/`driveWebUrl` patch (already in Task 5; confirm pass).
- [ ] **Step 15.2** — Add helper `setPdfBlob(scanId, blob)` for slice 2's PDF assembly.
- [ ] **Step 15.3** — Commit: `test(pwa): cover slice-2 upload transitions and pdfBlob helper`.

### Task 16: Wire ConfirmCard Save → PDF assembly → upload → done

**Files:**
- Modify: `pwa/src/ui/App.tsx`

- [ ] **Step 16.1** — When user taps Save in ConfirmCard:
  ```ts
  async function onSave(name, folderLinkId) {
    await scansStore.setUploadStatus(scanId, 'pending_upload', { finalName: name, finalFolderLinkId: folderLinkId });
    const pages = await scansStore.getPageBlobs(scanId);
    const scan = await scansStore.get(scanId);
    const pdf = await buildSearchablePdf(pages.map((blob, i) => ({
      blob, ocrText: scan.pageOcr?.[i]?.text ?? '', ocrWords: scan.pageOcr?.[i]?.words ?? [],
    })));
    await scansStore.setPdfBlob(scanId, pdf);
    const ocrText = (scan.pageOcr ?? []).map((p) => p.text).join('\n\n');
    const res = await api.upload(pdf, name, folderLinkId, ocrText);
    await scansStore.setUploadStatus(scanId, 'done', { driveNodeUid: res.driveNodeUid, driveWebUrl: res.driveWebUrl, finalName: res.finalName });
    showToast(`Saved to Drive`, { actionLabel: 'Open', onAction: () => window.open(res.driveWebUrl, '_blank') });
  }
  ```
- [ ] **Step 16.2** — Manual smoke: scan → confirm → real upload → verify in Drive.
- [ ] **Step 16.3** — Commit: `feat(pwa): ConfirmCard Save assembles PDF and uploads to Drive`.

### Task 17: Slice 2 acceptance + push

- [ ] **Step 17.1** — Tests, typecheck, build, push. **Demoable milestone reached.**

---

## Slice 3 — FTS5 Few-Shot History

### Task 18: Migration + history module

**Files:**
- Create: `server/src/migrations/003_classification_history.sql`
- Create: `server/src/classify/history.ts`
- Test: `server/src/classify/history.test.ts`

- [ ] **Step 18.1** — Migration per spec (table + FTS5 + triggers).
- [ ] **Step 18.2** — TDD `recordSave` then `findRecent(limit)` (most-recent-N strategy per spec). 5 tests.
- [ ] **Step 18.3** — Commit: `feat(classify): history.ts records saves; findRecent for few-shot`.

### Task 19: Wire into routes

- [ ] **Step 19.1** — Add `history.recordSave(...)` after successful upload in `routes-upload.ts`. Best-effort (logged on failure, doesn't fail upload).
- [ ] **Step 19.2** — Pass `history.findRecent(3)` results into `routes-classify` → `classify(...)`.
- [ ] **Step 19.3** — Verify `<examples>` block appears in `mockCreate.mock.calls[0][0]` when 3+ saves exist.
- [ ] **Step 19.4** — Commit: `feat(server): wire FTS5 examples into classify + record on upload`.

### Task 20: Slice 3 acceptance + push

---

## Slice 4 — Outbox + Background Sync

### Task 21: Add `'needs_attention'` state

- [ ] **Step 21.1** — Extend `UploadStatus` and `ALLOWED` map. Tests.
- [ ] **Step 21.2** — Commit: `feat(pwa): scans-store needs_attention state`.

### Task 22: `pwa/src/outbox-drain.ts`

- [ ] **Step 22.1** — TDD empty queue, 2 pending classify + 1 pending upload, classify fail → awaiting_confirm, upload fail 3× in 24h → needs_attention, upload succeeds 2nd attempt → done.
- [ ] **Step 22.2** — Implement. Add `retryCount`/`retryFirstAt` fields to Scan.
- [ ] **Step 22.3** — Commit: `feat(pwa): outbox-drain.ts background queue worker`.

### Task 23: `pwa/public/sw.js` extensions + `sw-register.ts`

- [ ] **Step 23.1** — Add `sync` + `message` listeners to sw.js. Bump CACHE_NAME.
- [ ] **Step 23.2** — Create `sw-register.ts`; replace inline register call in `main.tsx`.
- [ ] **Step 23.3** — Commit: `feat(pwa): SW + register handle outbox-drain sync + visibility`.

### Task 24: Outbox panel UI

- [ ] **Step 24.1** — Banner on `SavedScansScreen` showing pending + needs_attention counts; "Retry all" button.
- [ ] **Step 24.2** — Tests + commit.

### Task 25: Slice 4 acceptance + push

---

## Final: Smoke + Tag

### Task 26: Combined manual smoke

Boot stack via docker compose + ngrok. Run all 7 cases from spec section "Manual smoke". Append results to plan as a "Smoke Results" section.

### Task 27: PR + merge + tag

- [ ] **Step 27.1** — Open PR; merge.
- [ ] **Step 27.2** — Tag `phase-5-complete`. Push tags.
- [ ] **Step 27.3** — Update memory: mark Phase 4 OCR retired, Phase 5 complete with vision approach.

---

## Notes for Implementers

- **No client OCR.** Anything in `pwa/src/ocr/` from Phase 4 is gone. If you find an OCR import path, that's a regression.
- **Haiku word boxes are normalised 0-1**, not pixels. `pdf/build.ts` was updated in Task 12 to handle this; do not pass pixel coords.
- **Anthropic SDK + sharp are pinned in lockfile.** Don't introduce ranges.
- **Multi-page docs are normal.** Test with 1, 3, and 5 page documents to catch off-by-one.
- **Trust boundary** (parent spec line 73): page images go to server (and Anthropic). The parent spec didn't anticipate this in v1, but it's the same boundary the existing thumbnail-to-Anthropic call would have crossed; we're sending more of it now.
- **Renovate `rangeStrategy: pin`** is in effect across all package.json.
- **iOS Safari testing is non-negotiable for any worker/SW change.** Automated tests run in happy-dom; they cannot catch the class of failures that retired Tesseract.js.
