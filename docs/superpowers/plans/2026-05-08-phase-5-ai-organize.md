# Phase 5 — AI Upload/Organize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a Phase 4 searchable PDF on the phone, classify it with Claude Haiku 4.5 (filename + Drive folder suggestion), let the user confirm, and upload to Proton Drive — with offline-resilient outbox + background sync.

**Architecture:** Vertical slices: (1) classify online → (2) upload → (3) FTS5 few-shot history → (4) outbox + background sync. Trust boundary preserved: phone owns raw PDF, server owns Anthropic key + Proton session. Three orthogonal state axes on `Scan`: scan / pdf / upload. Server modules `classify/{image,haiku,history}.ts` + new routes; PWA modules `ConfirmCard.tsx`, `outbox-drain.ts`, `sw-register.ts` + `pwa/public/sw.js` extensions.

**Tech Stack:** Server — Node 24 / Hono / TypeScript / better-sqlite3 (FTS5) / `@anthropic-ai/sdk` (vision tool-use) / `sharp` (libvips, prebuilt Alpine binaries) / vendored Proton Drive SDK. PWA — Preact / Vite / IndexedDB (`idb`) / hand-written Service Worker.

**Spec:** `docs/superpowers/specs/2026-05-08-phase-5-ai-organize-design.md` — read this first.

---

## Pre-Phase-5 Prerequisites

These run **before** Slice 1 begins. None block plan-writing, but all must complete before implementation work starts.

### Pre-Task A: Quick golden-path smoke of Phase 4

**Files:** none (manual smoke on phone via ngrok-exposed dev server).

- [ ] **Step A.1** — Start stack locally: `docker compose up --build` from repo root after creating `.env` with `SESSION_ENCRYPTION_KEY` + `ANTHROPIC_API_KEY`.
- [ ] **Step A.2** — Expose via ngrok: `ngrok http 3000`. Open the https URL on your iPhone, install as PWA.
- [ ] **Step A.3** — Run the golden path: scan one document → wait for OCR → tap Download PDF → verify the PDF on phone has a searchable text layer (open in Files, search for a word).
- [ ] **Step A.4** — If smoke passes: proceed to Pre-Task B. If anything regresses: stop and fix on `phase-4-ocr-pdf` before moving on.

### Pre-Task B: Merge Phase 4 to main

- [ ] **Step B.1** — From `phase-4-ocr-pdf`: `git rebase main` (resolve any lockfile conflicts with `--theirs` then `npm install` — same flow as session history).
- [ ] **Step B.2** — Push: `git push origin phase-4-ocr-pdf`.
- [ ] **Step B.3** — Open PR `gh pr create --base main`. Wait for CI green.
- [ ] **Step B.4** — Merge. **Do not tag `phase-4-complete` yet** — full smoke is deferred to combined Phase 5 smoke; tag both phases together at the end.

### Pre-Task C: Dep-sync window

- [ ] **Step C.1** — On main: `git pull && eval "$(fnm env)" && fnm use 24.15.0 && npm install`. Verify `package-lock.json` diff is empty or trivial.
- [ ] **Step C.2** — `git diff` lockfile, commit with `chore(deps): post-phase-4 lockfile sync` if there are changes.

### Pre-Task D: Branch Phase 5

- [ ] **Step D.1** — `git checkout -b phase-5-ai-organize` off freshly-merged main.
- [ ] **Step D.2** — `git push -u origin phase-5-ai-organize`.

---

## Slice 1 — Classify Online

End state: scan → AI suggests name + folder → user edits + confirms → toast "would upload" (no real upload yet). 9 tasks.

### Task 1: Install slice-1 dependencies

**Files:**
- Modify: `package.json` (root and / or `server/package.json`)
- Modify: `package-lock.json`

- [ ] **Step 1.1** — Add server deps: `npm --workspace @doc-scanner/server install @anthropic-ai/sdk sharp`.
- [ ] **Step 1.2** — Verify pinned versions (no `^`/`~`) — Renovate's `rangeStrategy: pin` should enforce this; check the diff.
- [ ] **Step 1.3** — `npm ls sharp` to confirm it resolved a `linux-musl-arm64` and `darwin-arm64` (or matching) prebuild on dev machine.
- [ ] **Step 1.4** — Commit: `git add package.json package-lock.json server/package.json && git commit -m "feat(deps): add @anthropic-ai/sdk and sharp for Phase 5 classify"`.

### Task 2: `classify/image.ts` — image normalisation

**Files:**
- Create: `server/src/classify/image.ts`
- Test: `server/src/classify/image.test.ts`

- [ ] **Step 2.1** — Write failing test: 200×200 PNG ≤600 KB → pass-through (output bytes equal input bytes).

```ts
// server/src/classify/image.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { normaliseForClassify, UndecodableImageError } from './image.js';

async function tinyPng(): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png().toBuffer();
  return new Uint8Array(buf);
}

describe('normaliseForClassify', () => {
  it('passes through small PNGs unchanged', async () => {
    const input = await tinyPng();
    const out = await normaliseForClassify(input);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(input))).toBe(0);
  });
});
```

- [ ] **Step 2.2** — Run: `npm --workspace @doc-scanner/server test classify/image -- --run`. Expected: FAIL (module not found).

- [ ] **Step 2.3** — Implement minimal:

```ts
// server/src/classify/image.ts
import sharp from 'sharp';

export class UndecodableImageError extends Error {}

const MAX_LONG_EDGE = 512;
const MAX_BYTES = 600 * 1024;

export async function normaliseForClassify(input: Uint8Array): Promise<Uint8Array> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new UndecodableImageError('sharp could not decode input bytes');
  }
  if (!meta.format) throw new UndecodableImageError('unrecognised format');

  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const isPng = meta.format === 'png';
  if (isPng && longEdge <= MAX_LONG_EDGE && input.byteLength <= MAX_BYTES) {
    return input;
  }
  const buf = await sharp(input)
    .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(buf);
}
```

- [ ] **Step 2.4** — Run: PASS expected.

