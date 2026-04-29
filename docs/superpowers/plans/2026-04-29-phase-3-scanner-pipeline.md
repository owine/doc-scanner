# Phase 3: Scanner Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-browser document scanner — live camera viewfinder with edge-detection auto-capture, multi-page collation, and a Saved Scans list — entirely client-side in the PWA, persisted to IndexedDB.

**Architecture:** All work lives in `pwa/src/`. New modules under `pwa/src/scanner/` (camera, edge-detect, stability, scans-store, scanner-session) and `pwa/src/theme/` (theme.css + use-theme hook). New screens under `pwa/src/ui/` (ScannerScreen, EditCornersScreen, SavedScansScreen, ScanViewerScreen, ResumePrompt). Server is untouched.

**Tech Stack:** Phase 1+2 stack + new PWA deps: `idb` (IndexedDB wrapper), `ulid` (sortable IDs), `jscanify` (edge detection, lazy-loaded), `fake-indexeddb` (test-only).

**Spec:** [`docs/superpowers/specs/2026-04-29-phase-3-scanner-pipeline-design.md`](../specs/2026-04-29-phase-3-scanner-pipeline-design.md)

---

## File Structure

**New files:**
```
pwa/src/theme/theme.css
pwa/src/theme/use-theme.ts
pwa/src/scanner/types.ts
pwa/src/scanner/scans-store.ts
pwa/src/scanner/stability.ts
pwa/src/scanner/camera.ts
pwa/src/scanner/edge-detect.ts
pwa/src/scanner/scanner-session.ts
pwa/src/ui/ScannerScreen.tsx
pwa/src/ui/EditCornersScreen.tsx
pwa/src/ui/SavedScansScreen.tsx
pwa/src/ui/ScanViewerScreen.tsx
pwa/src/ui/ResumePrompt.tsx
pwa/tests/theme/use-theme.test.ts
pwa/tests/scanner/scans-store.test.ts
pwa/tests/scanner/stability.test.ts
pwa/tests/ui/ResumePrompt.test.tsx
pwa/tests/ui/SavedScansScreen.test.tsx
pwa/tests/ui/EditCornersScreen.test.tsx
```

**Modified files:**
```
pwa/package.json            (new deps)
pwa/src/main.tsx            (import theme.css)
pwa/src/ui/App.tsx          (routing for new screens; ResumePrompt mount)
pwa/src/ui/StatusScreen.tsx (theme picker, "+ New Scan" + Saved Scans entry, theme classes)
pwa/src/ui/LoginScreen.tsx  (theme classes)
pwa/public/sw.js            (cache scanner chunk + jscanify wasm)
package-lock.json           (refreshed)
```

**Constants pinned in this plan (per spec-review recommendation):**
- `ESTIMATED_PAGE_BYTES = 400_000` — used for size column on SavedScansScreen
- `STABILITY_WINDOW_MS = 1500` — auto-capture stability duration
- `STABILITY_DRIFT_PX = 20` — max corner drift considered "still"
- `LIVE_PREVIEW_FPS = 6` — target frame rate for jscanify per-frame run
- `JPEG_QUALITY = 0.92` — page encoding quality
- `MAX_EDGE_PX = 2200` — page max edge after warp
- `THUMB_MAX_EDGE_PX = 256` — saved-scan thumbnail size

---

## Task 1: Install dependencies

**Files:**
- Modify: `pwa/package.json`
- Modify: `package-lock.json` (auto)

- [ ] **Step 1: Add deps to `pwa/package.json`**

Edit the dependencies + devDependencies sections:

```jsonc
"dependencies": {
  "preact": "10.29.1",
  "idb": "8.0.3",
  "ulid": "3.0.0"
},
"devDependencies": {
  // ... existing ...
  "fake-indexeddb": "6.2.2",
  "jscanify": "1.3.0"
}
```

Notes:
- `jscanify` is a runtime dep of the scanner chunk (not just dev) — but install **as devDependency** is fine because it's only imported via dynamic `import()` inside `edge-detect.ts` and bundled into the lazy chunk. Putting it under `dependencies` would also work; we go with `devDependencies` to make it explicit it's never required at server-side build time.
- Pin minor versions; bumps go through Renovate.

- [ ] **Step 2: Install + verify lockfile updates**

```bash
eval "$(fnm env)" && fnm use 24.15.0
npm install
```

Expected: `package-lock.json` updated with the four new packages and their transitive deps.

- [ ] **Step 3: Add `typecheck` script to pwa/package.json**

```jsonc
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

- [ ] **Step 4: Verify clean state**

```bash
npm --prefix pwa run typecheck
```

Expected: clean (no source changes yet).

- [ ] **Step 5: Commit**

```bash
git add pwa/package.json package-lock.json
git commit -m "chore(pwa): add idb, ulid, jscanify, fake-indexeddb"
```

---

## Task 2: Theme infrastructure

**Files:**
- Create: `pwa/src/theme/theme.css`
- Create: `pwa/src/theme/use-theme.ts`
- Create: `pwa/tests/theme/use-theme.test.ts`
- Modify: `pwa/src/main.tsx` (import theme.css)
- Modify: `pwa/index.html` (add `<meta name="theme-color">`)

### Step 1: Write `theme.css`

- [ ] Create `pwa/src/theme/theme.css`:

```css
:root {
  --bg: #ffffff;
  --bg-elev: #f7f7f7;
  --fg: #1a1a1a;
  --fg-muted: #6b6b6b;
  --border: #e0e0e0;
  --accent: #2563eb;
  --accent-fg: #ffffff;
  --danger: #b91c1c;
  --warn-bg: #fef3c7;
  --warn-border: #f59e0b;
  --success: #16a34a;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f0f0f;
    --bg-elev: #1a1a1a;
    --fg: #e8e8e8;
    --fg-muted: #9a9a9a;
    --border: #2a2a2a;
    --accent: #60a5fa;
    --accent-fg: #0f0f0f;
    --danger: #f87171;
    --warn-bg: #3a2f10;
    --warn-border: #b88a30;
    --success: #4ade80;
    color-scheme: dark;
  }
}

:root[data-theme="light"] {
  --bg: #ffffff;
  --bg-elev: #f7f7f7;
  --fg: #1a1a1a;
  --fg-muted: #6b6b6b;
  --border: #e0e0e0;
  --accent: #2563eb;
  --accent-fg: #ffffff;
  --danger: #b91c1c;
  --warn-bg: #fef3c7;
  --warn-border: #f59e0b;
  --success: #16a34a;
  color-scheme: light;
}

:root[data-theme="dark"] {
  --bg: #0f0f0f;
  --bg-elev: #1a1a1a;
  --fg: #e8e8e8;
  --fg-muted: #9a9a9a;
  --border: #2a2a2a;
  --accent: #60a5fa;
  --accent-fg: #0f0f0f;
  --danger: #f87171;
  --warn-bg: #3a2f10;
  --warn-border: #b88a30;
  --success: #4ade80;
  color-scheme: dark;
}

html, body { background: var(--bg); color: var(--fg); margin: 0; }
body { font-family: -apple-system, system-ui, sans-serif; }