- [ ] **Step 2.5** — Add remaining tests (one at a time, each: write → fail → pass → next):
  - 4000×3000 JPEG → 512×384 PNG, ≤600 KB.
  - Corrupt header bytes → throws `UndecodableImageError`.
  - Performance: 4000×3000 normalises in <200 ms (use `performance.now()` around the call).

- [ ] **Step 2.6** — All 4 tests green. Commit: `feat(classify): image.ts normalises bitmaps for Anthropic vision input`.

### Task 3: `classify/haiku.ts` — Anthropic SDK wrapper

**Files:**
- Create: `server/src/classify/haiku.ts`
- Create: `server/src/classify/types.ts`
- Test: `server/src/classify/haiku.test.ts`

- [ ] **Step 3.1** — Define types in `classify/types.ts`:

```ts
export interface ClassifyInput {
  ocrText: string;
  thumbnailPng: Uint8Array;
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
}
```

- [ ] **Step 3.2** — Write failing happy-path test (mock `@anthropic-ai/sdk` at module boundary using `vi.mock`):

```ts
// server/src/classify/haiku.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { classify } from './haiku.js';

describe('classify (haiku)', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns parsed ClassifyResult on tool-use happy path', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        name: 'suggest_filing',
        input: {
          suggestedName: 'Tax Receipt 2026',
          suggestedFolderLinkId: 'folder-tax',
          confidence: 0.9,
          rationale: 'OCR mentions IRS form',
        },
      }],
    });
    const result = await classify({
      ocrText: 'IRS Form 1040',
      thumbnailPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      folders: [{ linkId: 'folder-tax', path: '/Documents/Tax' }],
    });
    expect(result).toEqual({
      suggestedName: 'Tax Receipt 2026',
      suggestedFolderLinkId: 'folder-tax',
      confidence: 0.9,
      rationale: 'OCR mentions IRS form',
    });
  });
});
```

- [ ] **Step 3.3** — Run: FAIL (module not found).

- [ ] **Step 3.4** — Implement minimal `haiku.ts` (force tool-use, base64 encode image, single-turn message):

```ts
// server/src/classify/haiku.ts
import Anthropic from '@anthropic-ai/sdk';
import type { ClassifyInput, ClassifyResult, PastExample } from './types.js';
import { logger } from '../logger.js';

export class ImageTooLargeError extends Error {}

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;

const FILING_TOOL = {
  name: 'suggest_filing',
  description: 'Propose a filename and destination folder for the scanned document.',
  input_schema: {
    type: 'object' as const,
    required: ['suggestedName', 'suggestedFolderLinkId', 'confidence', 'rationale'],
    properties: {
      suggestedName: { type: 'string' as const, description: 'Filename without extension. ASCII, no slashes, ≤80 chars.' },
      suggestedFolderLinkId: { type: 'string' as const, description: 'Must be one of the linkIds from the provided folders list.' },
      confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
      rationale: { type: 'string' as const, maxLength: 200 },
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

function formatExamples(examples: PastExample[] | undefined): string {
  if (!examples?.length) return '';
  return ['<examples>', ...examples.map((e) => `OCR: ${e.ocrSnippet}  →  filed as "${e.finalName}" in ${e.folderPath}`), '</examples>'].join('\n');
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult | null> {
  if (input.thumbnailPng.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError(`image ${input.thumbnailPng.byteLength} > ${MAX_IMAGE_BYTES}`);
  }
  const folderLines = input.folders.map((f) => `${f.linkId}: ${f.path}`).join('\n');
  const ocrExcerpt = input.ocrText.slice(0, 2000);
  const base64 = Buffer.from(input.thumbnailPng).toString('base64');
  const examplesBlock = formatExamples(input.examples);

  const start = performance.now();
  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 400,
      tool_choice: { type: 'tool', name: FILING_TOOL.name },
      tools: [FILING_TOOL],
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Suggest a filename and destination folder for this scanned document.\n\nAvailable folders:\n${folderLines}`,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: `OCR text:\n${ocrExcerpt}` },
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
  if (typeof raw.suggestedName !== 'string' || typeof raw.suggestedFolderLinkId !== 'string'
      || typeof raw.confidence !== 'number' || typeof raw.rationale !== 'string') {
    logger.warn({ raw }, 'classify: tool_use input missing required fields');
    return null;
  }

  const sanitisedName = NAME_REGEX.test(raw.suggestedName) ? raw.suggestedName : sanitiseName(raw.suggestedName);
  const folderOk = input.folders.some((f) => f.linkId === raw.suggestedFolderLinkId);
  const finalLinkId = folderOk ? raw.suggestedFolderLinkId : '';

  const elapsed = Math.round(performance.now() - start);
  logger.info({ elapsed, model: MODEL, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens }, 'classify: ok');
  return { suggestedName: sanitisedName, suggestedFolderLinkId: finalLinkId, confidence: raw.confidence, rationale: raw.rationale };
}
```

- [ ] **Step 3.5** — Run: PASS expected on happy-path test.

- [ ] **Step 3.6** — Add remaining tests one at a time (write → fail → fix → pass):
  - Hallucinated folder linkId → result has `suggestedFolderLinkId: ''`.
  - Name with illegal chars (e.g., `'Tax/Receipt ✨'`) → sanitised to `'TaxReceipt'`.
  - SDK throws → `classify` returns `null`.
  - Tool response missing required fields → returns `null`.
  - Image >3 MB raw → throws `ImageTooLargeError` (no API call).

- [ ] **Step 3.7** — All 6 tests green. Commit: `feat(classify): haiku.ts wraps Anthropic vision tool-use`.

### Task 4: `routes-classify.ts` — HTTP endpoint

**Files:**
- Create: `server/src/http/routes-classify.ts`
- Modify: `server/src/http/server.ts` (register route)
- Test: `server/src/http/routes-classify.test.ts`

- [ ] **Step 4.1** — Inspect existing route file for conventions: `cat server/src/http/routes-drive.ts | head -50`. Match its style (deps injection via factory, error handling, logging).

- [ ] **Step 4.2** — Write failing happy-path test:

```ts
// server/src/http/routes-classify.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { classifyRoutes } from './routes-classify.js';