.btn {
  background: var(--accent); color: var(--accent-fg);
  border: none; padding: 10px 16px; border-radius: 6px;
  font-size: 14px; font-weight: 500; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
.btn-danger { background: var(--danger); color: #fff; }

.card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.warn { background: var(--warn-bg); border: 1px solid var(--warn-border); padding: 12px; border-radius: 6px; }
.muted { color: var(--fg-muted); font-size: 13px; }

input, select { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; }

.auth-screen { max-width: 400px; margin: 40px auto; padding: 16px; }
.error-text { color: var(--danger); }
```

### Step 2: Write `use-theme.ts`

- [ ] Create `pwa/src/theme/use-theme.ts`:

```ts
import { useEffect, useState, useCallback } from 'preact/hooks';

export type ThemePreference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'theme';

function readStored(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function effective(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyToDom(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = effective(pref) === 'dark' ? '#0f0f0f' : '#ffffff';
}

export function useTheme(): { pref: ThemePreference; setPref: (p: ThemePreference) => void } {
  const [pref, setPrefState] = useState<ThemePreference>(readStored);

  useEffect(() => { applyToDom(pref); }, [pref]);

  // Re-apply when system preference changes (only relevant if pref === 'system')
  useEffect(() => {
    if (pref !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyToDom('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePreference) => {
    if (p === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, p);
    setPrefState(p);
  }, []);

  return { pref, setPref };
}
```

### Step 3: Write tests

- [ ] Create `pwa/tests/theme/use-theme.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useTheme } from '../../src/theme/use-theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // ensure a meta tag exists to assert against (use DOM API, not innerHTML)
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', '');
  document.head.appendChild(meta);
  // mock matchMedia: default to light
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('dark') ? false : true,
    media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

describe('useTheme', () => {
  it('defaults to system when no localStorage value', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.pref).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reads stored preference on mount', () => {
    localStorage.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.pref).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('writes to localStorage and updates DOM when setPref(light)', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPref('light'));
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('clears localStorage and removes data-theme when setPref(system)', () => {
    localStorage.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPref('system'));
    expect(localStorage.getItem('theme')).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('updates meta theme-color content on change', () => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPref('dark'));
    expect(meta.content).toBe('#0f0f0f');
    act(() => result.current.setPref('light'));
    expect(meta.content).toBe('#ffffff');
  });
});
```

- [ ] Run: `npm --prefix pwa test -- use-theme`
  - Expected: 5 passing.

### Step 4: Wire theme.css into the entry point

- [ ] Modify `pwa/src/main.tsx`. Add the import as the **first** line:

```ts
import './theme/theme.css';
import { render } from 'preact';
import { App } from './ui/App.js';
// ... rest unchanged ...
```

### Step 5: Add `<meta name="theme-color">` to index.html

- [ ] Read `pwa/index.html`, then add inside `<head>` (idempotent — keep any existing manifest theme-color):

```html
<meta name="theme-color" content="#ffffff">
```

### Step 6: Verify

- [ ] `npm --prefix pwa run typecheck && npm --prefix pwa test 2>&1 | tail -5`
  - Expected: typecheck clean, all tests pass (existing + 5 new).

### Step 7: Commit

- [ ] ```bash
git add pwa/src/theme pwa/src/main.tsx pwa/index.html pwa/tests/theme
git commit -m "feat(pwa): theme module with system/light/dark preference"
```

---

## Task 3: Migrate existing screens to theme + add picker

**Files:**
- Modify: `pwa/src/ui/LoginScreen.tsx`
- Modify: `pwa/src/ui/StatusScreen.tsx`
- Modify: `pwa/src/ui/App.tsx` (placeholder no-op handlers for new buttons)

### Step 1: Migrate LoginScreen.tsx

- [ ] Replace inline styles with theme classes. Keep all behavior. Specifically:
  - Outer `<main style={...}>` → `<main class="auth-screen">`
  - Warning block → keep `role="alert"` and use `class="warn"`
  - Error `<p style={{ color: '#b91c1c' }}>` → `<p class="error-text">`
  - Drop the inline `fontFamily` (now applied via body in theme.css)

### Step 2: Replace StatusScreen.tsx

- [ ] Replace `pwa/src/ui/StatusScreen.tsx` entirely with:

```tsx
import { api } from '../api.js';
import { useTheme } from '../theme/use-theme.js';

export interface StatusScreenProps {
  email: string;
  onLoggedOut: () => void;
  onNewScan: () => void;
  onViewSavedScans: () => void;
}

export function StatusScreen({ email, onLoggedOut, onNewScan, onViewSavedScans }: StatusScreenProps) {
  const { pref, setPref } = useTheme();
  async function logout() { await api.logout(); onLoggedOut(); }

  return (
    <main class="auth-screen">
      <h1>doc-scanner</h1>
      <p>Logged in as <strong>{email}</strong></p>

      <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <button class="btn" onClick={onNewScan}>+ New Scan</button>
        <button class="btn btn-secondary" onClick={onViewSavedScans}>Saved Scans</button>
      </div>

      <div class="card" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>Theme</div>
        <div role="radiogroup" style={{ display: 'flex', gap: 8 }}>
          {(['system', 'light', 'dark'] as const).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={pref === p}
              class={pref === p ? 'btn' : 'btn btn-secondary'}
              onClick={() => setPref(p)}
              style={{ textTransform: 'capitalize' }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <button class="btn btn-secondary" onClick={logout}>Sign out</button>
    </main>
  );
}
```

### Step 3: Update App.tsx (placeholder routing)

- [ ] We will replace App.tsx fully in Task 9. For now, add no-op handlers so typecheck passes:

```tsx
return email ? (
  <StatusScreen
    email={email}
    onLoggedOut={() => setEmail(null)}
    onNewScan={() => console.warn('scanner not wired yet')}
    onViewSavedScans={() => console.warn('saved scans not wired yet')}
  />
) : (
  <LoginScreen onLoggedIn={setEmail} />
);
```

### Step 4: Verify

- [ ] `npm --prefix pwa run typecheck && npm --prefix pwa test 2>&1 | tail -5`
  - Expected: typecheck clean. Existing `login.test.tsx` passes (asserts on text + presence, not on inline styles).

### Step 5: Commit

- [ ] ```bash
git add pwa/src/ui pwa/src/theme/theme.css
git commit -m "feat(pwa): migrate existing screens to theme classes; add theme picker"
```

---

## Task 4: scans-store (IndexedDB + types)

**Files:**
- Create: `pwa/src/scanner/types.ts`
- Create: `pwa/src/scanner/scans-store.ts`
- Create: `pwa/tests/scanner/scans-store.test.ts`
- Modify: `pwa/tests/setup.ts` (load fake-indexeddb)

### Step 1: Wire fake-indexeddb in test setup

- [ ] Replace `pwa/tests/setup.ts` with:

```ts
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
```

### Step 2: Define shared types

- [ ] Create `pwa/src/scanner/types.ts`:

```ts
export interface Point { x: number; y: number; }
export interface Quad { tl: Point; tr: Point; bl: Point; br: Point; }

export type ScanStatus = 'in_progress' | 'completed';

export interface Scan {
  id: string;          // ULID
  status: ScanStatus;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  thumbnailKey: string | null;
}

export interface Page {
  scanId: string;
  ordinal: number;
  blob: Blob;
  quad: Quad;
  capturedAt: number;
}

export interface Thumbnail {
  id: string;          // UUIDv4
  blob: Blob;
}

export const ESTIMATED_PAGE_BYTES = 400_000;
```

### Step 3: Write failing tests

- [ ] Create `pwa/tests/scanner/scans-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

const Q: Quad = { tl: {x:0,y:0}, tr: {x:100,y:0}, bl: {x:0,y:100}, br: {x:100,y:100} };

function blobOf(text: string): Blob { return new Blob([text], { type: 'image/jpeg' }); }

let store: ScansStore;

beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

describe('ScansStore', () => {
  it('createInProgress + appendPage + finish flow', async () => {
    const id = await store.createInProgress();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const ord = await store.appendPage(id, blobOf('p1'), Q);
    expect(ord).toBe(0);
    await store.appendPage(id, blobOf('p2'), Q);

    const beforeFinish = await store.findInProgress();
    expect(beforeFinish?.id).toBe(id);
    expect(beforeFinish?.pageCount).toBe(2);
    expect(beforeFinish?.thumbnailKey).toBeNull();

    await store.finish(id);
    const list = await store.listCompleted();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
    expect(list[0].status).toBe('completed');
    expect(list[0].thumbnailKey).not.toBeNull();
    expect(await store.findInProgress()).toBeNull();
  });

  it('updatePage replaces blob + quad at ordinal', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.appendPage(id, blobOf('p2-old'), Q);
    const newQ: Quad = { ...Q, tl: { x: 10, y: 10 } };
    await store.updatePage(id, 1, blobOf('p2-new'), newQ);
    const pages = await store.getPages(id);
    expect(pages[1].quad.tl).toEqual({ x: 10, y: 10 });
    expect(await pages[1].blob.text()).toBe('p2-new');
  });

  it('delete cascades pages and thumbnail', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    await store.delete(id);
    expect(await store.listCompleted()).toEqual([]);
    expect(await store.getPages(id)).toEqual([]);
  });

  it('listCompleted is sorted by updatedAt desc', async () => {
    const a = await store.createInProgress();
    await store.appendPage(a, blobOf('a'), Q);
    await store.finish(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createInProgress();
    await store.appendPage(b, blobOf('b'), Q);
    await store.finish(b);

    const list = await store.listCompleted();
    expect(list.map((s) => s.id)).toEqual([b, a]);
  });

  it('only one in-progress scan at a time', async () => {
    const a = await store.createInProgress();
    const b = await store.createInProgress();
    const found = await store.findInProgress();
    expect(found?.id).toBe(b);
    expect(await store.getPages(a)).toEqual([]);
  });

  it('getThumbnailBlob returns the saved thumb', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    const list = await store.listCompleted();
    const thumb = await store.getThumbnailBlob(list[0].thumbnailKey!);
    expect(thumb).toBeInstanceOf(Blob);
  });

  it('appendPage propagates QuotaExceededError from the underlying transaction', async () => {
    const id = await store.createInProgress();
    // Wrap db.transaction so its put rejects with a synthetic quota error.
    const realTx = (store as any).db.transaction.bind((store as any).db);
    (store as any).db.transaction = (...args: any[]) => {
      const tx = realTx(...args);
      const realStore = tx.objectStore.bind(tx);
      tx.objectStore = (name: string) => {
        const os = realStore(name);
        if (name === 'pages') {
          os.put = () => Promise.reject(new DOMException('quota exceeded', 'QuotaExceededError'));
        }
        return os;
      };
      return tx;
    };
    await expect(store.appendPage(id, blobOf('p1'), Q)).rejects.toThrow(/quota/i);
    (store as any).db.transaction = realTx;
  });
});
```

### Step 4: Implement `scans-store.ts`

- [ ] Create `pwa/src/scanner/scans-store.ts`:

```ts
import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import { ulid } from 'ulid';
import type { Page, Quad, Scan, Thumbnail } from './types.js';

interface DocScannerSchema extends DBSchema {
  scans: {
    key: string;
    value: Scan;
    indexes: { by_status: string; by_updatedAt: number };
  };
  pages: {
    key: [string, number];
    value: Page;
    indexes: { by_scan: string };
  };
  thumbs: {
    key: string;
    value: Thumbnail;
  };
}

const DB_NAME = 'docscanner';
const DB_VERSION = 1;

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class ScansStore {
  private db: IDBPDatabase<DocScannerSchema> | null = null;

  async open(): Promise<void> {
    this.db = await openDB<DocScannerSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const scans = db.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('by_status', 'status');
        scans.createIndex('by_updatedAt', 'updatedAt');

        const pages = db.createObjectStore('pages', { keyPath: ['scanId', 'ordinal'] });
        pages.createIndex('by_scan', 'scanId');

        db.createObjectStore('thumbs', { keyPath: 'id' });
      },
    });
  }

  private get d(): IDBPDatabase<DocScannerSchema> {
    if (!this.db) throw new Error('ScansStore not open()');
    return this.db;
  }

  async createInProgress(): Promise<string> {
    const prior = await this.findInProgress();
    if (prior) await this.delete(prior.id);

    const now = Date.now();
    const id = ulid();
    const scan: Scan = { id, status: 'in_progress', pageCount: 0, createdAt: now, updatedAt: now, thumbnailKey: null };
    await this.d.put('scans', scan);
    return id;
  }

  async findInProgress(): Promise<Scan | null> {
    const rows = await this.d.getAllFromIndex('scans', 'by_status', 'in_progress');
    return rows[0] ?? null;
  }

  async appendPage(scanId: string, blob: Blob, quad: Quad): Promise<number> {
    const tx = this.d.transaction(['scans', 'pages'], 'readwrite');
    const scan = await tx.objectStore('scans').get(scanId);
    if (!scan) throw new Error(`scan not found: ${scanId}`);
    const ordinal = scan.pageCount;
    await tx.objectStore('pages').put({ scanId, ordinal, blob, quad, capturedAt: Date.now() });
    scan.pageCount = ordinal + 1;
    scan.updatedAt = Date.now();
    await tx.objectStore('scans').put(scan);
    await tx.done;
    return ordinal;
  }

  async updatePage(scanId: string, ordinal: number, blob: Blob, quad: Quad): Promise<void> {
    const existing = await this.d.get('pages', [scanId, ordinal]);
    if (!existing) throw new Error(`page not found: ${scanId}/${ordinal}`);
    await this.d.put('pages', { ...existing, blob, quad });
    const scan = await this.d.get('scans', scanId);
    if (scan) {
      scan.updatedAt = Date.now();
      await this.d.put('scans', scan);
    }
  }

  async getPages(scanId: string): Promise<Page[]> {
    const all = await this.d.getAllFromIndex('pages', 'by_scan', scanId);
    return all.sort((a, b) => a.ordinal - b.ordinal);
  }

  async finish(scanId: string): Promise<void> {
    const pages = await this.getPages(scanId);
    if (pages.length === 0) throw new Error(`cannot finish empty scan: ${scanId}`);
    const thumb = await makeThumbnail(pages[0].blob);
    const thumbId = uuid();
    await this.d.put('thumbs', { id: thumbId, blob: thumb });

    const scan = await this.d.get('scans', scanId);
    if (!scan) throw new Error(`scan not found: ${scanId}`);
    scan.status = 'completed';
    scan.thumbnailKey = thumbId;
    scan.updatedAt = Date.now();
    await this.d.put('scans', scan);
  }

  async delete(scanId: string): Promise<void> {
    const tx = this.d.transaction(['scans', 'pages', 'thumbs'], 'readwrite');
    const scan = await tx.objectStore('scans').get(scanId);
    if (scan?.thumbnailKey) await tx.objectStore('thumbs').delete(scan.thumbnailKey);
    const pageKeys = await tx.objectStore('pages').index('by_scan').getAllKeys(scanId);
    for (const k of pageKeys) await tx.objectStore('pages').delete(k);
    await tx.objectStore('scans').delete(scanId);
    await tx.done;
  }

  async listCompleted(): Promise<Scan[]> {
    const all = await this.d.getAllFromIndex('scans', 'by_updatedAt');
    return all.filter((s) => s.status === 'completed').reverse();
  }

  async getThumbnailBlob(thumbId: string): Promise<Blob | null> {
    const t = await this.d.get('thumbs', thumbId);
    return t?.blob ?? null;
  }
}

/**
 * Decode a JPEG Blob, downscale to ≤256px max edge, return new JPEG Blob.
 * In test environments where OffscreenCanvas is unavailable, return source as-is.
 */
async function makeThumbnail(source: Blob): Promise<Blob> {
  if (typeof OffscreenCanvas === 'undefined') return source;

  const bitmap = await createImageBitmap(source);
  const max = 256;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}
```

### Step 5: Run tests

- [ ] `npm --prefix pwa test -- scans-store`
  - Expected: 7 passing.

### Step 6: Commit

- [ ] ```bash
git add pwa/src/scanner/types.ts pwa/src/scanner/scans-store.ts pwa/tests/scanner/scans-store.test.ts pwa/tests/setup.ts
git commit -m "feat(pwa): IndexedDB-backed ScansStore via idb"
```

---

## Task 5: stability detector

**Files:**
- Create: `pwa/src/scanner/stability.ts`
- Create: `pwa/tests/scanner/stability.test.ts`

### Step 1: Write failing tests

- [ ] Create `pwa/tests/scanner/stability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StabilityDetector } from '../../src/scanner/stability.js';
import type { Quad } from '../../src/scanner/types.js';

function quad(x: number, y: number): Quad {
  return {
    tl: { x, y },
    tr: { x: x + 100, y },
    bl: { x, y: y + 100 },
    br: { x: x + 100, y: y + 100 },
  };
}

describe('StabilityDetector', () => {
  it('returns "searching" with no prior frames', () => {
    const s = new StabilityDetector();
    expect(s.update(null, 0)).toBe('searching');
  });

  it('returns "counting" once a quad is seen', () => {
    const s = new StabilityDetector();
    expect(s.update(quad(10, 10), 0)).toBe('counting');
  });

  it('returns "stable" after 1.5s of stable quads', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    expect(s.update(quad(10, 10), 1500)).toBe('stable');
  });

  it('does not return stable when corners drift > 20px', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    expect(s.update(quad(50, 50), 1500)).toBe('counting');
  });

  it('resets counting when quad disappears', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    expect(s.update(null, 500)).toBe('searching');
    expect(s.update(quad(10, 10), 600)).toBe('counting');
    expect(s.update(quad(10, 10), 1000)).toBe('counting');
  });

  it('reset() clears state', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    s.update(quad(10, 10), 1500);
    s.reset();
    expect(s.update(quad(10, 10), 2000)).toBe('counting');
  });
});
```

### Step 2: Implement `stability.ts`

- [ ] Create `pwa/src/scanner/stability.ts`:

```ts
import type { Quad } from './types.js';

export type StabilityState = 'searching' | 'counting' | 'stable';
export const STABILITY_WINDOW_MS = 1500;
export const STABILITY_DRIFT_PX = 20;

interface Sample { quad: Quad; t: number; }