describe('POST /api/classify', () => {
  it('returns suggestion JSON on valid multipart', async () => {
    const fakeClassify = vi.fn().mockResolvedValue({
      suggestedName: 'Test', suggestedFolderLinkId: 'f1', confidence: 0.8, rationale: 'OCR matches'
    });
    const fakeFolderCache = { getTree: vi.fn().mockResolvedValue([{ linkId: 'f1', path: '/Tax' }]) };
    const app = new Hono().route('/api', classifyRoutes({ classify: fakeClassify, folderCache: fakeFolderCache as never, history: undefined }));

    const fd = new FormData();
    fd.set('thumbnail', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'thumb.png');
    fd.set('ocrText', 'IRS form text');
    const res = await app.request('/api/classify', { method: 'POST', body: fd });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: { suggestedName: 'Test', suggestedFolderLinkId: 'f1', confidence: 0.8, rationale: 'OCR matches' } });
    expect(fakeClassify).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4.3** — Run: FAIL.

- [ ] **Step 4.4** — Implement:

```ts
// server/src/http/routes-classify.ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ClassifyResult, PastExample } from '../classify/types.js';
import { normaliseForClassify, UndecodableImageError } from '../classify/image.js';
import { logger } from '../logger.js';

interface FolderCache { getTree(): Promise<{ linkId: string; path: string }[]>; }
interface History { findSimilar(ocrText: string, limit: number): PastExample[]; }

interface Deps {
  classify: (input: { ocrText: string; thumbnailPng: Uint8Array; folders: { linkId: string; path: string }[]; examples?: PastExample[] }) => Promise<ClassifyResult | null>;
  folderCache: FolderCache;
  history?: History;
}

export function classifyRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.post('/classify', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }), async (c) => {
    const form = await c.req.formData();
    const thumb = form.get('thumbnail');
    const ocrText = form.get('ocrText');
    if (!(thumb instanceof Blob) || typeof ocrText !== 'string') return c.json({ error: 'missing_fields' }, 400);

    const raw = new Uint8Array(await thumb.arrayBuffer());
    let normalised: Uint8Array;
    try { normalised = await normaliseForClassify(raw); }
    catch (err) {
      if (err instanceof UndecodableImageError) return c.json({ error: 'undecodable_image' }, 422);
      throw err;
    }

    const folders = await deps.folderCache.getTree();
    const examples = deps.history?.findSimilar(ocrText, 3) ?? [];
    const suggestion = await deps.classify({ ocrText, thumbnailPng: normalised, folders, examples });
    return c.json({ suggestion });
  });
  return app;
}
```

- [ ] **Step 4.5** — Run: PASS.

- [ ] **Step 4.6** — Add tests one at a time:
  - 2.5 MB body → 413.
  - Missing thumbnail or ocrText → 400.
  - `classify` returns null → 200 with `{ suggestion: null }` (not 500).
  - Undecodable image → 422.

- [ ] **Step 4.7** — Wire route into `server.ts`:

```ts
// server/src/http/server.ts (additions in createApp)
import { classifyRoutes } from './routes-classify.js';
import { classify } from '../classify/haiku.js';
import { folderCache } from '../drive/folder-cache.js';   // adjust to actual export
// ...
app.route('/api', classifyRoutes({ classify, folderCache, history: undefined }));
```

- [ ] **Step 4.8** — All 5 tests green. Commit: `feat(server): POST /api/classify wires Haiku suggestions`.

### Task 5: PWA `scans-store` — uploadStatus axis (slice 1 portion)

**Files:**
- Modify: `pwa/src/scanner/types.ts` (add UploadStatus + Scan extensions)
- Modify: `pwa/src/scanner/scans-store.ts` (mutator + transition validator)
- Test: `pwa/src/scanner/scans-store.test.ts` (additions)

- [ ] **Step 5.1** — Extend types:

```ts
// pwa/src/scanner/types.ts (add)
export type UploadStatus = 'idle' | 'pending_classify' | 'awaiting_confirm' | 'pending_upload' | 'done';
// (slice 4 will add 'needs_attention' as a discriminated union extension)

export interface UploadSuggestion {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
}

export interface Scan {
  // ...existing fields...
  uploadStatus: UploadStatus;
  uploadError: string | null;
  suggestion?: UploadSuggestion;
  finalName?: string;
  finalFolderLinkId?: string;
  driveNodeUid?: string;
  driveWebUrl?: string;
}
```

- [ ] **Step 5.2** — Add migration to `scans-store.ts` `upgrade` block (bump DB version, default `uploadStatus='idle'`, `uploadError=null` for existing rows).

- [ ] **Step 5.3** — Write failing transition test:

```ts
// pwa/src/scanner/scans-store.test.ts (additions)
it('transitions idle → pending_classify when pdfStatus becomes done', async () => {
  const store = await ScansStore.open('test-db-1');
  const id = await store.create();
  await store.setPdfStatus(id, 'done');
  await store.setUploadStatus(id, 'pending_classify');
  const scan = await store.get(id);
  expect(scan.uploadStatus).toBe('pending_classify');
});
```

- [ ] **Step 5.4** — Run: FAIL (no `setUploadStatus`).

- [ ] **Step 5.5** — Implement `setUploadStatus(id, next, patch?)` with a transition map:

```ts
const ALLOWED: Record<UploadStatus, UploadStatus[]> = {
  idle: ['pending_classify'],
  pending_classify: ['awaiting_confirm'],
  awaiting_confirm: ['pending_upload', 'idle'],
  pending_upload: ['done' /* slice-4 adds 'needs_attention' */],
  done: [],
};
```

Throws on illegal transitions; persists patch atomically.

- [ ] **Step 5.6** — Run: PASS.

- [ ] **Step 5.7** — Add remaining tests (one at a time):
  - Illegal transition (`done → pending_upload`) throws.
  - `awaiting_confirm` → `pending_upload` writes `finalName` + `finalFolderLinkId` patch.
  - `pending_upload` → `done` writes `driveNodeUid` + `driveWebUrl`.
  - Concurrent transitions on same id serialised (use IDB transaction).
  - `findPending()` returns `pending_classify` + `pending_upload` ordered by `updatedAt`.

- [ ] **Step 5.8** — All 6 tests green. Commit: `feat(pwa): scans-store uploadStatus axis (slice 1 states)`.

### Task 6: PWA `api.ts::classify()`

**Files:**
- Modify: `pwa/src/api.ts`
- Test: `pwa/src/api.test.ts` (create if absent, else extend)

- [ ] **Step 6.1** — Write failing pre-flight test:

```ts
it('classify() throws if thumbnail blob > 1 MB before fetch', async () => {
  const big = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' });
  await expect(api.classify(big, 'ocr text')).rejects.toThrow(/thumbnail too large/i);
});
```

- [ ] **Step 6.2** — Run: FAIL.

- [ ] **Step 6.3** — Implement:

```ts
export async function classify(thumbnail: Blob, ocrText: string): Promise<{ suggestion: ClassifyResult | null }> {
  if (thumbnail.size > 1024 * 1024) throw new Error('thumbnail too large (PWA pre-flight)');
  const fd = new FormData();
  fd.set('thumbnail', thumbnail, 'thumb.png');
  fd.set('ocrText', ocrText);
  const res = await fetch('/api/classify', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 413 || res.status === 422) return { suggestion: null };
    throw new Error(`classify failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 6.4** — Run: PASS. Add tests for happy-path multipart shape + 413/422 mapping (3 more tests).

- [ ] **Step 6.5** — Commit: `feat(pwa): api.classify() with pre-flight size guard`.

### Task 7: PWA `ConfirmCard.tsx`

**Files:**
- Create: `pwa/src/ui/ConfirmCard.tsx`
- Test: `pwa/src/ui/ConfirmCard.test.tsx`

- [ ] **Step 7.1** — Inspect existing UI patterns: `cat pwa/src/ui/SavedScansScreen.tsx | head -80` for styling/import style.

- [ ] **Step 7.2** — Write failing render test (use `@testing-library/preact` if already in deps; otherwise vitest jsdom):

```tsx
// pwa/src/ui/ConfirmCard.test.tsx
import { render, screen } from '@testing-library/preact';
import { ConfirmCard } from './ConfirmCard';

it('pre-fills name and folder from suggestion', () => {
  render(<ConfirmCard
    scanId="s1"
    suggestion={{ suggestedName: 'Tax 2026', suggestedFolderLinkId: 'f1', confidence: 0.9, rationale: 'IRS' }}
    folders={[{ linkId: 'f1', path: '/Tax' }]}
    onSave={async () => {}}
    onDismiss={() => {}}
    onRefreshFolders={async () => {}}
  />);
  expect((screen.getByLabelText(/filename/i) as HTMLInputElement).value).toBe('Tax 2026');
});
```

- [ ] **Step 7.3** — Run: FAIL.

- [ ] **Step 7.4** — Implement minimal `ConfirmCard`:

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
    <div className="confirm-card">
      <label>Filename<input aria-label="filename" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
      <label>Folder
        <select value={folderId} onChange={(e) => setFolderId((e.target as HTMLSelectElement).value)}>
          <option value="">— pick a folder —</option>
          {folders.map((f) => <option key={f.linkId} value={f.linkId}>{f.path}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => onRefreshFolders()}>↻ Refresh folders</button>
      {suggestion && (
        <p className="rationale">
          <em>{suggestion.rationale}</em>
          {suggestion.confidence < 0.6 && <span className="badge">Low confidence</span>}
        </p>
      )}
      <div className="actions">
        <button disabled={!valid || busy} onClick={async () => { setBusy(true); try { await onSave(name, folderId); } finally { setBusy(false); } }}>Save</button>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7.5** — Run: PASS. Add 5 more tests one at a time:
  - `suggestion: null` → empty fields, Save disabled until name+folder filled.
  - Illegal chars in name → Save disabled.
  - Folder picker selection updates state.
  - Low-confidence badge visible at 0.4; absent at 0.95.
  - Refresh-folders button calls `onRefreshFolders` callback.

- [ ] **Step 7.6** — Commit: `feat(pwa): ConfirmCard component for AI suggestions`.

### Task 8: Wire scanner-session + App.tsx (slice 1 integration)

**Files:**
- Modify: `pwa/src/scanner/scanner-session.ts`
- Modify: `pwa/src/ui/App.tsx`

- [ ] **Step 8.1** — Inspect: how does scanner-session currently transition pdfStatus to 'done'? Find the call site (`grep -n "setPdfStatus.*done" pwa/src/scanner/scanner-session.ts`).

- [ ] **Step 8.2** — At that call site, also call `setUploadStatus(scanId, 'pending_classify')` so the UI knows to show the confirm card next.

- [ ] **Step 8.3** — In `App.tsx`, when current scan becomes `pending_classify`:
  - Generate 512px PNG thumbnail from the stored page-1 image (use sharp's job is server-side; on PWA, use existing canvas-resize utility — check `pwa/src/scanner/` for an existing helper, else inline a small one using `OffscreenCanvas`).
  - Call `api.classify(thumb, ocrText)`.
  - On success: `setUploadStatus(scanId, 'awaiting_confirm', { suggestion })`.
  - On error: `setUploadStatus(scanId, 'awaiting_confirm', { suggestion: undefined })` (empty card).
  - Render `<ConfirmCard>` with current scan state. `onSave` for slice 1: just `setUploadStatus('idle')` and toast "would upload here" (no real upload yet).

- [ ] **Step 8.4** — Run PWA dev server: `npm --workspace @doc-scanner/pwa run dev`. Manual smoke in browser: scan one document via existing flow → verify confirm card appears with a (possibly mocked-out) suggestion.

- [ ] **Step 8.5** — If you don't have an Anthropic key wired locally yet, set `ANTHROPIC_API_KEY=...` in `.env` for compose. Or add a dev-mode mock in `routes-classify.ts` behind `NODE_ENV === 'development'` (then remove before slice 1 commit).

- [ ] **Step 8.6** — Commit: `feat(pwa): wire scanner-session → classify → ConfirmCard end-to-end`.

### Task 9: Slice 1 acceptance + push

- [ ] **Step 9.1** — Run full test suite: `npm test` from root. Expected: all server + PWA tests pass.
- [ ] **Step 9.2** — Run typecheck: `npm --workspaces run typecheck` (or whichever script).
- [ ] **Step 9.3** — Build: `npm --workspaces run build` to catch Vite issues.
- [ ] **Step 9.4** — Push branch: `git push`.
- [ ] **Step 9.5** — CI green confirmation. Slice 1 done — no PR yet, more slices to come.

---

## Slice 2 — Upload (the demoable milestone)

End state: scan → AI → user confirms → real PDF lands in Drive. 7 tasks.

### Task 10: Empirical SDK collision-behaviour test

**Files:** none (manual + a one-off harness).

- [ ] **Step 10.1** — Inspect existing test endpoint: `cat server/src/http/routes-drive.ts | grep -A 30 test-upload`. Use it to upload a file with a known name to MyFilesRootFolder.
- [ ] **Step 10.2** — Upload **the same name** a second time. Capture the SDK error: HTTP code, error class name, error message text.
- [ ] **Step 10.3** — Document findings in a comment block at top of `server/src/drive/client.ts` (right above `uploadFile`):

```ts
// Proton SDK collision behaviour (verified 2026-05-XX):
//   - On duplicate name: <fill in actual error shape, e.g., "throws DriveError with code='NAME_EXISTS'">
//   - This shape drives the catch in uploadFile's collision retry loop below.
```

- [ ] **Step 10.4** — Commit (docs-only): `docs(drive): document Proton SDK name-collision behaviour`.

### Task 11: Extend `drive/client.ts::uploadFile`

**Files:**
- Modify: `server/src/drive/client.ts`
- Test: `server/src/drive/client.test.ts` (additions)

- [ ] **Step 11.1** — Write failing test for back-compat (no opts → root folder):

```ts
it('uploadFile without opts uploads to MyFilesRootFolder (back-compat)', async () => {
  const sdk = makeFakeSdk();
  const client = new DriveClient(sdk);
  await client.uploadFile('test.pdf', new Uint8Array([1,2,3]), 'application/pdf');
  expect(sdk.getMyFilesRootFolder).toHaveBeenCalled();
});
```

- [ ] **Step 11.2** — Run: FAIL (signature mismatch / behaviour assertion fails).

- [ ] **Step 11.3** — Refactor `uploadFile` signature; preserve old behaviour when `opts` omitted:

```ts
interface UploadOptions { parentFolderUid?: string; }
export interface UploadResult { nodeUid: string; driveUrl: string; finalName: string; }

async uploadFile(name: string, bytes: Uint8Array, mimeType: string, opts?: UploadOptions): Promise<UploadResult> {
  const parentUid = opts?.parentFolderUid ?? unwrapNode(await this.sdk.getMyFilesRootFolder()).uid;
  return this.uploadWithCollisionRetry(parentUid, name, bytes, mimeType);
}

private async uploadWithCollisionRetry(parentUid: string, baseName: string, bytes: Uint8Array, mimeType: string): Promise<UploadResult> {
  const candidates = [baseName, `${baseName} (2)`, `${baseName} (3)`, `${baseName} (4)`];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      const result = await this.uploadOnce(parentUid, candidate, bytes, mimeType);
      return { ...result, finalName: candidate };
    } catch (err) {
      if (!isCollisionError(err)) throw err;     // shape from Task 10
      lastErr = err;
    }
  }
  throw new UploadCollisionExhausted(`name "${baseName}" collided after 4 attempts`, { cause: lastErr });
}
```

- [ ] **Step 11.4** — Run: PASS. Add tests one at a time:
  - With `parentFolderUid` → uses provided folder.
  - Collision once → succeeds with `(2)` suffix.
  - Collision four times → `UploadCollisionExhausted`.
  - Non-collision SDK error → propagates, no retry.

- [ ] **Step 11.5** — All 5 tests green. Commit: `feat(drive): uploadFile accepts parentFolderUid + collision retry`.

### Task 12: `routes-upload.ts`

**Files:**
- Create: `server/src/http/routes-upload.ts`
- Modify: `server/src/http/server.ts`
- Test: `server/src/http/routes-upload.test.ts`

- [ ] **Step 12.1** — Write failing happy-path test (Drive client mocked; `audit_log` insert verified; no `history.recordSave` yet — slice 3 adds that):

```ts
// 6 tests total — start with happy path
```

- [ ] **Step 12.2** — Implement:

```ts
// server/src/http/routes-upload.ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { UploadCollisionExhausted } from '../drive/client.js';
import { logger } from '../logger.js';

interface DriveClient {
  uploadFile(name: string, bytes: Uint8Array, mimeType: string, opts?: { parentFolderUid?: string }): Promise<{ nodeUid: string; driveUrl: string; finalName: string }>;
  refresh(): Promise<void>;
}
interface FolderCache { getTree(): Promise<{ linkId: string; path: string }[]>; }
interface AuditLog { record(event: string, payload: unknown): void; }

interface Deps { drive: DriveClient; folderCache: FolderCache; auditLog: AuditLog; }

const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;

export function uploadRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.post('/upload', bodyLimit({ maxSize: 50 * 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }), async (c) => {
    const form = await c.req.formData();
    const pdf = form.get('pdf');
    const name = form.get('name');
    const folderLinkId = form.get('folderLinkId');
    if (!(pdf instanceof Blob) || typeof name !== 'string' || typeof folderLinkId !== 'string') return c.json({ error: 'missing_fields' }, 400);
    if (!NAME_REGEX.test(name)) return c.json({ error: 'invalid_name' }, 400);
    const folders = await deps.folderCache.getTree();
    if (!folders.some((f) => f.linkId === folderLinkId)) return c.json({ error: 'unknown_folder' }, 400);

    const bytes = new Uint8Array(await pdf.arrayBuffer());
    let result;
    try {
      result = await deps.drive.uploadFile(name, bytes, 'application/pdf', { parentFolderUid: folderLinkId });
    } catch (err) {
      if (err instanceof UploadCollisionExhausted) return c.json({ error: 'collision_exhausted', collision_exhausted: true }, 409);
      if (isAuth401(err)) {
        try { await deps.drive.refresh(); } catch {
          return c.json({ error: 'reauth_required', reauth_required: true }, 401);
        }
        result = await deps.drive.uploadFile(name, bytes, 'application/pdf', { parentFolderUid: folderLinkId });
      } else {
        logger.error({ err }, 'upload failed');
        return c.json({ error: 'upload_failed' }, 502);
      }
    }
    const folderPath = folders.find((f) => f.linkId === folderLinkId)!.path;
    deps.auditLog.record('drive_upload', { folderLinkId, folderPath, finalName: result.finalName, driveNodeUid: result.nodeUid });
    return c.json({ driveNodeUid: result.nodeUid, driveWebUrl: result.driveUrl, finalName: result.finalName });
  });
  return app;
}
```

- [ ] **Step 12.3** — Wire into `server.ts`. Run all 6 tests:
  - Happy path → audit row → 200 response with finalName.
  - Wrapper returns `(2)`-suffixed name → response surfaces it.
  - 401 → refresh → retry → success.
  - 401 → refresh fails → 401 with `reauth_required: true`.
  - Body > 50 MB → 413.
  - `UploadCollisionExhausted` → 409 with `collision_exhausted: true`.

- [ ] **Step 12.4** — Commit: `feat(server): POST /api/upload sends PDFs to Drive`.

### Task 13: PWA `api.ts::upload()`

**Files:**
- Modify: `pwa/src/api.ts`
- Test: `pwa/src/api.test.ts` (additions)

- [ ] **Step 13.1** — TDD: pre-flight size check (50 MB), multipart shape, response mapping (3 tests).

- [ ] **Step 13.2** — Implement `upload(pdf, name, folderLinkId, ocrText)`. (`ocrText` accepted now to keep signature stable for slice 3; ignored server-side until slice 3 wires history.)

- [ ] **Step 13.3** — Commit: `feat(pwa): api.upload() to /api/upload`.

### Task 14: PWA scans-store transitions for slice 2 (`pending_upload` → `done`)

**Files:**
- Modify: `pwa/src/scanner/scans-store.ts`
- Test: `pwa/src/scanner/scans-store.test.ts`

- [ ] **Step 14.1** — Add tests (already drafted in Task 5.7) that exercise the `pending_upload → done` transition with `driveNodeUid`/`driveWebUrl` patch.
- [ ] **Step 14.2** — Verify they pass (transitions already coded in Task 5).
- [ ] **Step 14.3** — Commit if any test additions: `test(pwa): cover slice-2 upload transitions`.

### Task 15: Wire ConfirmCard Save → upload → done

**Files:**
- Modify: `pwa/src/ui/App.tsx` (the `onSave` handler from Task 8.3)

- [ ] **Step 15.1** — Replace slice-1 stub:

```ts
async function onSave(name: string, folderLinkId: string) {
  await scansStore.setUploadStatus(scanId, 'pending_upload', { finalName: name, finalFolderLinkId: folderLinkId });
  const pdfBlob = await scansStore.getPdfBlob(scanId);   // adjust to actual API
  const ocrText = await scansStore.getOcrText(scanId);
  try {
    const res = await api.upload(pdfBlob, name, folderLinkId, ocrText);
    await scansStore.setUploadStatus(scanId, 'done', { driveNodeUid: res.driveNodeUid, driveWebUrl: res.driveWebUrl, finalName: res.finalName });
    showToast(`Saved to Drive`, { actionLabel: 'Open', onAction: () => window.open(res.driveWebUrl, '_blank') });
  } catch (err) {
    // slice 4 will route this to needs_attention; for slice 2, surface and stay in pending_upload
    showToast(`Upload failed: ${err}`);
    throw err;
  }
}
```

- [ ] **Step 15.2** — Manual smoke: scan → confirm → real upload → check Drive web app for the PDF.
- [ ] **Step 15.3** — Commit: `feat(pwa): ConfirmCard Save uploads to Drive`.

### Task 16: Slice 2 acceptance + push

- [ ] **Step 16.1** — Full test suite, typecheck, build.
- [ ] **Step 16.2** — Push. CI green.
- [ ] **Step 16.3** — Slice 2 done. **This is the demoable milestone** — first end-to-end save into Drive.

---

## Slice 3 — FTS5 Few-Shot History

End state: each upload records history; subsequent classify calls include up to 3 nearest examples in the prompt. 5 tasks.

### Task 17: Migration `003_classification_history.sql`

**Files:**
- Create: `server/src/migrations/003_classification_history.sql`
- Modify: `server/src/db.ts` (if migration runner is hard-coded)

- [ ] **Step 17.1** — Create the migration file with exact SQL from spec section "Migration `003_classification_history.sql`".
- [ ] **Step 17.2** — Run the server in dev once (`npm --workspace @doc-scanner/server run dev`); confirm migration applies cleanly to a fresh sqlite file (delete `data/app.db` first if needed locally).
- [ ] **Step 17.3** — Commit: `feat(db): migration 003 adds classification_history table + FTS5 index`.

### Task 18: `classify/history.ts`

**Files:**
- Create: `server/src/classify/history.ts`
- Test: `server/src/classify/history.test.ts`

- [ ] **Step 18.1** — TDD `recordSave` first: insert one row, assert it's in the table.
- [ ] **Step 18.2** — TDD `findSimilar` happy path: insert 5 rows with different OCR, query with overlap → top 3 by rank.
- [ ] **Step 18.3** — Implement `buildFtsQuery` (token extraction + OR-quoting) per spec.
- [ ] **Step 18.4** — Add tests one at a time:
  - Empty table → `[]`.
  - All-stopword OCR → `[]`.
  - OCR contains FTS5 reserved words (`AND`, `NEAR`) → quoting prevents syntax errors.
  - After insert + delete, FTS index in sync (re-query returns expected count).

- [ ] **Step 18.5** — Use `STOP_WORDS` from a tiny constant set (the 30-50 most common English stopwords; do **not** import a library — overkill).

- [ ] **Step 18.6** — All 5 tests green. Commit: `feat(classify): history.ts FTS5 retrieval for in-context examples`.

### Task 19: Wire history into `routes-upload`

**Files:**
- Modify: `server/src/http/routes-upload.ts`
- Modify: `server/src/http/server.ts` (inject history dep)
- Test: `server/src/http/routes-upload.test.ts` (one new test)

- [ ] **Step 19.1** — Add `history: History` to `Deps`. After successful upload, call `history.recordSave({ ocrText, finalName: result.finalName, folderLinkId, folderPath, driveNodeUid: result.nodeUid })`. Wrap in try/catch — log on failure, do not fail the response.
- [ ] **Step 19.2** — Add `ocrText` field to multipart parsing (already in Task 13's PWA api signature).
- [ ] **Step 19.3** — Test: history `recordSave` throws → upload still returns 200 (history failure is best-effort).
- [ ] **Step 19.4** — Commit: `feat(server): /api/upload records classification_history on success`.

### Task 20: Wire history into `routes-classify`

**Files:**
- Modify: `server/src/http/routes-classify.ts`
- Modify: `server/src/http/server.ts` (inject `history` into `classifyRoutes`)

- [ ] **Step 20.1** — Pass `history.findSimilar(ocrText, 3)` results into `deps.classify(...)` as `examples`.
- [ ] **Step 20.2** — `haiku.ts` already handles the empty case (slice 1 wired the prompt to omit `<examples>` when none). Verify by adding a test that confirms passing 3 examples produces an `<examples>` text block in the SDK call payload (use `mockCreate.mock.calls[0][0]` to inspect).
- [ ] **Step 20.3** — Commit: `feat(server): /api/classify uses FTS5 examples for few-shot prompting`.

### Task 21: Slice 3 acceptance + push

- [ ] **Step 21.1** — Tests, typecheck, build.
- [ ] **Step 21.2** — Manual smoke: do 4–5 saves, then scan something similar and observe (in server logs) the prompt includes prior examples.
- [ ] **Step 21.3** — Push. CI green.

---

## Slice 4 — Outbox + Background Sync

End state: airplane-mode scan → resume online → automatic suggest+upload. 6 tasks.

### Task 22: Add `'needs_attention'` state

**Files:**
- Modify: `pwa/src/scanner/types.ts`
- Modify: `pwa/src/scanner/scans-store.ts` (extend ALLOWED transitions)
- Test: `pwa/src/scanner/scans-store.test.ts`

- [ ] **Step 22.1** — Extend `UploadStatus` union: `... | 'needs_attention'`. Update `ALLOWED`:

```ts
pending_upload: ['done', 'needs_attention'],
needs_attention: ['pending_upload'],   // user retry path
```

- [ ] **Step 22.2** — Test: `pending_upload → needs_attention` (legal); `needs_attention → pending_upload` (legal); `needs_attention → done` (illegal, throws).
- [ ] **Step 22.3** — Commit: `feat(pwa): scans-store needs_attention state`.

### Task 23: `pwa/src/outbox-drain.ts`

**Files:**
- Create: `pwa/src/outbox-drain.ts`
- Test: `pwa/src/outbox-drain.test.ts`

- [ ] **Step 23.1** — Write failing test for empty queue → no-op:

```ts
it('drain() is a no-op when queue is empty', async () => {
  const fakeFetch = vi.fn();
  const fakeStore = { findPending: vi.fn().mockResolvedValue([]) /* etc */ };
  const result = await drain({ fetch: fakeFetch, store: fakeStore as never });
  expect(result.processed).toBe(0);
  expect(fakeFetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 23.2** — Implement minimal `drain({ fetch, store })`:

```ts
// pwa/src/outbox-drain.ts
import type { ScansStore } from './scanner/scans-store.js';

export interface DrainResult { processed: number; errors: number; }
interface Deps { fetch: typeof fetch; store: ScansStore; }

export async function drain(deps: Deps): Promise<DrainResult> {
  const pending = await deps.store.findPending();
  let processed = 0, errors = 0;
  for (const scan of pending) {
    try {
      if (scan.uploadStatus === 'pending_classify') await classifyOne(deps, scan);
      else if (scan.uploadStatus === 'pending_upload') await uploadOne(deps, scan);
      processed++;
    } catch { errors++; }
  }
  return { processed, errors };
}

// classifyOne / uploadOne: build multipart, fetch, on success setUploadStatus(...) via store
// On upload retry exhaustion (>3 attempts in 24h): setUploadStatus('needs_attention').
```

- [ ] **Step 23.3** — Add tests one at a time:
  - 2 `pending_classify` + 1 `pending_upload` → all called in order (assert fetch URL list).
  - Classify fails → state moves to `awaiting_confirm` (so user can fill manually) — not `needs_attention`.
  - Upload fails 3× within 24 h (use a `retryCount` field stored on the scan) → `needs_attention`.
  - Upload succeeds on 2nd attempt → `done`.

- [ ] **Step 23.4** — Add `retryCount` and `retryFirstAt` fields to the `Scan` interface; reset on success.
- [ ] **Step 23.5** — All 5 tests green. Commit: `feat(pwa): outbox-drain.ts background queue worker`.

### Task 24: `pwa/public/sw.js` extensions

**Files:**
- Modify: `pwa/public/sw.js`

- [ ] **Step 24.1** — Add `sync` event listener:

```js
self.addEventListener('sync', (event) => {
  if (event.tag !== 'outbox-drain') return;
  event.waitUntil((async () => {
    const mod = await import('/outbox-drain.js');     // built artefact path; verify with vite build output
    await mod.drain({ fetch, store: await openStore() });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'request-drain') return;
  event.waitUntil((async () => {
    const mod = await import('/outbox-drain.js');
    await mod.drain({ fetch, store: await openStore() });
  })());
});
```

- [ ] **Step 24.2** — `openStore()` opens the IndexedDB the same way `scans-store` does (note: SW context, no DOM). Verify path consistency with build output.
- [ ] **Step 24.3** — Increment `CACHE_NAME` so the new SW activates on update.
- [ ] **Step 24.4** — Commit: `feat(pwa): SW handles outbox-drain sync + message events`.

### Task 25: `pwa/src/sw-register.ts`

**Files:**
- Create: `pwa/src/sw-register.ts`
- Modify: `pwa/src/main.tsx` (move register call)

- [ ] **Step 25.1** — Create:

```ts
// pwa/src/sw-register.ts
export function registerSW(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js')
    .then(async (reg) => {
      if ('sync' in reg) await (reg as ServiceWorkerRegistration & { sync: { register(t: string): Promise<void> } }).sync.register('outbox-drain').catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        navigator.serviceWorker.controller?.postMessage({ type: 'request-drain' });
      });
    })
    .catch((e) => console.warn('SW register failed', e));
}
```

- [ ] **Step 25.2** — Replace inline `navigator.serviceWorker.register('/sw.js')` in `main.tsx` with `registerSW()`.
- [ ] **Step 25.3** — Commit: `feat(pwa): sw-register.ts handles sync + visibility-change drain`.

### Task 26: Outbox panel UI on `SavedScansScreen`

**Files:**
- Modify: `pwa/src/ui/SavedScansScreen.tsx`

- [ ] **Step 26.1** — Add a small banner at top of `SavedScansScreen` showing `pending_classify` + `pending_upload` count, plus a "Retry all" button.
- [ ] **Step 26.2** — "Retry all": for each `needs_attention` scan, reset `retryCount=0` then setUploadStatus(scan.id, 'pending_upload'). Then post `{ type: 'request-drain' }` to SW.
- [ ] **Step 26.3** — Add 2 tests for the panel: count display, retry-all click handler.
- [ ] **Step 26.4** — Commit: `feat(pwa): outbox status banner + retry-all on SavedScansScreen`.

### Task 27: Slice 4 acceptance + push

- [ ] **Step 27.1** — Tests, typecheck, build.
- [ ] **Step 27.2** — Push. CI green.

---

## Final: Smoke + Tag

### Task 28: Combined manual smoke (Phase 4 deferred + Phase 5)

**Files:** none (phone-side smoke).

Boot stack via docker compose + ngrok.

- [ ] **Step 28.1** — Phase 4 deferred cases:
  1. Capture, OCR, PDF, search inside PDF.
  2. Resume previous scan after tab kill.
  3. Queue multi-page scan.
  4. Blur rejection (intentional shake).
  5. Airplane mode capture, restore online, observe.
  6. Legacy iOS Safari fallback (if available).
- [ ] **Step 28.2** — Phase 5 cases:
  1. End-to-end: scan → classify → confirm → upload → verify in Drive.
  2. Airplane scan → close PWA → reopen online → background drain auto-uploads.
  3. Classify timeout (block Anthropic via local DNS or middleware) → manual fill → save → upload.
  4. Classify suggests folder, user picks different one → upload to chosen folder.
  5. Two captures back-to-back, both `pending_upload` → drain in order.
  6. After 5+ saves, observe qualitatively that 6th classify reflects taxonomy (server logs include `<examples>` block).
  7. Force `needs_attention` (e.g., `iptables` block port 443 mid-upload, or kill server) → "Retry all" recovers.

- [ ] **Step 28.3** — Record results in this plan file (append a "Smoke Results" section with date + pass/fail per case).
- [ ] **Step 28.4** — Commit: `chore(phase-5): record manual smoke results`.

### Task 29: PR + merge + tag

- [ ] **Step 29.1** — Open PR `gh pr create --base main`. Wait for CI green.
- [ ] **Step 29.2** — Merge.
- [ ] **Step 29.3** — Tag both phases together: `git tag phase-4-complete phase-5-complete && git push --tags`.
- [ ] **Step 29.4** — Update memory: in `/Users/owine/.claude/projects/-Users-owine-Git-doc-scanner/memory/`, mark `project_phase4_resumption.md` as fully complete and add `project_phase5_complete.md` summarising the AI organize work + any non-obvious lessons (e.g., SDK collision shape findings).
- [ ] **Step 29.5** — Phase 5 done.

---

## Notes for Implementers

- **Do not skip TDD steps.** Each test → fail → implement → pass cycle is what catches regressions cheaply. The plan deliberately walks through each in order.
- **Commit at the end of each task,** not at the end of slices. Atomic-commit preference (memory: `feedback_atomic_commits.md`) is real; `git log` should read like a story.
- **Renovate `rangeStrategy: pin`** is in effect. Don't introduce caret/tilde versions. Pin all new deps.
- **Anthropic + sharp are new deps.** Verify the pinned exact versions land in lockfile after Task 1.
- **Image normalization is server-side** (sharp). PWA still produces a 512px thumbnail best-effort, but the server is the source of truth.
- **Trust boundary** (parent spec line 73): the phone owns raw page images and the Proton password; the server owns the long-lived Proton session and Anthropic key. Don't accidentally cross this line.
- **Drive SDK collision behaviour** is not assumed — Task 10 verifies it empirically before Task 11 codes against a specific error shape.
- **For "Refresh folders" call**: the route exists at `GET /api/folders` (Phase 2). PWA's `api.ts` likely already has it; if not, add a thin wrapper.
- **Anthropic model id** is `claude-haiku-4-5`. Pin the exact id in code; do not parameterise via env (single-user app, deliberate model choice).