function maxCornerDrift(a: Quad, b: Quad): number {
  const corners: (keyof Quad)[] = ['tl', 'tr', 'bl', 'br'];
  let max = 0;
  for (const c of corners) {
    const dx = a[c].x - b[c].x;
    const dy = a[c].y - b[c].y;
    const d = Math.hypot(dx, dy);
    if (d > max) max = d;
  }
  return max;
}

export class StabilityDetector {
  private anchor: Sample | null = null;

  update(quad: Quad | null, now: number): StabilityState {
    if (!quad) {
      this.anchor = null;
      return 'searching';
    }
    if (!this.anchor) {
      this.anchor = { quad, t: now };
      return 'counting';
    }
    if (maxCornerDrift(quad, this.anchor.quad) > STABILITY_DRIFT_PX) {
      this.anchor = { quad, t: now };
      return 'counting';
    }
    return now - this.anchor.t >= STABILITY_WINDOW_MS ? 'stable' : 'counting';
  }

  reset(): void { this.anchor = null; }
}
```

### Step 3: Run tests

- [ ] `npm --prefix pwa test -- stability`
  - Expected: 6 passing.

### Step 4: Commit

- [ ] ```bash
git add pwa/src/scanner/stability.ts pwa/tests/scanner/stability.test.ts
git commit -m "feat(pwa): stability detector for auto-capture"
```

---

## Task 6: camera wrapper

**Files:**
- Create: `pwa/src/scanner/camera.ts`

No unit tests — covered by manual smoke (mocking getUserMedia is more work than it's worth).

### Step 1: Implement `camera.ts`

- [ ] Create `pwa/src/scanner/camera.ts`:

```ts
export type CameraErrorCode = 'permission_denied' | 'no_camera' | 'busy' | 'other';

export class CameraError extends Error {
  constructor(public readonly code: CameraErrorCode, message: string) {
    super(message);
  }
}

export interface CameraHandle {
  stream: MediaStream;
  stop(): void;
}

export async function startCamera(constraints: MediaStreamConstraints = defaultConstraints()): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('other', 'getUserMedia not supported');
  }
  // iOS Safari quirk: first call sometimes rejects with NotReadableError. Retry once.
  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !stream; attempt++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!stream) throw mapError(lastErr);
  return {
    stream,
    stop: () => stream!.getTracks().forEach((t) => t.stop()),
  };
}

function mapError(err: unknown): CameraError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraError('permission_denied', 'Camera permission denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CameraError('no_camera', 'No camera available');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new CameraError('busy', 'Camera is busy or unavailable');
  }
  return new CameraError('other', `Camera error: ${name || String(err)}`);
}

function defaultConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

/** Capture the current frame from a video element into a canvas. */
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}
```

### Step 2: Verify typecheck

- [ ] `npm --prefix pwa run typecheck`
  - Expected: clean.

### Step 3: Commit

- [ ] ```bash
git add pwa/src/scanner/camera.ts
git commit -m "feat(pwa): camera wrapper with iOS Safari retry"
```

---

## Task 7: edge-detect (jscanify, lazy-loaded)

**Files:**
- Create: `pwa/src/scanner/edge-detect.ts`

No unit tests per spec.

### Step 1: Discovery — confirm jscanify import shape

**Default to Variant B.** As of 1.3.0 jscanify is a UMD bundle that expects a globally-loaded OpenCV.js (`globalThis.cv`). Use Variant B unless step-1 evidence proves otherwise.

- [ ] Check the package shape briefly to confirm:

```bash
cat node_modules/jscanify/package.json | head -20
ls node_modules/jscanify/dist/ 2>/dev/null
grep -l "globalThis.cv\|window.cv\|require.*opencv" node_modules/jscanify/dist/*.js 2>/dev/null | head -3
```

If `grep` finds `globalThis.cv` / `window.cv` references → Variant B (default).
If the dist directory contains an `.wasm` file or a `cv.js` bundle larger than 5 MB → Variant A.

### Step 2: Implement `edge-detect.ts`

**Variant A — jscanify bundles its own opencv (likely false for 1.3.0):**

```ts
import type { Quad } from './types.js';

export const JPEG_QUALITY = 0.92;
export const MAX_EDGE_PX = 2200;

let modulePromise: Promise<{ scanner: any }> | null = null;

async function loadScanner() {
  if (!modulePromise) {
    modulePromise = (async () => {
      // @ts-expect-error - jscanify has no upstream types
      const mod = await import('jscanify');
      const Scanner = mod.default ?? mod;
      const scanner = new Scanner();
      if (typeof scanner.loadOpenCV === 'function') await scanner.loadOpenCV();
      return { scanner };
    })();
  }
  return modulePromise;
}

export async function findQuad(canvas: HTMLCanvasElement): Promise<Quad | null> {
  const { scanner } = await loadScanner();
  const points = scanner.getCornerPoints(canvas);
  if (!points || !points.topLeftCorner) return null;
  return {
    tl: points.topLeftCorner,
    tr: points.topRightCorner,
    bl: points.bottomLeftCorner,
    br: points.bottomRightCorner,
  };
}

export async function warpToFlat(canvas: HTMLCanvasElement, quad: Quad): Promise<Blob> {
  const { scanner } = await loadScanner();
  const warped: HTMLCanvasElement = scanner.extractPaper(
    canvas,
    canvas.width,
    canvas.height,
    {
      topLeftCorner: quad.tl,
      topRightCorner: quad.tr,
      bottomLeftCorner: quad.bl,
      bottomRightCorner: quad.br,
    },
  );
  return await downscaleToBlob(warped, MAX_EDGE_PX, JPEG_QUALITY);
}

async function downscaleToBlob(canvas: HTMLCanvasElement, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d')!.drawImage(canvas, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/jpeg', quality);
  });
}

export function defaultQuad(width: number, height: number): Quad {
  const insetX = width * 0.1;
  const insetY = height * 0.1;
  return {
    tl: { x: insetX, y: insetY },
    tr: { x: width - insetX, y: insetY },
    bl: { x: insetX, y: height - insetY },
    br: { x: width - insetX, y: height - insetY },
  };
}
```

**Variant B — jscanify expects global opencv:** add the loader steps below to the top of `loadScanner()`:

```ts
async function loadOpenCV(): Promise<void> {
  if ((globalThis as any).cv) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    script.onload = () => {
      // OpenCV.js calls onRuntimeInitialized when the wasm is ready
      (globalThis as any).cv['onRuntimeInitialized'] = () => resolve();
    };
    script.onerror = () => reject(new Error('failed to load opencv.js'));
    document.head.appendChild(script);
  });
}
```

Then call `await loadOpenCV()` before constructing `new Scanner()`.

### Step 3: Verify typecheck

- [ ] `npm --prefix pwa run typecheck`

### Step 4: Commit

- [ ] ```bash
git add pwa/src/scanner/edge-detect.ts
git commit -m "feat(pwa): jscanify edge-detect wrapper (lazy-loaded)"
```

---

## Task 8: scanner-session controller

**Files:**
- Create: `pwa/src/scanner/scanner-session.ts`

No unit tests — too many moving parts; manual smoke covers integration.

### Step 1: Implement

- [ ] Create `pwa/src/scanner/scanner-session.ts`:

```ts
import { startCamera, captureFrame, type CameraHandle } from './camera.js';
import { findQuad, warpToFlat, defaultQuad } from './edge-detect.js';
import { StabilityDetector, type StabilityState } from './stability.js';
import { ScansStore } from './scans-store.js';
import type { Quad } from './types.js';

export const LIVE_PREVIEW_FPS = 6;
const FRAME_INTERVAL_MS = 1000 / LIVE_PREVIEW_FPS;

export interface SessionEvents {
  onStability?: (state: StabilityState, quad: Quad | null) => void;
  onPageAdded?: (ordinal: number, blob: Blob) => void;
  onError?: (err: Error) => void;
}

export class ScannerSession {
  private cam: CameraHandle | null = null;
  private video: HTMLVideoElement | null = null;
  private stability = new StabilityDetector();
  private rafId: number | null = null;
  private lastFrameAt = 0;
  private capturing = false;
  private autoCaptureEnabled = true;
  private currentQuad: Quad | null = null;

  constructor(
    public readonly scanId: string,
    private readonly store: ScansStore,
    private readonly events: SessionEvents = {},
  ) {}

  static async start(store: ScansStore, events: SessionEvents = {}): Promise<ScannerSession> {
    const id = await store.createInProgress();
    return new ScannerSession(id, store, events);
  }

  static async resume(scanId: string, store: ScansStore, events: SessionEvents = {}): Promise<ScannerSession> {
    return new ScannerSession(scanId, store, events);
  }

  async attachVideo(video: HTMLVideoElement): Promise<void> {
    this.cam = await startCamera();
    this.video = video;
    video.srcObject = this.cam.stream;
    await video.play();
    this.startLoop();
  }

  setAutoCapture(on: boolean): void {
    this.autoCaptureEnabled = on;
    if (!on) this.stability.reset();
  }

  /**
   * Manual shutter. Returns the current frame's canvas + the last detected quad
   * (or null). UI routes to EditCornersScreen with this canvas + a fallback quad
   * when no detection was available.
   */
  manualCapture(): { canvas: HTMLCanvasElement; quad: Quad | null } {
    if (!this.video) throw new Error('no video');
    const canvas = captureFrame(this.video);
    return { canvas, quad: this.currentQuad };
  }

  /** Commit a captured frame as a page (after auto-capture or EditCornersScreen Apply). */
  async commitPage(canvas: HTMLCanvasElement, quad: Quad): Promise<void> {
    this.capturing = true;
    try {
      const blob = await warpToFlat(canvas, quad);
      const ordinal = await this.store.appendPage(this.scanId, blob, quad);
      this.events.onPageAdded?.(ordinal, blob);
      this.stability.reset();
    } finally {
      this.capturing = false;
    }
  }

  async finish(): Promise<void> {
    this.stop();
    await this.store.finish(this.scanId);
  }

  async discard(): Promise<void> {
    this.stop();
    await this.store.delete(this.scanId);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.cam?.stop();
    this.cam = null;
    if (this.video) this.video.srcObject = null;
  }

  private startLoop(): void {
    const loop = (t: number) => {
      this.rafId = requestAnimationFrame(loop);
      if (this.capturing) return;
      if (t - this.lastFrameAt < FRAME_INTERVAL_MS) return;
      this.lastFrameAt = t;
      this.processFrame().catch((e) => this.events.onError?.(e as Error));
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private async processFrame(): Promise<void> {
    if (!this.video) return;
    const canvas = captureFrame(this.video);
    let quad: Quad | null = null;
    try { quad = await findQuad(canvas); } catch { quad = null; }
    this.currentQuad = quad;
    const state = this.stability.update(quad, performance.now());
    this.events.onStability?.(state, quad);
    if (state === 'stable' && this.autoCaptureEnabled && quad) {
      await this.commitPage(canvas, quad);
    }
  }
}

export { defaultQuad };
```

### Step 2: Verify typecheck

- [ ] `npm --prefix pwa run typecheck`

### Step 3: Commit

- [ ] ```bash
git add pwa/src/scanner/scanner-session.ts
git commit -m "feat(pwa): scanner-session controller orchestrating capture loop"
```

---

## Task 9: App.tsx routing

**Files:**
- Modify: `pwa/src/ui/App.tsx`

### Step 1: Replace App.tsx

- [ ] Replace `pwa/src/ui/App.tsx` with:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { LoginScreen } from './LoginScreen.js';
import { StatusScreen } from './StatusScreen.js';
import { ScannerScreen } from './ScannerScreen.js';
import { SavedScansScreen } from './SavedScansScreen.js';
import { ScanViewerScreen } from './ScanViewerScreen.js';
import { ResumePrompt } from './ResumePrompt.js';
import { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';

type Route =
  | { kind: 'status' }
  | { kind: 'scanner'; resumeScanId?: string }
  | { kind: 'saved' }
  | { kind: 'viewer'; scanId: string };

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'status' });
  const [store] = useState(() => new ScansStore());
  const [resume, setResume] = useState<Scan | null>(null);

  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
    store.open().catch((e) => console.error('open store', e));
  }, []);

  useEffect(() => {
    if (!email) return;
    store.findInProgress().then((s) => setResume(s));
  }, [email]);

  if (!loaded) return <main class="auth-screen">Loading…</main>;
  if (!email) return <LoginScreen onLoggedIn={setEmail} />;

  if (resume && route.kind === 'status') {
    return (
      <ResumePrompt
        scan={resume}
        onResume={() => { setResume(null); setRoute({ kind: 'scanner', resumeScanId: resume.id }); }}
        onDiscard={async () => { await store.delete(resume.id); setResume(null); }}
      />
    );
  }

  switch (route.kind) {
    case 'status':
      return <StatusScreen
        email={email}
        onLoggedOut={() => setEmail(null)}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onViewSavedScans={() => setRoute({ kind: 'saved' })}
      />;
    case 'scanner':
      return <ScannerScreen
        store={store}
        resumeScanId={route.resumeScanId}
        onBack={() => setRoute({ kind: 'status' })}
        onDone={() => setRoute({ kind: 'saved' })}
      />;
    case 'saved':
      return <SavedScansScreen
        store={store}
        onBack={() => setRoute({ kind: 'status' })}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onView={(scanId) => setRoute({ kind: 'viewer', scanId })}
      />;
    case 'viewer':
      return <ScanViewerScreen
        store={store}
        scanId={route.scanId}
        onBack={() => setRoute({ kind: 'saved' })}
      />;
  }
}
```

### Step 2: Don't typecheck or commit yet

The next tasks create the referenced screens. Single commit after Task 14.

---

## Task 10: ResumePrompt + tests

**Files:**
- Create: `pwa/src/ui/ResumePrompt.tsx`
- Create: `pwa/tests/ui/ResumePrompt.test.tsx`

### Step 1: Write failing test

- [ ] Create `pwa/tests/ui/ResumePrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ResumePrompt } from '../../src/ui/ResumePrompt.js';
import type { Scan } from '../../src/scanner/types.js';

const SCAN: Scan = {
  id: '01JXX',
  status: 'in_progress',
  pageCount: 3,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  thumbnailKey: null,
};

describe('ResumePrompt', () => {
  it('shows page count', () => {
    render(<ResumePrompt scan={SCAN} onResume={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText(/3 pages/i)).toBeInTheDocument();
  });

  it('Resume calls onResume', () => {
    const onResume = vi.fn();
    render(<ResumePrompt scan={SCAN} onResume={onResume} onDiscard={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onResume).toHaveBeenCalled();
  });

  it('Discard calls onDiscard', () => {
    const onDiscard = vi.fn();
    render(<ResumePrompt scan={SCAN} onResume={() => {}} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
```

### Step 2: Implement

- [ ] Create `pwa/src/ui/ResumePrompt.tsx`:

```tsx
import type { Scan } from '../scanner/types.js';

export interface ResumePromptProps {
  scan: Scan;
  onResume: () => void;
  onDiscard: () => void;
}

function relativeTime(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function ResumePrompt({ scan, onResume, onDiscard }: ResumePromptProps) {
  return (
    <main class="auth-screen">
      <div class="card">
        <h2 style={{ marginTop: 0 }}>Unfinished scan</h2>
        <p>You have an in-progress scan with <strong>{scan.pageCount} pages</strong> from {relativeTime(scan.createdAt)}.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn" onClick={onResume}>Resume scanning</button>
          <button class="btn btn-secondary" onClick={onDiscard}>Discard</button>
        </div>
      </div>
    </main>
  );
}
```

### Step 3: Run tests

- [ ] `npm --prefix pwa test -- ResumePrompt`
  - Expected: 3 passing.

### Step 4: Commit

- [ ] ```bash
git add pwa/src/ui/ResumePrompt.tsx pwa/tests/ui/ResumePrompt.test.tsx
git commit -m "feat(pwa): ResumePrompt for in-progress scans"
```

---

## Task 11: ScannerScreen

**Files:**
- Create: `pwa/src/ui/ScannerScreen.tsx`

No unit tests — manual smoke covers it.

### Step 1: Implement

- [ ] Create `pwa/src/ui/ScannerScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import { ScannerSession, defaultQuad } from '../scanner/scanner-session.js';
import type { StabilityState } from '../scanner/stability.js';
import type { Quad } from '../scanner/types.js';
import { CameraError } from '../scanner/camera.js';
import { EditCornersScreen } from './EditCornersScreen.js';

const AUTO_CAPTURE_KEY = 'auto_capture_enabled';

export interface ScannerScreenProps {
  store: ScansStore;
  resumeScanId?: string;
  onBack: () => void;
  onDone: () => void;
}

interface PendingEdit {
  canvas: HTMLCanvasElement;
  initialQuad: Quad;
}

export function ScannerScreen({ store, resumeScanId, onBack, onDone }: ScannerScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<ScannerSession | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [stability, setStability] = useState<StabilityState>('searching');
  const [autoCapture, setAutoCapture] = useState(() => localStorage.getItem(AUTO_CAPTURE_KEY) !== 'false');
  const [error, setError] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const events = {
          onStability: (s: StabilityState) => setStability(s),
          onPageAdded: () => setPageCount((c) => c + 1),
        };
        const session = resumeScanId
          ? await ScannerSession.resume(resumeScanId, store, events)
          : await ScannerSession.start(store, events);
        if (cancelled) { session.stop(); return; }
        sessionRef.current = session;
        if (resumeScanId) {
          const pages = await store.getPages(resumeScanId);
          setPageCount(pages.length);
        }
        session.setAutoCapture(autoCapture);
        if (videoRef.current) await session.attachVideo(videoRef.current);
      } catch (err) {
        if (err instanceof CameraError) setError(err.message);
        else setError(String((err as Error).message ?? err));
      }
    })();
    return () => { cancelled = true; sessionRef.current?.stop(); };
  }, [resumeScanId]);

  function toggleAuto() {
    const next = !autoCapture;
    setAutoCapture(next);
    localStorage.setItem(AUTO_CAPTURE_KEY, String(next));
    sessionRef.current?.setAutoCapture(next);
  }

  function shutter() {
    const session = sessionRef.current;
    if (!session) return;
    const { canvas, quad } = session.manualCapture();
    setPendingEdit({ canvas, initialQuad: quad ?? defaultQuad(canvas.width, canvas.height) });
  }

  async function applyEdit(quad: Quad) {
    if (!pendingEdit) return;
    await sessionRef.current?.commitPage(pendingEdit.canvas, quad);
    setPendingEdit(null);
  }

  async function done() {
    if (pageCount === 0) {
      await sessionRef.current?.discard();
      onBack();
      return;
    }
    await sessionRef.current?.finish();
    onDone();
  }

  async function cancel() {
    await sessionRef.current?.discard();
    onBack();
  }

  if (pendingEdit) {
    return <EditCornersScreen
      canvas={pendingEdit.canvas}
      initialQuad={pendingEdit.initialQuad}
      onCancel={() => setPendingEdit(null)}
      onApply={applyEdit}
    />;
  }

  if (error) {
    return (
      <main class="auth-screen">
        <div class="warn"><strong>Camera unavailable.</strong> {error}</div>
        <p class="muted">Open Settings → Safari → Camera and allow access.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn" onClick={() => location.reload()}>Try again</button>
          <button class="btn btn-secondary" onClick={onBack}>Back</button>
        </div>
      </main>
    );
  }

  const stabilityMsg =
    stability === 'searching' ? 'Position page in view' :
    stability === 'counting' ? 'Hold steady…' :
    'Capturing…';

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 8, color: '#fff' }}>
        <button class="btn btn-secondary" onClick={cancel}>← Cancel</button>
        <div>Page {pageCount + 1}</div>
        <button
          class={autoCapture ? 'btn' : 'btn btn-secondary'}
          onClick={toggleAuto}
          aria-pressed={autoCapture}
        >Auto {autoCapture ? 'on' : 'off'}</button>
      </header>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{
          position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center',
          color: stability === 'stable' ? '#4ade80' : '#fbbf24', fontWeight: 600,
        }}>
          {stabilityMsg}
        </div>
      </div>
      <footer style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: 12, background: '#111', color: '#fff' }}>
        <span class="muted">Pages: {pageCount}</span>
        <button
          aria-label="Capture"
          onClick={shutter}
          style={{ width: 64, height: 64, borderRadius: '50%', border: '4px solid #fff', background: 'rgba(255,255,255,0.18)' }}
        />
        <button class="btn" onClick={done} disabled={pageCount === 0}>Done →</button>
      </footer>
    </main>
  );
}
```

### Step 2: Don't typecheck yet

EditCornersScreen doesn't exist; Task 12 creates it.

---

## Task 12: EditCornersScreen + tests

**Files:**
- Create: `pwa/src/ui/EditCornersScreen.tsx`
- Create: `pwa/tests/ui/EditCornersScreen.test.tsx`

### Step 1: Write failing tests

- [ ] Create `pwa/tests/ui/EditCornersScreen.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { EditCornersScreen } from '../../src/ui/EditCornersScreen.js';
import type { Quad } from '../../src/scanner/types.js';

function fakeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 300;
  return c;
}

const VALID_QUAD: Quad = {
  tl: { x: 10, y: 10 }, tr: { x: 200, y: 10 },
  bl: { x: 10, y: 200 }, br: { x: 200, y: 200 },
};

const DEGENERATE_QUAD: Quad = {
  tl: { x: 100, y: 100 }, tr: { x: 100, y: 100 },
  bl: { x: 100, y: 100 }, br: { x: 100, y: 100 },
};

describe('EditCornersScreen', () => {
  it('renders Cancel and Apply buttons', () => {
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={() => {}} />);
    expect(screen.getAllByRole('button', { name: /cancel/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^apply$/i })).toBeInTheDocument();
  });

  it('Apply is disabled with degenerate quad', () => {
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={DEGENERATE_QUAD} onCancel={() => {}} onApply={() => {}} />);
    expect(screen.getByRole('button', { name: /^apply$/i })).toBeDisabled();
  });

  it('Apply with valid quad calls onApply', () => {
    const onApply = vi.fn();
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    expect(onApply).toHaveBeenCalledWith(VALID_QUAD);
  });

  it('Cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={onCancel} onApply={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: /cancel/i })[0]);
    expect(onCancel).toHaveBeenCalled();
  });
});
```

### Step 2: Implement

- [ ] Create `pwa/src/ui/EditCornersScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Quad, Point } from '../scanner/types.js';

export interface EditCornersScreenProps {
  canvas: HTMLCanvasElement;
  initialQuad: Quad;
  onCancel: () => void;
  onApply: (quad: Quad) => void;
}

const HANDLE_RADIUS = 14;

function quadIsValid(q: Quad): boolean {
  const a = signedArea([q.tl, q.tr, q.br, q.bl]);
  return Math.abs(a) > 100;
}

function signedArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function EditCornersScreen({ canvas, initialQuad, onCancel, onApply }: EditCornersScreenProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [quad, setQuad] = useState<Quad>(initialQuad);
  const [scale, setScale] = useState(1);
  const [dragKey, setDragKey] = useState<keyof Quad | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.appendChild(canvas);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    const observe = () => {
      const rect = canvas.getBoundingClientRect();
      setScale(rect.width / canvas.width || 1);
    };
    observe();
    window.addEventListener('resize', observe);
    return () => { window.removeEventListener('resize', observe); canvas.remove(); };
  }, [canvas]);

  function onPointerDown(key: keyof Quad) {
    return (e: PointerEvent) => {
      e.preventDefault();
      setDragKey(key);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragKey || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    setQuad((q) => ({ ...q, [dragKey]: { x: clamp(x, 0, canvas.width), y: clamp(y, 0, canvas.height) } }));
  }

  function onPointerUp() { setDragKey(null); }

  const valid = quadIsValid(quad);

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <strong>Adjust corners</strong>
        <span style={{ width: 60 }} />
      </header>
      <div ref={wrapRef} style={{ flex: 1, position: 'relative', padding: 12, overflow: 'auto' }}
           onPointerMove={onPointerMove}
           onPointerUp={onPointerUp}>
        {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
          <div
            key={k}
            onPointerDown={onPointerDown(k)}
            style={{
              position: 'absolute', width: HANDLE_RADIUS * 2, height: HANDLE_RADIUS * 2,
              borderRadius: '50%', background: 'var(--accent)', border: '2px solid #fff',
              left: quad[k].x * scale - HANDLE_RADIUS + 12,
              top: quad[k].y * scale - HANDLE_RADIUS + 12,
              touchAction: 'none', cursor: 'grab',
            }}
            aria-label={`Corner ${k}`}
          />
        ))}
      </div>
      <footer style={{ display: 'flex', gap: 8, padding: 12, background: 'var(--bg-elev)', borderTop: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
        <button class="btn" style={{ flex: 1 }} onClick={() => onApply(quad)} disabled={!valid}>Apply</button>
      </footer>
      {!valid && <p class="error-text" style={{ textAlign: 'center', padding: 4 }}>Corners must form a quadrilateral</p>}
    </main>
  );
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
```

### Step 3: Tests pass

- [ ] `npm --prefix pwa test -- EditCornersScreen`
  - Expected: 4 passing.

### Step 4: Commit

- [ ] ```bash
git add pwa/src/ui/EditCornersScreen.tsx pwa/src/ui/ScannerScreen.tsx pwa/tests/ui/EditCornersScreen.test.tsx
git commit -m "feat(pwa): ScannerScreen and EditCornersScreen"
```

---

## Task 13: SavedScansScreen + tests

**Files:**
- Create: `pwa/src/ui/SavedScansScreen.tsx`
- Create: `pwa/tests/ui/SavedScansScreen.test.tsx`

### Step 1: Write failing tests

- [ ] Create `pwa/tests/ui/SavedScansScreen.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { SavedScansScreen } from '../../src/ui/SavedScansScreen.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

let store: ScansStore;

beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });

describe('SavedScansScreen', () => {
  it('shows empty state when no scans', async () => {
    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no saved scans/i)).toBeInTheDocument());
  });

  it('lists completed scans with page count', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);

    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/2 pages/i)).toBeInTheDocument());
  });

  it('delete removes the scan', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 page/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(screen.getByText(/no saved scans/i)).toBeInTheDocument());
  });
});
```

### Step 2: Implement

- [ ] Create `pwa/src/ui/SavedScansScreen.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import { ESTIMATED_PAGE_BYTES, type Scan } from '../scanner/types.js';

export interface SavedScansScreenProps {
  store: ScansStore;
  onBack: () => void;
  onNewScan: () => void;
  onView: (scanId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleString();
}

export function SavedScansScreen({ store, onBack, onNewScan, onView }: SavedScansScreenProps) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  async function reload() {
    const list = await store.listCompleted();
    setScans(list);
    const t: Record<string, string> = {};
    for (const s of list) {
      if (!s.thumbnailKey) continue;
      const blob = await store.getThumbnailBlob(s.thumbnailKey);
      if (blob) t[s.id] = URL.createObjectURL(blob);
    }
    setThumbs(t);
  }

  useEffect(() => {
    reload();
    return () => Object.values(thumbs).forEach(URL.revokeObjectURL);
  }, []);

  async function del(scanId: string) {
    if (!window.confirm('Delete this scan?')) return;
    await store.delete(scanId);
    await reload();
  }

  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onBack}>← Back</button>
        <strong>Saved Scans</strong>
        <span style={{ width: 60 }} />
      </header>
      <button class="btn" style={{ width: '100%', borderRadius: 0 }} onClick={onNewScan}>+ New Scan</button>
      {scans === null ? (
        <p style={{ padding: 16 }} class="muted">Loading…</p>
      ) : scans.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center' }} class="muted">
          <p>No saved scans yet.</p>
          <button class="btn" onClick={onNewScan}>+ Start your first scan</button>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {scans.map((s) => (
            <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => onView(s.id)} style={{ all: 'unset', cursor: 'pointer', flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, aspectRatio: '4/5', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  {thumbs[s.id] && <img src={thumbs[s.id]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>Scan · {s.pageCount} {s.pageCount === 1 ? 'page' : 'pages'}</div>
                  <div class="muted" style={{ fontSize: 12 }}>{formatTime(s.updatedAt)} · {formatBytes(s.pageCount * ESTIMATED_PAGE_BYTES)}</div>
                </div>
              </button>
              <button class="btn btn-danger" aria-label="Delete" onClick={() => del(s.id)}>🗑</button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

### Step 3: Tests pass

- [ ] `npm --prefix pwa test -- SavedScansScreen`
  - Expected: 3 passing.

### Step 4: Commit

- [ ] ```bash
git add pwa/src/ui/SavedScansScreen.tsx pwa/tests/ui/SavedScansScreen.test.tsx
git commit -m "feat(pwa): SavedScansScreen list view"
```

---

## Task 14: ScanViewerScreen + final wire-up

**Files:**
- Create: `pwa/src/ui/ScanViewerScreen.tsx`

### Step 1: Implement

- [ ] Create `pwa/src/ui/ScanViewerScreen.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import type { Page } from '../scanner/types.js';

export interface ScanViewerScreenProps {
  store: ScansStore;
  scanId: string;
  onBack: () => void;
}

export function ScanViewerScreen({ store, scanId, onBack }: ScanViewerScreenProps) {
  const [pages, setPages] = useState<Page[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let revoke: string[] = [];
    store.getPages(scanId).then((p) => {
      setPages(p);
      const u = p.map((page) => URL.createObjectURL(page.blob));
      setUrls(u);
      revoke = u;
    });
    return () => revoke.forEach(URL.revokeObjectURL);
  }, [scanId]);

  async function deleteScan() {
    if (!window.confirm('Delete this scan?')) return;
    await store.delete(scanId);
    onBack();
  }

  if (urls.length === 0) return <main class="auth-screen"><p class="muted">Loading…</p></main>;

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onBack}>← Back</button>
        <strong>{idx + 1} / {pages.length}</strong>
        <button class="btn btn-danger" aria-label="Delete scan" onClick={deleteScan}>🗑</button>
      </header>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'hidden' }}>
        <img src={urls[idx]} alt={`Page ${idx + 1}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </div>
      <footer style={{ display: 'flex', gap: 8, padding: 12, background: 'var(--bg-elev)', borderTop: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>‹ Prev</button>
        <div style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'center' }}>
          {pages.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              style={{
                width: 24, aspectRatio: '4/5', borderRadius: 3,
                background: 'var(--bg)',
                border: i === idx ? '2px solid var(--accent)' : '1px solid var(--border)',
                cursor: 'pointer',
              }}
              aria-label={`Page ${i + 1}`}
            />
          ))}
        </div>
        <button class="btn btn-secondary" disabled={idx === pages.length - 1} onClick={() => setIdx((i) => i + 1)}>Next ›</button>
      </footer>
    </main>
  );
}
```

### Step 2: Full typecheck + test run

- [ ] ```bash
npm --prefix pwa run typecheck
npm --prefix pwa test 2>&1 | tail -10
```

Expected: typecheck clean. All tests pass: existing `login.test.tsx` (2) + new tests (`use-theme` 5 + `scans-store` 7 + `stability` 6 + `ResumePrompt` 3 + `EditCornersScreen` 4 + `SavedScansScreen` 3) = **30 total**.

### Step 3: Configure Vite manualChunks so the SW can pattern-match scanner chunks

Vite's default chunk names are hashed and don't include the source path, so the SW patterns in Task 15 won't reliably match. Pin the chunk names with `manualChunks`.

- [ ] Modify `pwa/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('jscanify')) return 'scanner-jscanify';
          if (id.includes('/scanner/edge-detect') || id.includes('/scanner/scanner-session')) return 'scanner-core';
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
  } as any,
});
```

### Step 4: Vite build sanity check

- [ ] `npm --prefix pwa run build 2>&1 | tail -15`
  - Expected: builds. `dist/assets/` contains files matching `scanner-jscanify-*.js` and `scanner-core-*.js`.
  - Verify with: `ls pwa/dist/assets/ | grep scanner`

### Step 5: Commit

- [ ] ```bash
git add pwa/src/ui/ScanViewerScreen.tsx pwa/src/ui/App.tsx pwa/vite.config.ts
git commit -m "feat(pwa): ScanViewerScreen + wire all screens into App"
```

---

## Task 15: Service Worker — cache scanner chunk + jscanify wasm

**Files:**
- Modify: `pwa/public/sw.js`

### Step 1: Replace `sw.js`

- [ ] Replace contents of `pwa/public/sw.js`:

```js
// doc-scanner Service Worker.
// Caches the scanner chunk (split out by Vite as a dynamic-import chunk) and
// the jscanify wasm so subsequent opens work fully offline.

const CACHE_NAME = 'docscanner-scanner-v1';
const RUNTIME_CACHE_PATTERNS = [
  /\/assets\/scanner-jscanify-.*\.js$/,
  /\/assets\/scanner-core-.*\.js$/,
  /\.wasm$/,
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (!RUNTIME_CACHE_PATTERNS.some((re) => re.test(url.pathname))) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (err) {
      return cached ?? Response.error();
    }
  })());
});
```

This is a stale-while-revalidate cache that **only** matches scanner-chunk-shaped URLs. We deliberately avoid caching the entire app shell.

### Step 2: Verify no test regressions

- [ ] `npm --prefix pwa run build && npm --prefix pwa test 2>&1 | tail -5`

### Step 3: Commit

- [ ] ```bash
git add pwa/public/sw.js
git commit -m "feat(pwa): service worker caches scanner chunk + jscanify wasm"
```

---

## Task 16: Manual smoke + tag

User-driven, not automated.

### Step 1: Stability tuning checkpoint

- [ ] On a real phone, run a few captures and feel out the 1.5s stability window. If auto-capture fires too eagerly, bump `STABILITY_WINDOW_MS` and `STABILITY_DRIFT_PX` in `stability.ts`. If it never fires, drop them. Re-run `npm --prefix pwa test -- stability` so the constants stay covered.
- [ ] If you tweak constants, commit: `git commit -am "tune(pwa): stability thresholds based on real-device feel"`

### Step 2: Boot stack

- [ ] ```bash
docker compose down && docker compose up -d --build
eval "$(fnm env)" && fnm use 24.15.0
npm --prefix pwa run dev
```

### Step 3: Run all 6 manual smoke cases

- [ ] Capture single-page doc, good light, auto-capture → page in saved scans
- [ ] Capture 5-page doc → all 5 pages, in order, viewable
- [ ] Force-kill PWA mid-scan → ResumePrompt next open
- [ ] Toggle iOS dark mode while app open → re-themes without reload
- [ ] Deny camera → friendly error → grant via Settings → "Try again" works
- [ ] Airplane-mode before first open → graceful "Edge detection unavailable" banner; manual flow works

### Step 4: Record results in this plan

- [ ] Append to the bottom:

```markdown
## Smoke Results

_Date:_ <YYYY-MM-DD>
_Test device:_ <iPhone model + iOS version, or Android model + version>
_Notes:_
- <one bullet per smoke case, indicating pass/fail and any caveats>
```

### Step 5: Final commits + tag

- [ ] ```bash
git add docs/superpowers/plans/2026-04-29-phase-3-scanner-pipeline.md
git commit -m "docs: phase 3 smoke recorded"
git tag -a phase-3-complete -m "Phase 3: Scanner pipeline — smoke verified"
git push origin main
git push origin phase-3-complete
```

---

## Phase 3 Done — Definition

- All Phase 1, 2, 3 unit tests pass: server-side and PWA-side.
- `pwa/dist/` builds clean; chunk-split contains a separate jscanify/scanner chunk.
- Phase 1 + Phase 2 manual smokes still work (login, status persistence, test-upload curl).
- Phase 3 manual smoke succeeds end-to-end on a real phone (the 6 cases above).
- No new server endpoints. No edits to `server/` source.
- `phase-3-complete` tag pushed to origin.

---

## Smoke Results

_Date:_ 2026-04-29
_Test device:_ iPhone (Safari) via ngrok HTTPS tunnel → docker-served PWA on `localhost:3000`
_Notes:_

End-to-end verified on real iPhone. Auto-capture confirmed working after extensive real-device tuning (see "Issues found" below). Manual shutter + EditCorners path works as designed.

### What was verified

- Login on iPhone Safari → cookie set → Status screen with theme picker, "+ New Scan", and "Saved Scans" buttons
- Camera permission grant → live viewfinder mounts
- Auto-capture: detects page corners, shows "Hold steady…", auto-fires after 1.5s of stable detection (with the 100px drift threshold + EMA smoothing)
- Manual shutter → EditCornersScreen with all 4 corners reachable in viewport, drag-to-adjust, Apply commits the page
- Multi-page collation: 3+ pages captured into one in-progress scan, page strip updates
- Done → page count persists; Saved Scans list reflects the new scan with thumbnail, page count, timestamp, size
- Theme picker (System/Light/Dark) re-themes all chrome immediately
- iPhone Safari URL bar no longer overlays the bottom controls (`100dvh` + safe-area insets)

### Issues found during smoke (and fixed in commits on this branch)

The smoke surfaced 11 real bugs and an architectural gap. All were fixed in-tree before tagging:

1. **Server never served the PWA bundle.** Phase 1 and 2 smokes used `vite dev` on `:5173` so this was never noticed. Added `serveStatic` middleware gated on a `PWA_DIST_PATH` config; compose.yml injects `/app/pwa/dist`. Fix in `feat(server): serve PWA static assets when PWA_DIST_PATH is set`.
2. **Docker `npm ci` failed** because jscanify pulls in a transitive `canvas` native dep that needs Python/g++/cairo build tooling not present in the Alpine image. Fix: `npm ci --ignore-scripts` — we only ever use jscanify's browser bundle, never its Node entry. Fix landed in the `fix(compose)` chain.
3. **iPhone Safari URL bar overlaid the capture controls** (`100vh` is wrong on mobile because it includes the now-shrunken-but-conceptually-present browser chrome). Replaced with `100dvh` and `env(safe-area-inset-*)` padding across all four full-screen pages.
4. **LoginScreen had no proper field styling** — narrow inputs, sub-16px font triggered iOS auto-zoom, no breathing room around the warning box. Migrated to a `.field` class layout with full-width 16px inputs, 44px-min touch targets, and a 24px margin under the warning.
5. **`findQuad` passed an `HTMLCanvasElement` to jscanify's `getCornerPoints`**, which expects a `cv.Mat` contour. The corner-finding loop iterated over an `undefined` `data32S` and returned all-undefined corners, so detection silently never fired. Correct call sequence is `cv.imread(canvas) → findPaperContour → getCornerPoints(contour)`.
6. **Vite resolved `import('jscanify')` to the package's Node entry** (`jscanify-node.js` requires `canvas` + `jsdom`), producing garbage in the browser bundle that threw `"undefined is not an object (evaluating 'r.prototype')"`. Vendored `jscanify/src/jscanify.js` into `pwa/public/scanner/` and load via `<script>` tag, same pattern as opencv.js.
7. **OpenCV.js was loaded cross-origin from CDN.** SW's same-origin guard meant the wasm was never cached; spec's "offline after first load" was silently broken. Vendored `opencv.js` (10 MB) into `pwa/public/opencv/`.
8. **`loadOpenCV()` had two race conditions**: no promise cache (concurrent callers would inject duplicate `<script>` tags) and `Module.onRuntimeInitialized` was assigned in `script.onload` (a cached response could initialize wasm before that callback was set, hanging forever). Caught in code review pre-smoke; fixed in `ea58d7a`.
9. **Auto-capture never fired** because jscanify's `getCornerPoints` picks the contour-extreme points farthest from centroid, which jitter dramatically frame-to-frame on noisy 15k-point contours from textured backgrounds. Added EMA smoothing (`α=0.7`) on the quads in `scanner-session` and bumped `STABILITY_DRIFT_PX` from 20 → 60 → 100 (final value found empirically on this iPhone + wood-grain surface).
10. **Manual shutter routed to EditCorners with the default 10 % inset quad** because `currentQuad` was null on the exact frame the user tapped. Now falls back to `lastNonNullQuad` so the user gets the corners they could see highlighted.
11. **Live preview went black after returning from EditCornersScreen** — the new `<video>` element had no `srcObject` even though the camera stream was still alive. Added `rebindVideo()` and a `useEffect` that re-attaches when `pendingEdit` clears.
12. **EditCornersScreen showed only 2 of 4 handles** because the captured 1080×1920 portrait canvas was rendered at `width: 100%` with `height: auto`, making it taller than the viewport. Replaced with object-fit-contain centering; handles are positioned relative to the actual displayed image rect.
13. **Auto-capture re-fired on the same still-visible page** within 1.5 s of a successful capture, before the user could swap pages. Added a 3-second `POST_CAPTURE_COOLDOWN_MS` during which stability is forced to "searching".
14. **`commitPage` errors were silently swallowed.** Now propagated via `onError` so they surface in the diagnostic overlay during development.
15. **jscanify's `findPaperContour` calls `contours.get(-1)`** when zero contours are found, throwing an embind range error every time the camera looked at empty desk between pages. Wrapped in its own try/catch in `findQuad` and treated as no-detection.

### Known limitations (acceptable for Phase 3, candidates for follow-up)

- **jscanify's auto-detected corners are inaccurate on textured backgrounds** (e.g. wood grain). The library picks the points-farthest-from-centroid in each quadrant of the largest contour; with 15k-point contours that include text + barcode + receipt outline + noise, those extremes are biased toward the centroid of the largest blob, not the actual page corners. The `EditCornersScreen` manual-adjust path is the realistic workflow when the auto-detected quad is wrong. A future phase could add proper preprocessing (adaptive threshold, dilate/erode, polygon-approximation) before contour selection.
- **"Fix corners" affordance on a page already in the strip is not implemented.** The spec called out two routes into EditCorners; only the post-shutter route is wired. Adding this requires per-page UI in the strip and a `store.updatePage` call from `applyEdit`.
- **`SavedScansScreen`/`ScanViewerScreen` land in the main bundle** rather than a separate `scanner-saved` chunk per the spec's bundle strategy. Acceptable given their size; differs from the stated architecture.
