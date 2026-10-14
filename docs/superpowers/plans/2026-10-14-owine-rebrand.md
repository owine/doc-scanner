# owine Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the doc-scanner PWA in the owine design system (tokens, Geist type, the page-and-dot mark, per-screen layout) without changing any copy, role or accessible name.

**Architecture:** `pwa/src/theme/theme.css` is replaced by `tokens.css` (owine tokens in three theme blocks) plus `base.css` and one stylesheet per area (`inbox.css`, `auth.css`, `settings.css`, `scanner.css`), all imported by `main.tsx`. Existing class names are kept, so most components are untouched. The review card, inbox header, list rows, sign-in title and the two camera screens get new markup. The only new behaviour is that the inbox reads the auto-file threshold once, for the confidence meter.

**Tech Stack:** Preact 11, Vite, Vitest + happy-dom + @testing-library/preact, plain CSS custom properties, `@fontsource-variable/geist` + `geist-mono` 5.3.0, `sharp` (server workspace) for the one-off icon render.

**Spec:** `docs/superpowers/specs/2026-10-14-owine-rebrand-design.md`. Read it first. It is the source of truth if this plan and the spec disagree.

---

## Where this plan departs from the spec, on purpose

- **More commits.** The spec's seven commits become ten tasks, each with its own commit. "Inbox and review card" splits into the threshold fetch (Task 4), the card (Task 5) and the header, rows and lists (Task 6), and the base-control restyle joins the fonts (Task 2). The order and the every-commit-green rule are unchanged.
- **No `.stack` utility.** `.auth-screen` spaces its children with `gap`, and `.btn-block + .btn-block` spaces stacked buttons, which covers every inline margin the spec meant `.stack` to replace.

## Ground rules for every task

- **Branch:** `feat/owine-rebrand` (it already exists and holds the spec commits).
- **Node:** use the version in `.nvmrc`, and prepend its bin to `PATH` in every shell. `fnm use` alone is not enough: vitest workers end up on the wrong Node.
  ```bash
  export PATH="$HOME/.local/share/fnm/node-versions/v$(cat /Users/owine/Git/doc-scanner/.nvmrc)/installation/bin:$PATH"
  node -v   # must print v24.21.0 (or whatever .nvmrc says)
  ```
- **Never use npm.** Use pnpm only.
- **Commands:**
  - Run all PWA tests: `pnpm --filter @doc-scanner/pwa test`
  - Run one file (from `pwa/`): `pnpm exec vitest run tests/ui/ReviewCard.test.tsx`
  - Typecheck: `pnpm --filter @doc-scanner/pwa run typecheck`
- **Copy stays as it is.** Don't change any visible text, `aria-label`, role or heading text. Uppercase labels come from CSS `text-transform` only.
- **Expected test edits** are only the ones the spec lists (and the tests this plan adds). If any other existing test fails, the code is wrong. Fix the code, never the test.
- **Commits:**
  - Conventional Commits, signed (the default git config signs).
  - Commit with explicit paths: `git commit -m "…" -- <paths>`. Subagents share one git index, so a bare `git commit` can pick up another agent's staged files.
  - If signing flakes with "failed to fill whole buffer", retry. Never disable signing.
- **Preact 11:** `useEffect` cleanups run after paint, so a mounted flag must be maintained in a `useLayoutEffect`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `pwa/src/theme/tokens.css` | create | every owine token; light `:root`, dark media block, dark `[data-theme]` block |
| `pwa/src/theme/base.css` | create (from theme.css) | element defaults and shared controls (`.btn*`, `.card`, `.field`, `.warn`, `.chip`, `.badge`, inputs) |
| `pwa/src/theme/inbox.css` | create (from theme.css) | inbox layout (also used by settings), rows, state dot, review card, meter, picker, chooser, drop overlay |
| `pwa/src/theme/auth.css` | create (from theme.css) | `.auth-screen` and the sign-in lockup |
| `pwa/src/theme/settings.css` | create | segmented theme control, plain fieldset |
| `pwa/src/theme/scanner.css` | create | camera surfaces: scanner and edit corners |
| `pwa/src/theme/theme.css` | delete | replaced by the files above |
| `pwa/src/theme/use-theme.ts` | modify | `theme-color` values |
| `pwa/src/main.tsx` | modify | font and stylesheet imports |
| `pwa/src/ui/Mark.tsx` | create | the page-and-dot mark (inline SVG) |
| `pwa/src/ui/icons.tsx` | create | lucide subset (Settings only) |
| `pwa/src/ui/inbox/StateDot.tsx` | create | the row state dot |
| `pwa/src/ui/inbox/InboxScreen.tsx` | modify | header, drop overlay mark, threshold fetch |
| `pwa/src/ui/inbox/ReviewCard.tsx` | modify | thumbnail column, folder head, meter |
| `pwa/src/ui/inbox/DocumentRows.tsx`, `UploadRows.tsx` | modify | state dots |
| `pwa/src/ui/LoginScreen.tsx`, `ResumePrompt.tsx`, `App.tsx` | modify | lockup, inline styles out |
| `pwa/src/ui/SettingsScreen.tsx`, `PasskeysSection.tsx` | modify | segmented control, fieldset, danger Remove |
| `pwa/src/ui/ScannerScreen.tsx`, `EditCornersScreen.tsx` | modify | camera classes, shutter, handles |
| `server/scripts/render-pwa-icons.mjs` | create | renders the PWA icons from SVG with sharp |
| `pwa/public/icons/*` | create/replace | favicon.svg, icon-192/512, icon-maskable-512, apple-touch-icon |
| `pwa/public/manifest.webmanifest`, `pwa/index.html` | modify | colours, icons, links |
| `pwa/tests/theme/tokens.test.ts` | create | token parity |
| `CLAUDE.md` | modify | one line about the theme files |

---

### Task 1: Token file and stylesheet split (owine colours on today's layout)

**Files:**
- Create: `pwa/src/theme/tokens.css`, `pwa/src/theme/base.css`, `pwa/src/theme/inbox.css`, `pwa/src/theme/auth.css`, `pwa/tests/theme/tokens.test.ts`
- Delete: `pwa/src/theme/theme.css`
- Modify: `pwa/src/main.tsx:2`, `pwa/src/theme/use-theme.ts:24`, `pwa/src/ui/EditCornersScreen.tsx:85,86,110`, `pwa/tests/theme/use-theme.test.ts:54,56`

- [ ] **Step 1: Write the failing token-parity test**

Create `pwa/tests/theme/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Not import.meta.url: under happy-dom it isn't a file: URL. InboxScreen.test.tsx uses __dirname too.
const css = readFileSync(resolve(__dirname, '../../src/theme/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first block matching `re` (group 1 is the body), as name → value. */
function declarations(re: RegExp): Map<string, string> {
  const body = css.match(re)?.[1];
  if (body === undefined) throw new Error(`no block matches ${re}`);
  const out = new Map<string, string>();
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}

const light = declarations(/(?:^|\n)\s*:root\s*\{([^}]*)\}/);
const systemDark = declarations(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/);
const chosenDark = declarations(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);

describe('tokens.css', () => {
  it('defines the owine light palette on bare :root', () => {
    expect(light.get('--paper')).toBe('#f6f4ef');
    expect(light.get('--ink')).toBe('#0e1620');
    expect(light.get('--accent')).toBe('#2b5fd9');
    expect(light.get('color-scheme')).toBe('light');
  });

  it('keeps the system-dark and chosen-dark blocks identical', () => {
    expect([...systemDark.entries()].sort()).toEqual([...chosenDark.entries()].sort());
    expect(systemDark.get('color-scheme')).toBe('dark');
  });

  it('only overrides tokens that bare :root declares', () => {
    for (const name of systemDark.keys()) expect(light.has(name), name).toBe(true);
  });

  it('uses a dark control border that clears 3:1', () => {
    expect(systemDark.get('--line-strong')).toBe('#626e80');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run (from `pwa/`): `pnpm exec vitest run tests/theme/tokens.test.ts`
Expected: FAIL with `ENOENT … tokens.css`.

- [ ] **Step 3: Create `pwa/src/theme/tokens.css`**

Keep comments free of `{` and `}`, because the parity test splits blocks on braces.

```css
/* owine design tokens, the PWA's copy of the owine design system.
   Bare :root is the light palette. The dark overrides appear twice, once for
   the system setting and once for an explicit choice in Settings, and
   tests/theme/tokens.test.ts keeps the two identical. Never put a brace in a
   comment here: the test finds blocks by brace. */
:root {
  /* surfaces and lines */
  --paper: #f6f4ef;
  --paper-2: #efece4;
  --paper-3: #e6e2d8;
  --card: #fbfaf6;
  --line: #dcd6cc;
  --line-strong: #948b78;

  /* text */
  --ink: #0e1620;
  --ink-2: #2c3a4d;
  --ink-3: #5b6878;
  --ink-4: #5b6673;

  /* accent */
  --accent: #2b5fd9;
  --accent-hover: #234fb8;
  --accent-press: #1c4096;
  --accent-soft: #e4ecfb;
  --accent-ink: #14306e;
  --on-accent: #fff;

  /* semantic */
  --success: #2e7659;
  --success-soft: #e1eee7;
  --warning: #905d14;
  --warning-soft: #f3e7cf;
  --danger: #b4382b;
  --danger-soft: #f3dcd8;

  /* camera surfaces: the same in both themes, so not overridden below */
  --ink-bg: #11161d;
  --ink-bg-2: #1a212b;
  --ink-line: #2a3340;
  --ink-fg: #e8ebf0;
  --ink-fg-2: #a5adb8;
  --ink-success: #5fb88f;
  --ink-warning: #d9a14e;
  --ink-danger: #e07262;

  /* type */
  --font-sans: 'Geist Variable', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: 'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace;
  --fs-12: 0.75rem;
  --fs-13: 0.8125rem;
  --fs-14: 0.875rem;
  --fs-15: 0.9375rem;
  --fs-16: 1rem;
  --fs-20: 1.25rem;

  /* spacing, 4 px grid */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-6: 24px;
  --sp-10: 40px;

  /* radii */
  --r-1: 4px;
  --r-2: 6px;
  --r-3: 10px;
  --r-4: 16px;

  /* elevation and focus */
  --shadow-1: 0 1px 0 rgb(14 22 32 / 0.04), 0 1px 2px rgb(14 22 32 / 0.04);
  --shadow-2: 0 1px 0 rgb(14 22 32 / 0.04), 0 4px 12px rgb(14 22 32 / 0.06);
  --shadow-3: 0 2px 0 rgb(14 22 32 / 0.04), 0 12px 32px rgb(14 22 32 / 0.1);
  --ring: 0 0 0 3px rgb(43 95 217 / 0.25);

  /* motion */
  --ease-out: cubic-bezier(0.2, 0.7, 0.2, 1);
  --dur-fast: 120ms;
  --dur-base: 200ms;

  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #14181f;
    --paper-2: #1a1f27;
    --paper-3: #232934;
    --card: #1b212a;
    --line: #2a323f;
    --line-strong: #626e80;
    --ink: #f1eee8;
    --ink-2: #c4c8d0;
    --ink-3: #8a929d;
    --ink-4: #8391a1;
    --accent: #6b8eeb;
    --accent-hover: #88a4ef;
    --accent-press: #5a82e8;
    --accent-soft: #1d2c4d;
    --accent-ink: #b8c9f4;
    --on-accent: #14181f;
    --success: #5fb88f;
    --success-soft: #18302a;
    --warning: #d9a14e;
    --warning-soft: #382812;
    --danger: #e07262;
    --danger-soft: #3a1d18;
    --shadow-1: 0 1px 0 rgb(0 0 0 / 0.2), 0 1px 2px rgb(0 0 0 / 0.2);
    --shadow-2: 0 1px 0 rgb(0 0 0 / 0.2), 0 4px 12px rgb(0 0 0 / 0.3);
    --shadow-3: 0 2px 0 rgb(0 0 0 / 0.2), 0 12px 32px rgb(0 0 0 / 0.45);
    --ring: 0 0 0 3px rgb(90 130 232 / 0.35);
    color-scheme: dark;
  }
}

/* Must match the block above exactly. */
:root[data-theme="dark"] {
  --paper: #14181f;
  --paper-2: #1a1f27;
  --paper-3: #232934;
  --card: #1b212a;
  --line: #2a323f;
  --line-strong: #626e80;
  --ink: #f1eee8;
  --ink-2: #c4c8d0;
  --ink-3: #8a929d;
  --ink-4: #8391a1;
  --accent: #6b8eeb;
  --accent-hover: #88a4ef;
  --accent-press: #5a82e8;
  --accent-soft: #1d2c4d;
  --accent-ink: #b8c9f4;
  --on-accent: #14181f;
  --success: #5fb88f;
  --success-soft: #18302a;
  --warning: #d9a14e;
  --warning-soft: #382812;
  --danger: #e07262;
  --danger-soft: #3a1d18;
  --shadow-1: 0 1px 0 rgb(0 0 0 / 0.2), 0 1px 2px rgb(0 0 0 / 0.2);
  --shadow-2: 0 1px 0 rgb(0 0 0 / 0.2), 0 4px 12px rgb(0 0 0 / 0.3);
  --shadow-3: 0 2px 0 rgb(0 0 0 / 0.2), 0 12px 32px rgb(0 0 0 / 0.45);
  --ring: 0 0 0 3px rgb(90 130 232 / 0.35);
  color-scheme: dark;
}
```

- [ ] **Step 4: Run the parity test**

Run: `pnpm exec vitest run tests/theme/tokens.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Split the rest of `theme.css` into three files, renaming the old tokens**

The old token blocks (lines 1–61 of `theme.css`, the three `:root` blocks) are replaced by `tokens.css`. Move every remaining rule **unchanged except for the token renames**, as follows.

`pwa/src/theme/base.css`:

```css
/* Element defaults and the controls every screen shares. Tokens: tokens.css. */
html, body { background: var(--paper); color: var(--ink); margin: 0; }
body { font-family: -apple-system, system-ui, sans-serif; }

.btn {
  background: var(--accent); color: var(--on-accent);
  border: none; padding: 12px 16px; border-radius: 6px;
  font-size: 16px; font-weight: 500; cursor: pointer;
  min-height: 44px;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-block { display: block; width: 100%; }

.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.warn { background: var(--warning-soft); border: 1px solid var(--warning); padding: 12px; border-radius: 6px; margin-bottom: 24px; }
.muted { color: var(--ink-3); font-size: 13px; }

input, select {
  background: var(--paper); color: var(--ink);
  border: 1px solid var(--line); border-radius: 6px;
  padding: 10px 12px; font-size: 16px;
  width: 100%; box-sizing: border-box;
}

.field { display: block; margin-bottom: 16px; }
.field-label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }

.error-text { color: var(--danger); }

.btn-small { padding: 6px 10px; min-height: 44px; font-size: 14px; }
.btn-square { min-width: 44px; }
input[type="checkbox"] { width: auto; }

.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.badge { background: var(--warning-soft); border: 1px solid var(--warning); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
.chip-auto { border-color: var(--accent); color: var(--accent); }
a.btn { text-decoration: none; display: inline-flex; align-items: center; box-sizing: border-box; }

.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
```

`pwa/src/theme/auth.css`:

```css
/* Sign-in and the full-page states. */
.auth-screen {
  max-width: 480px; margin: 0 auto;
  padding: 24px 16px;
  padding-top: max(24px, env(safe-area-inset-top));
  padding-bottom: max(24px, env(safe-area-inset-bottom));
}
@media (min-width: 600px) {
  .auth-screen { padding-top: 40px; padding-bottom: 40px; }
}
```

`pwa/src/theme/inbox.css`:

```css
/* The inbox, and the settings screen, which shares its layout. */
.folder-picker { display: flex; flex-direction: column; gap: 8px; }
.folder-results {
  list-style: none; padding: 0; margin: 0;
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--line); border-radius: 6px;
}
.folder-results li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; border-bottom: 1px solid var(--line); }
.folder-results li:last-child { border-bottom: none; }
.folder-result {
  all: unset; flex: 1; padding: 10px 12px; cursor: pointer; overflow-wrap: anywhere;
  min-height: 44px; box-sizing: border-box; display: flex; align-items: center;
}
.folder-result:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.folder-result:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.new-folder { display: flex; gap: 8px; width: 100%; padding: 8px 12px; box-sizing: border-box; }
.doc-chooser { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.doc-chooser h3 { margin: 4px 0 0; font-size: 14px; }
.chooser-option {
  flex: 1; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  min-height: 44px; box-sizing: border-box; overflow-wrap: anywhere; cursor: pointer;
}

.review-card { margin-bottom: 12px; }
.review-card .rationale { margin: 8px 0; line-height: 1.4; }
.review-thumb { float: right; width: 96px; margin: 0 0 8px 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); }
@media (min-width: 600px) { .review-thumb { width: 140px; } }
.review-card::after { content: ''; display: block; clear: both; }
.folder-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; overflow-wrap: anywhere; }

.inbox {
  position: relative;
  max-width: 720px; margin: 0 auto; padding: 16px;
  padding-top: max(16px, env(safe-area-inset-top));
  padding-bottom: max(24px, env(safe-area-inset-bottom));
}
.inbox-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.inbox-header h1 { margin: 0; font-size: 22px; }
.inbox h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-3); margin: 24px 0 8px; }
.inbox .warn { margin: 12px 0 0; }
.doc-list { list-style: none; padding: 0; margin: 0; }
.doc-row { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.doc-main { flex: 1; min-width: 12rem; }
.doc-name { font-weight: 600; overflow-wrap: anywhere; }

.drop-overlay {
  position: fixed; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border: 3px dashed var(--accent);
  font-size: 20px; font-weight: 600; pointer-events: none;
}
.doc-main progress { width: 100%; height: 6px; margin-top: 4px; accent-color: var(--accent); }
.nudge { margin-top: 12px; }
.nudge p { margin: 0 0 8px; }
```

(The two `.inbox` rules from `theme.css` are merged into one. That doesn't change anything.)

Then delete the old file: `git rm pwa/src/theme/theme.css`

- [ ] **Step 6: Point `main.tsx` at the new files**

In `pwa/src/main.tsx`, replace `import './theme/theme.css';` (line 2) with:

```ts
import './theme/tokens.css';
import './theme/base.css';
import './theme/auth.css';
import './theme/inbox.css';
```

- [ ] **Step 7: Rename the three inline old tokens in `EditCornersScreen.tsx`**

- Line 85: `background: 'var(--bg)'` becomes `background: 'var(--paper)'`.
- Line 86: `background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)'` becomes `background: 'var(--card)', borderBottom: '1px solid var(--line)'`.
- Line 110: `background: 'var(--bg-elev)', borderTop: '1px solid var(--border)'` becomes `background: 'var(--card)', borderTop: '1px solid var(--line)'`.

(Task 7 replaces these inline styles entirely.)

- [ ] **Step 8: Update the `theme-color` test first, then the code**

In `pwa/tests/theme/use-theme.test.ts`, line 54 changes `'#0f0f0f'` to `'#14181f'`, and line 56 changes `'#ffffff'` to `'#f6f4ef'`.

Run: `pnpm exec vitest run tests/theme/use-theme.test.ts`
Expected: FAIL on "updates meta theme-color content on change" (expected `#14181f`, got `#0f0f0f`).

In `pwa/src/theme/use-theme.ts` line 24:

```ts
  if (meta) meta.content = effective(pref) === 'dark' ? '#14181f' : '#f6f4ef';
```

Run: `pnpm exec vitest run tests/theme/use-theme.test.ts`
Expected: PASS.

- [ ] **Step 9: Prove no old token name is left**

Run (from repo root):
```bash
grep -rnE -- '--(bg|bg-elev|fg|fg-muted|border|accent-fg|warn-bg|warn-border)\b' pwa/src || echo "clean"
```
Expected: `clean`. (`\b` would still match `--border-radius`, but no such custom property exists in `pwa/src`.) Any hit is a missed rename.

- [ ] **Step 10: Full suite and typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`
Expected: all tests pass and typecheck exits 0.

- [ ] **Step 11: Commit**

```bash
git add pwa/src/theme pwa/tests/theme/tokens.test.ts
git commit -m "refactor(pwa): split theme.css and adopt owine tokens" -- pwa/src/theme pwa/src/main.tsx pwa/src/ui/EditCornersScreen.tsx pwa/tests/theme
```

---

### Task 2: Fonts and the shared controls

**Files:**
- Modify: `pwa/package.json` (via pnpm), `pnpm-lock.yaml`, `pwa/src/main.tsx`, `pwa/src/theme/base.css` (full rewrite)

- [ ] **Step 1: Add the fonts**

Run from the repo root:
```bash
pnpm --filter @doc-scanner/pwa add @fontsource-variable/geist@5.3.0 @fontsource-variable/geist-mono@5.3.0
```
Expected: `pwa/package.json` `dependencies` gains both at exactly `"5.3.0"`. The workspace pins exact versions. If a range (`^5.3.0`) appears, edit it to `5.3.0` and run `pnpm install`.

Confirm the family names the CSS will use:
```bash
grep -ho "font-family: '[^']*'" pwa/node_modules/@fontsource-variable/geist/index.css pwa/node_modules/@fontsource-variable/geist-mono/index.css | sort -u
```
Expected: `font-family: 'Geist Variable'` and `font-family: 'Geist Mono Variable'`. If the names differ, use the printed names in `tokens.css`'s `--font-sans` and `--font-mono`.

- [ ] **Step 2: Import the fonts first in `main.tsx`**

Above the four theme imports:

```ts
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
```

- [ ] **Step 3: Rewrite `pwa/src/theme/base.css`**

This replaces the whole file. Every selector from Task 1 is still here, plus `.btn-icon`, `.btn-link`, `.field-head` and `.mark`.

```css
/* Element defaults and the controls every screen shares. Tokens: tokens.css. */
html, body { background: var(--paper); color: var(--ink); margin: 0; }
body {
  font-family: var(--font-sans);
  font-size: var(--fs-16);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
h1, h2, h3 { font-weight: 500; letter-spacing: -0.02em; line-height: 1.2; }
p { text-wrap: pretty; }

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
  box-sizing: border-box; min-height: 44px; padding: 0 var(--sp-4);
  font: 500 var(--fs-15)/1.2 var(--font-sans);
  background: var(--accent); color: var(--on-accent);
  border: 1px solid transparent; border-radius: var(--r-2);
  cursor: pointer; text-decoration: none;
}
@media (prefers-reduced-motion: no-preference) {
  .btn { transition: background-color var(--dur-fast) var(--ease-out); }
}
.btn:hover { background: var(--accent-hover); }
.btn:active { background: var(--accent-press); transform: translateY(0.5px); }
.btn-secondary { background: transparent; color: var(--ink); border-color: var(--line-strong); }
.btn-secondary:hover, .btn-secondary:active { background: var(--paper-2); }
.btn-danger { background: var(--danger); color: var(--on-accent); }
.btn-danger:hover, .btn-danger:active { background: color-mix(in oklab, var(--danger) 88%, var(--ink)); }
.btn:disabled, .btn:disabled:hover, .btn[aria-disabled="true"] {
  background: var(--paper-2); color: var(--ink-4); border-color: var(--line);
  cursor: not-allowed; transform: none;
}
.btn-small { padding: 0 var(--sp-3); font-size: var(--fs-14); }
.btn-square { min-width: 44px; padding: 0; }
.btn-icon { width: 44px; padding: 0; }
.btn-block { display: flex; width: 100%; }
.btn-block + .btn-block { margin-top: var(--sp-2); }
.btn-link {
  min-height: 44px; padding: 0 var(--sp-1);
  background: none; border: 0; border-radius: var(--r-1);
  color: var(--accent); font: 500 var(--fs-14)/1 var(--font-sans); cursor: pointer;
}
.btn-link:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 0.18em; }
.btn-link:disabled { color: var(--ink-4); cursor: not-allowed; text-decoration: none; }

/* Surfaces and messages */
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r-3);
  box-shadow: var(--shadow-1); padding: var(--sp-4);
}
.card > :first-child { margin-top: 0; }
.warn {
  background: var(--warning-soft); color: var(--ink);
  border: 1px solid color-mix(in oklab, var(--warning) 35%, transparent);
  border-radius: var(--r-2); padding: var(--sp-3); margin: 0 0 var(--sp-6);
}
.warn > strong:first-child { color: var(--warning); }
.muted { color: var(--ink-3); font-size: var(--fs-13); }
.error-text { color: var(--danger); }
.badge {
  display: inline-block; padding: 3px 6px; border-radius: var(--r-1);
  background: var(--accent-soft); color: var(--accent-ink);
  font: 500 var(--fs-12)/1 var(--font-mono); letter-spacing: 0.04em; white-space: nowrap;
}
.chip {
  padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--r-1);
  color: var(--ink-3); font: 500 var(--fs-12)/1 var(--font-mono); white-space: nowrap;
}
.chip-auto { background: var(--accent-soft); color: var(--accent-ink); border-color: transparent; }

/* Forms */
input, select {
  box-sizing: border-box; width: 100%;
  background: var(--paper); color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: var(--r-2);
  padding: 10px 12px; font: 400 var(--fs-16)/1.3 var(--font-sans);
}
input::placeholder { color: var(--ink-4); }
input:disabled, select:disabled { background: var(--paper-2); color: var(--ink-4); }
input[aria-invalid="true"] { border-color: var(--danger); }
input[type="checkbox"] { width: auto; accent-color: var(--accent); }
.field { display: block; margin-bottom: var(--sp-4); }
.field-label { display: block; font-size: var(--fs-13); font-weight: 500; color: var(--ink-2); margin-bottom: 6px; }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.field-head .field-label { margin-bottom: 0; }

/* Layout helpers */
.actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.mark { flex: none; color: var(--ink); }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
```

- [ ] **Step 4: Full suite, typecheck, build**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck && pnpm build`
Expected: everything passes. The build output lists `geist-*.woff2` assets under `pwa/dist/assets/`.

The packages ship `types: ./index.d.css.ts`, so the imports should typecheck. If typecheck reports TS2882 (TypeScript 7 checks side-effect imports by default), add `declare module '@fontsource-variable/*';` to `pwa/src/vite-env.d.ts` and re-run.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pwa): Geist fonts and owine base controls" -- pwa/package.json pnpm-lock.yaml pwa/src/main.tsx pwa/src/theme/base.css pwa/src/vite-env.d.ts
```

(Leave `vite-env.d.ts` off the path list if Step 4 didn't need it.)

---

### Task 3: The mark, app icons, manifest and `index.html`

**Files:**
- Create: `pwa/src/ui/Mark.tsx`, `pwa/tests/ui/Mark.test.tsx`, `server/scripts/render-pwa-icons.mjs`, `pwa/public/icons/favicon.svg`, `pwa/public/icons/icon-maskable-512.png`, `pwa/public/icons/apple-touch-icon.png`
- Replace: `pwa/public/icons/icon-192.png`, `pwa/public/icons/icon-512.png`
- Modify: `pwa/public/manifest.webmanifest`, `pwa/index.html`

- [ ] **Step 1: Write the failing Mark test**

`pwa/tests/ui/Mark.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { Mark } from '../../src/ui/Mark.js';

describe('Mark', () => {
  it('is decorative and sized by its prop', () => {
    const { container } = render(<Mark size={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveClass('mark');
  });
});
```

Run: `pnpm exec vitest run tests/ui/Mark.test.tsx`
Expected: FAIL (cannot resolve `../../src/ui/Mark.js`).

- [ ] **Step 2: Create `pwa/src/ui/Mark.tsx`**

```tsx
/** The doc-scanner mark: a page with a folded corner, and the owine offset dot. Decorative. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M8 4h10.5l5 5v19H8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M18.5 4v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <circle cx="26" cy="26" r="2.6" fill="var(--accent)" />
    </svg>
  );
}
```

Run: `pnpm exec vitest run tests/ui/Mark.test.tsx`
Expected: PASS.

- [ ] **Step 3: Create `server/scripts/render-pwa-icons.mjs`**

```js
// Renders the PWA's icons from the page-and-dot mark. Run by hand after
// changing the mark; the outputs are committed, so builds never run this.
// Lives in server/ because sharp is a server dependency, and Node resolves it
// from the script's own location.
//   cd server && node scripts/render-pwa-icons.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const INK = '#0e1620';
const PAPER = '#f6f4ef';
const ACCENT = '#2b5fd9';
const out = (name) => fileURLToPath(new URL(`../../pwa/public/icons/${name}`, import.meta.url));

/** The mark on a 32-unit grid. */
const mark = (stroke, dot) =>
  `<path d="M10 6.5h8.5l4 4V25.5H10z" fill="none" stroke="${PAPER}" stroke-width="${stroke}" stroke-linejoin="round"/>` +
  `<path d="M18.5 6.5v4h4" fill="none" stroke="${PAPER}" stroke-width="${stroke}" stroke-linejoin="round"/>` +
  `<circle cx="24.5" cy="24" r="${dot}" fill="${ACCENT}"/>`;

const svg = (body, rx = 0) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${rx}" fill="${INK}"/>${body}</svg>`;

// Full bleed: the OS applies its own mask to "any" icons.
const fullBleed = svg(mark(1.6, 2));
// Maskable: the art scaled into the central 80% safe zone.
const maskable = svg(`<g transform="translate(16 16) scale(0.8) translate(-16 -16)">${mark(1.6, 2)}</g>`);
// Favicon: owine's rounded square, a heavier stroke for 16 px.
const favicon = svg(mark(2, 2.2), 6);

async function png(source, size, name) {
  await sharp(Buffer.from(source), { density: (72 * size) / 32 }).resize(size, size).png().toFile(out(name));
}

await writeFile(out('favicon.svg'), `${favicon}\n`);
await png(fullBleed, 192, 'icon-192.png');
await png(fullBleed, 512, 'icon-512.png');
await png(maskable, 512, 'icon-maskable-512.png');
await png(fullBleed, 180, 'apple-touch-icon.png');
console.log('wrote favicon.svg, icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png');
```

- [ ] **Step 4: Render the icons**

Run: `cd server && node scripts/render-pwa-icons.mjs && cd ..`
Expected: the "wrote …" line. `ls pwa/public/icons` shows the five files.

Look at each PNG with the Read tool (it renders images). Check the page outline, the fold and the blue dot are crisp, and that the maskable one has visibly more margin.

- [ ] **Step 5: Manifest**

Replace `pwa/public/manifest.webmanifest` with:

```json
{
  "name": "doc-scanner",
  "short_name": "doc-scanner",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f6f4ef",
  "theme_color": "#f6f4ef",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 6: `index.html`**

Change `<meta name="theme-color" content="#ffffff">` to `content="#f6f4ef"`. Under it, add:

```html
  <link rel="icon" href="/icons/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

- [ ] **Step 7: Suite, typecheck, build**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add pwa/src/ui/Mark.tsx pwa/tests/ui/Mark.test.tsx server/scripts/render-pwa-icons.mjs pwa/public/icons
git commit -m "feat(pwa): page-and-dot mark, app icons and manifest colours" -- pwa/src/ui/Mark.tsx pwa/tests/ui/Mark.test.tsx server/scripts/render-pwa-icons.mjs pwa/public/icons pwa/public/manifest.webmanifest pwa/index.html
```

---

### Task 4: The inbox reads the auto-file threshold

**Files:**
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`, `pwa/src/ui/inbox/ReviewCard.tsx` (prop only), `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Give every `documents` mock a `settings`**

In `pwa/tests/ui/InboxScreen.test.tsx`, add a shared constant after `const NOW = …` (around line 72):

```ts
const SETTINGS = { model: 'claude-haiku-5-5', effort: 'medium' as const, autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] };
```

In `setup()`'s `api` object, after `retry: …`, add:

```ts
    settings: vi.fn().mockResolvedValue(SETTINGS),
```

In the three tests that build their own `api` ("drops a discarded row once retention passes…", "says the server is unreachable…", "keeps the documents and warns…", about lines 244, 266 and 287), change

```ts
const api = { folders: vi.fn().mockResolvedValue({ walkedAt: NOW.toISOString(), folders: FOLDERS }), refreshFolders: vi.fn() } as unknown as DocumentsApi;
```

to

```ts
const api = { folders: vi.fn().mockResolvedValue({ walkedAt: NOW.toISOString(), folders: FOLDERS }), refreshFolders: vi.fn(), settings: vi.fn().mockResolvedValue(SETTINGS) } as unknown as DocumentsApi;
```

Make sure no other bare mock remains:

```bash
grep -n "as unknown as DocumentsApi" pwa/tests/ui/InboxScreen.test.tsx
```

Every hit must be `setup()`'s object or one of the three above. Add `settings` to any other hit too.

- [ ] **Step 2: Write the failing tests**

Add inside `describe('InboxScreen', …)`:

```tsx
  it('names the auto-file threshold on review cards once settings load', async () => {
    const { api } = setup([makeDoc()]);
    await waitFor(() => expect(screen.getByText(/60% confident/)).toHaveTextContent(/auto-file threshold 80%/));
    expect(api.settings).toHaveBeenCalledTimes(1);
  });

  it('shows review cards without the threshold when settings fail to load', async () => {
    const { api } = setup([makeDoc()], { settings: vi.fn().mockRejectedValue(new Error('offline')) });
    await waitFor(() => expect(api.settings).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByText(/60% confident/)).not.toHaveTextContent(/auto-file threshold/);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
```

Run: `pnpm exec vitest run tests/ui/InboxScreen.test.tsx`
Expected: both new tests FAIL. The first finds no threshold text. In the second, the `waitFor` on `api.settings` times out because nothing calls it yet. All existing tests pass.

- [ ] **Step 3: Add the prop to `ReviewCard`**

In `ReviewCardProps` (`ReviewCard.tsx`, after `onReanalyze`):

```ts
  /** The auto-file threshold (0.5–1), once settings have loaded; the meter marks it. */
  threshold?: number | null;
```

Add `threshold = null` to the destructured props of `ReviewCard`. Then replace the existing confidence paragraph

```tsx
      {suggested && (
        <p class="muted">
          {Math.round(suggested.confidence * 100)}% confident{doc.reviewReason ? ` · ${doc.reviewReason}` : ''}
        </p>
      )}
```

with this interim version (Task 5 adds the meter around it):

```tsx
      {suggested && (
        <p class="muted confidence-line">
          {Math.round(suggested.confidence * 100)}% confident{doc.reviewReason ? ` · ${doc.reviewReason}` : ''}
          {threshold !== null && <span class="visually-hidden"> (auto-file threshold {Math.round(threshold * 100)}%)</span>}
        </p>
      )}
```

- [ ] **Step 4: Fetch the threshold in `InboxScreen`**

After the `headingRef` layout effect (around line 92), add:

```tsx
  // The auto-file threshold, for the review cards' meters. Best effort: without it they show no tick.
  const [threshold, setThreshold] = useState<number | null>(null);
  const mounted = useRef(true);
  // A layout effect: Preact 11 runs useEffect cleanups after paint.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const settings = await documents.settings();
        if (mounted.current) setThreshold(settings.autoFileThreshold);
      } catch {
        // Offline, or signed out: the meters show without the threshold.
      }
    })();
  }, [documents]);
```

In the `<ReviewCard …>` element inside the review section, add `threshold={threshold}`.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/ui/InboxScreen.test.tsx tests/ui/ReviewCard.test.tsx tests/ui/App.test.tsx tests/ui/App-scan-flow.test.tsx tests/ui/App-pdf-preload.test.tsx`
Expected: all PASS. The App tests need no edits, because their fetch stubs answer `/api/settings` with 404 or 503 and the catch swallows it.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(pwa): inbox reads the auto-file threshold for review cards" -- pwa/src/ui/inbox/InboxScreen.tsx pwa/src/ui/inbox/ReviewCard.tsx pwa/tests/ui/InboxScreen.test.tsx
```

---

### Task 5: Review card layout and the confidence meter

**Files:**
- Modify: `pwa/src/ui/inbox/ReviewCard.tsx`, `pwa/tests/ui/ReviewCard.test.tsx`, `pwa/src/theme/inbox.css`

- [ ] **Step 1: Let `renderCard` take props and return the container**

In `pwa/tests/ui/ReviewCard.test.tsx`, replace `renderCard` with:

```tsx
function renderCard(doc = makeDoc(), handlers: Partial<{ onApprove: any; onDiscard: any }> = {}, extra: { threshold?: number | null } = {}) {
  const onApprove = handlers.onApprove ?? vi.fn(async () => {});
  const onDiscard = handlers.onDiscard ?? vi.fn(async () => {});
  const { container } = render(<ReviewCard doc={doc} folders={folders} onApprove={onApprove} onDiscard={onDiscard} {...extra} />);
  return { onApprove, onDiscard, container };
}
```

- [ ] **Step 2: Change the thumbnail-failure test (an expected edit from the spec)**

Replace the body of `it('hides a thumbnail that fails to load', …)` with:

```tsx
    const { container } = renderCard(makeDoc({ hasThumbnail: true }));
    const img = screen.getByRole('img', { name: 'First page preview' });
    fireEvent.error(img);
    expect(screen.queryByRole('img', { name: 'First page preview' })).toBeNull();
    expect(container.querySelector('.review-thumb')).toBeNull();
```

- [ ] **Step 3: Add the meter tests**

```tsx
  it('marks the auto-file threshold on the meter when it is known', () => {
    const { container } = renderCard(makeDoc(), {}, { threshold: 0.8 });
    expect(screen.getByText(/60% confident/)).toHaveTextContent(/auto-file threshold 80%/);
    const meter = container.querySelector('.meter')!;
    expect(meter).toHaveAttribute('aria-hidden', 'true');
    expect(meter).toHaveClass('meter--low');
    expect(meter.querySelector('.meter-tick')).not.toBeNull();
  });

  it('shows the meter without a tick when the threshold is unknown', () => {
    const { container } = renderCard();
    expect(screen.getByText(/60% confident/)).not.toHaveTextContent(/auto-file threshold/);
    expect(container.querySelector('.meter')).toHaveClass('meter--unknown');
    expect(container.querySelector('.meter-tick')).toBeNull();
  });

  it('shows a confidence at or above the threshold as confident', () => {
    const { container } = renderCard(makeDoc(), {}, { threshold: 0.6 });
    expect(container.querySelector('.meter')).toHaveClass('meter--ok');
  });

  it('keeps Change next to the folder and hands focus back to it', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toHaveFocus());
  });
```

The last one guards the moved Change button. If an equivalent test already exists in the file (search for `toHaveFocus`), don't add a duplicate.

Run: `pnpm exec vitest run tests/ui/ReviewCard.test.tsx`
Expected: the thumbnail test and the three meter tests FAIL. The Change test passes or fails depending on the current markup. Everything else passes.

- [ ] **Step 4: Rewrite the card body in `ReviewCard.tsx`**

Add state next to the others:

```tsx
  const [thumbFailed, setThumbFailed] = useState(false);
```

Replace everything from `return (` through the closing `</article>` (keep the `actions` constant above it as it is) with:

```tsx
  const percent = suggested ? Math.round(suggested.confidence * 100) : 0;
  const tone = threshold === null || !suggested ? 'unknown' : suggested.confidence >= threshold ? 'ok' : 'low';
  const meterStyle = {
    '--value': `${percent}%`,
    ...(threshold !== null && { '--threshold': `${Math.round(threshold * 100)}%` }),
  };

  return (
    <article class="card review-card" aria-label={`Review ${suggested?.name ?? doc.originalName ?? 'document'}`}>
      <div class="review-top">
        {/* Gone if it won't load (a signed-out session, a document filed meanwhile), so no empty box is left. */}
        {doc.hasThumbnail && !thumbFailed && (
          <img
            class="review-thumb"
            src={`/api/documents/${encodeURIComponent(doc.id)}/thumbnail`}
            alt="First page preview"
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        )}
        <div class="review-head">
          <p class="muted review-meta">
            {doc.originalName ?? 'Untitled'} · {SOURCE_LABEL[doc.source]}
          </p>
          <label class="field">
            <span class="field-label">Name</span>
            <input
              ref={noAutocorrect}
              value={name}
              autocapitalize="off"
              spellcheck={false}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
        </div>
      </div>
      <div class="field" role="group" aria-labelledby={`folder-label-${doc.id}`}>
        <div class="field-head">
          <span class="field-label" id={`folder-label-${doc.id}`}>
            Folder
          </span>
          {!picking && (
            <button ref={changeRef} class="btn-link" disabled={busy} onClick={() => setPicking(true)}>
              Change
            </button>
          )}
        </div>
        {picking ? (
          <FolderPicker
            folders={folders}
            allowNew
            onChoose={(f) => {
              setFolder(f);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <div class="folder-row">
            {folder ? <span class="path">{folderLabel(folder)}</span> : <em class="muted">No folder suggested</em>}
            {folder?.kind === 'new' && <span class="badge">New folder</span>}
          </div>
        )}
      </div>
      {suggested && (
        <div class="confidence">
          <p class="muted confidence-line">
            {percent}% confident{doc.reviewReason ? ` · ${doc.reviewReason}` : ''}
            {threshold !== null && <span class="visually-hidden"> (auto-file threshold {Math.round(threshold * 100)}%)</span>}
          </p>
          <div class={`meter meter--${tone}`} aria-hidden="true" style={meterStyle}>
            <span class="meter-fill" />
            {threshold !== null && <span class="meter-tick" />}
          </div>
        </div>
      )}
      {suggested?.rationale && <p class="rationale">{suggested.rationale}</p>}
      {doc.anchorName && <p class="muted">Paired with “{doc.anchorName}”</p>}
      {doc.prepareNote && <p class="muted">{doc.prepareNote}</p>}
      {suggested?.contentSeen === false && <p class="muted">Analysed from the file's details only; its contents could not be read.</p>}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      {onReanalyze && onCombine ? (
        <MoreActions
          doc={doc}
          review={review}
          filed={filed}
          busy={busy}
          run={run}
          onCombine={onCombine}
          onReanalyze={onReanalyze}
          onReanalyzeError={(err) =>
            setError((err instanceof ApiError && err.code && ACTION_ERRORS[err.code]) || 'Could not re-analyse. Try again.')
          }
        >
          {actions}
        </MoreActions>
      ) : (
        <div class="actions">{actions}</div>
      )}
    </article>
  );
```

Notes:
- `{percent}% confident{…}` must keep the percentage as **direct text** of the `<p>`, with no wrapper span. `getByText` matches an element's own text nodes only.
- The focus-return effect still works: `changeRef` is re-attached when `picking` becomes false, and the effect runs after that render.
- If `noAutocorrect` isn't the name of the ref callback in this file, keep whatever the original `<input>` used. Copy its attributes exactly.

- [ ] **Step 5: Run the card tests**

Run: `pnpm exec vitest run tests/ui/ReviewCard.test.tsx tests/ui/InboxScreen.test.tsx`
Expected: all PASS, including `ReviewCard.test.tsx:24` (the confidence regex) unedited.

- [ ] **Step 6: Restyle the review card in `inbox.css`**

Replace these rules (from Task 1):

```css
.review-card { margin-bottom: 12px; }
.review-card .rationale { margin: 8px 0; line-height: 1.4; }
.review-thumb { … }
@media (min-width: 600px) { .review-thumb { width: 140px; } }
.review-card::after { … }
.folder-row { … }
```

with:

```css
/* Review card */
.review-card { margin-bottom: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-3); }
.review-card .field { margin-bottom: 0; }
.review-card p { margin: 0; }
.review-top { display: flex; gap: var(--sp-3); align-items: flex-start; }
.review-thumb {
  flex: none; width: 88px; aspect-ratio: 3 / 4; object-fit: cover; object-position: top;
  border: 1px solid var(--line); border-radius: var(--r-1); background: var(--paper);
}
@media (min-width: 600px) { .review-thumb { width: 120px; } }
.review-head { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.review-meta { font-family: var(--font-mono); font-size: var(--fs-12); overflow-wrap: anywhere; }
.folder-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; overflow-wrap: anywhere; }
.path { font-family: var(--font-mono); font-size: var(--fs-14); color: var(--ink); overflow-wrap: anywhere; }
.confidence { display: flex; flex-direction: column; gap: 6px; }
.confidence-line { font-variant-numeric: tabular-nums; }
.meter { position: relative; height: 4px; border-radius: 2px; background: var(--paper-3); }
.meter-fill { position: absolute; inset: 0 auto 0 0; width: var(--value); border-radius: 2px; background: var(--ink-3); }
.meter--low .meter-fill { background: var(--warning); }
.meter--ok .meter-fill { background: var(--accent); }
.meter-tick { position: absolute; top: -3px; bottom: -3px; left: var(--threshold); width: 1px; background: var(--ink-3); }
.review-card .rationale {
  padding-top: var(--sp-3); border-top: 1px solid var(--line);
  color: var(--ink-2); font-size: var(--fs-14); line-height: 1.5;
}
/* Approve, the one solid button in the card's own action row, takes the spare width.
   Direct children only, so the document chooser's buttons inside the card don't stretch. */
.review-card > .actions > .btn:not(.btn-secondary):first-child { flex: 1; }
```

- [ ] **Step 7: Suite and typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`
Expected: all pass. If TypeScript rejects `style={meterStyle}`, type it as `const meterStyle: Record<string, string> = …`. Preact's `CSSProperties` has a string index signature.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pwa): review card with page column and confidence meter" -- pwa/src/ui/inbox/ReviewCard.tsx pwa/tests/ui/ReviewCard.test.tsx pwa/src/theme/inbox.css
```

---

### Task 6: Inbox header, row state dots and the rest of `inbox.css`

**Files:**
- Create: `pwa/src/ui/icons.tsx`, `pwa/src/ui/inbox/StateDot.tsx`
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`, `pwa/src/ui/inbox/DocumentRows.tsx`, `pwa/src/ui/inbox/UploadRows.tsx`, `pwa/src/theme/inbox.css`, `pwa/tests/ui/DocumentRows.test.tsx`, `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Failing tests**

At the end of `pwa/tests/ui/DocumentRows.test.tsx` (reuse its existing imports, and add any of `render`, `makeDoc`, `FiledRow`, `WaitingRow`, `FailedRow`, `DiscardedRow` that are missing):

```tsx
describe('row state dots', () => {
  const noop = async () => {};
  it.each([
    ['waiting', () => <WaitingRow doc={makeDoc({ state: 'analyzing' })} onDiscard={noop} />, 'work'],
    ['filed', () => <FiledRow doc={makeDoc({ state: 'filed' })} />, 'ok'],
    ['failed', () => <FailedRow doc={makeDoc({ state: 'failed' })} onRetry={noop} onDiscard={noop} />, 'bad'],
    ['discarded', () => <DiscardedRow doc={makeDoc({ state: 'discarded', discardedAt: '2026-10-10T12:00:00.000Z' })} now={new Date('2026-10-10T12:00:00.000Z')} onRestore={noop} />, 'idle'],
  ] as const)('marks a %s row, hidden from assistive tech', (_, row, kind) => {
    const { container } = render(<ul>{row()}</ul>);
    const dot = container.querySelector(`.state-dot--${kind}`);
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });
});
```

In `pwa/tests/ui/InboxScreen.test.tsx`:

```tsx
  it('shows the mark in the header and keeps Settings named', async () => {
    const { props } = setup([]);
    const header = document.querySelector('.inbox-header')!;
    expect(header.querySelector('svg.mark')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(props.onSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });
```

Run: `pnpm exec vitest run tests/ui/DocumentRows.test.tsx tests/ui/InboxScreen.test.tsx`
Expected: the new tests FAIL. If `makeDoc({ state: 'filed' })` needs a `filed` object for `displayName`, pass whatever the fixtures' other filed tests use.

- [ ] **Step 2: `pwa/src/ui/inbox/StateDot.tsx`**

```tsx
export type DotState = 'work' | 'ok' | 'bad' | 'idle';

/** A row's state at a glance. Decorative: the row's own text says the same. */
export function StateDot({ state }: { state: DotState }) {
  return <span class={`state-dot state-dot--${state}`} aria-hidden="true" />;
}
```

- [ ] **Step 3: Dots in the rows**

Add `import { StateDot } from './StateDot.js';` to both files. Then insert a `StateDot` as the **first child** of each row's `<li class="doc-row">`:

| Component | File | Element |
|---|---|---|
| `WaitingRow` | `DocumentRows.tsx` | `<StateDot state="work" />` |
| `FiledRow` | `DocumentRows.tsx` | `<StateDot state="ok" />` |
| `FailedRow` | `DocumentRows.tsx` | `<StateDot state="bad" />` |
| `DiscardedRow` | `DocumentRows.tsx` | `<StateDot state="idle" />` |
| `UploadRow` | `UploadRows.tsx` | `<StateDot state={item.state === 'failed' ? 'bad' : 'work'} />` |
| `DeviceScanRow` | `UploadRows.tsx` | `<StateDot state="idle" />` |

- [ ] **Step 4: `pwa/src/ui/icons.tsx`**

```tsx
// Icons copied from lucide (https://lucide.dev, ISC licence): 1.5 px stroke,
// currentColor, decorative. Only the ones in use.

export function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
```

- [ ] **Step 5: Header and drop overlay in `InboxScreen.tsx`**

Add imports: `import { Mark } from '../Mark.js';` and `import { SettingsIcon } from '../icons.js';`.

Replace the header block with:

```tsx
      <header class="inbox-header">
        <Mark size={22} />
        <h1 ref={headingRef} tabIndex={-1}>
          Inbox
        </h1>
        <div class="actions">
          <button class="btn btn-secondary btn-small" onClick={() => fileInput.current?.click()}>
            Add
          </button>
          <button class="btn btn-small" onClick={onScan}>
            Scan
          </button>
          <button class="btn btn-secondary btn-small btn-icon" aria-label="Settings" onClick={onSettings}>
            <SettingsIcon />
          </button>
        </div>
      </header>
```

Replace the drop overlay with:

```tsx
      {dragging && (
        <div class="drop-overlay" aria-hidden="true">
          <Mark size={64} />
          Drop files to add them
        </div>
      )}
```

- [ ] **Step 6: Restyle the rest of `inbox.css`**

Replace every rule outside the "Review card" block from Task 5 with the following. The finished file is the block below plus Task 5's review-card block. Keep the review-card block after the rows section.

```css
/* The inbox, and the settings screen, which shares its layout. */
.inbox {
  position: relative; max-width: 720px; margin: 0 auto; padding: var(--sp-4);
  padding-top: max(var(--sp-4), env(safe-area-inset-top));
  padding-bottom: max(var(--sp-6), env(safe-area-inset-bottom));
}
.inbox-header { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.inbox-header h1 { margin: 0; flex: 1; font-size: 22px; }
.inbox h2 {
  margin: var(--sp-6) 0 var(--sp-2);
  font: 500 var(--fs-12)/1.2 var(--font-mono); letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--ink-3);
}
.inbox .warn { margin: var(--sp-3) 0 0; }
.nudge { margin-top: var(--sp-3); }
.nudge p { margin: 0 0 var(--sp-2); }

/* Rows */
.doc-list { list-style: none; padding: 0; margin: 0; }
.doc-row {
  display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
  padding: var(--sp-3) 0; border-bottom: 1px solid var(--line);
}
.doc-row:last-child { border-bottom: 0; }
.doc-main { flex: 1; min-width: 12rem; }
.doc-name { font-weight: 500; overflow-wrap: anywhere; }
.doc-row .muted { font-family: var(--font-mono); font-size: var(--fs-12); overflow-wrap: anywhere; }
.doc-row .error-text { font-size: var(--fs-13); }
.state-dot {
  flex: none; align-self: flex-start; margin-top: 8px;
  width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box;
}
.state-dot--work { border: 1.5px solid var(--accent); }
.state-dot--ok { background: var(--success); }
.state-dot--bad { background: var(--danger); }
.state-dot--idle { border: 1.5px solid var(--line-strong); }
.doc-main progress {
  display: block; width: 100%; height: 3px; margin-top: 6px;
  appearance: none; border: 0; border-radius: 2px; background: var(--paper-3); accent-color: var(--accent);
}
.doc-main progress::-webkit-progress-bar { background: var(--paper-3); border-radius: 2px; }
.doc-main progress::-webkit-progress-value { background: var(--accent); border-radius: 2px; }
.doc-main progress::-moz-progress-bar { background: var(--accent); border-radius: 2px; }

/* Folder picker and document chooser */
.folder-picker { display: flex; flex-direction: column; gap: var(--sp-2); }
.folder-results {
  list-style: none; padding: 0; margin: 0; max-height: 320px; overflow-y: auto;
  background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-2);
}
.folder-results li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); border-bottom: 1px solid var(--line); }
.folder-results li:last-child { border-bottom: none; }
.folder-results .btn-square { margin-right: var(--sp-1); }
.folder-result {
  all: unset; flex: 1; box-sizing: border-box; min-height: 44px; padding: 10px 12px;
  display: flex; align-items: center; cursor: pointer; overflow-wrap: anywhere; color: var(--ink);
}
.folder-picker .folder-result { font: 400 var(--fs-14)/1.4 var(--font-mono); }
.folder-result:hover { background: var(--paper-2); }
.folder-result:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.new-folder { display: flex; gap: var(--sp-2); width: 100%; padding: var(--sp-2) var(--sp-3); box-sizing: border-box; }
.doc-chooser { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); }
.doc-chooser h3 {
  margin: var(--sp-1) 0 0;
  font: 500 var(--fs-12)/1.2 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
}
.chooser-option {
  flex: 1; display: flex; align-items: center; gap: var(--sp-2); padding: 10px 12px;
  min-height: 44px; box-sizing: border-box; overflow-wrap: anywhere; cursor: pointer;
}

/* Drop overlay: a soft wash, never a thick or accent border. */
.drop-overlay {
  position: fixed; inset: 0; z-index: 10; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-4);
  background: color-mix(in oklab, var(--accent-soft) 90%, transparent); color: var(--accent-ink);
  font-size: var(--fs-20); font-weight: 500;
}
.drop-overlay .mark { color: var(--accent-ink); }
```

- [ ] **Step 7: Suite and typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add pwa/src/ui/icons.tsx pwa/src/ui/inbox/StateDot.tsx
git commit -m "feat(pwa): owine inbox header, row state dots and lists" -- pwa/src/ui/icons.tsx pwa/src/ui/inbox pwa/src/theme/inbox.css pwa/tests/ui/DocumentRows.test.tsx pwa/tests/ui/InboxScreen.test.tsx
```

---

### Task 7: Sign-in and the full-page states

**Files:**
- Modify: `pwa/src/ui/LoginScreen.tsx`, `pwa/src/ui/ResumePrompt.tsx`, `pwa/src/ui/App.tsx`, `pwa/src/ui/ScannerScreen.tsx` (camera-unavailable state only), `pwa/src/theme/auth.css`

- [ ] **Step 1: Lockup and inline styles out**

- `LoginScreen.tsx`:
  - Add `import { Mark } from './Mark.js';`.
  - Replace `<h1>doc-scanner</h1>` with `<h1 class="lockup"><Mark size={30} />doc-scanner</h1>`. The accessible name stays "doc-scanner", because the mark is `aria-hidden`.
  - Delete `style={{ marginBottom: 8 }}` from the Reload button and `style={{ marginTop: 8 }}` from the Cancel button. `.btn-block + .btn-block` spaces them now.
- `App.tsx`:
  - Add `import { Mark } from './Mark.js';`.
  - In the `expired` and `unreachable` blocks, replace both `<h1>doc-scanner</h1>` with `<h1 class="lockup"><Mark size={30} />doc-scanner</h1>`.
  - Delete `style={{ marginTop: 8 }}` from the unreachable block's Reload button.
- `ResumePrompt.tsx`:
  - `<h2 style={{ marginTop: 0 }}>` becomes `<h2>`. `.card > :first-child` removes the margin.
  - `<div style={{ display: 'flex', gap: 8 }}>` becomes `<div class="actions">`.
- `ScannerScreen.tsx`, camera-unavailable block: `<div style={{ display: 'flex', gap: 8 }}>` becomes `<div class="actions">`.

- [ ] **Step 2: Rewrite `pwa/src/theme/auth.css`**

```css
/* Sign-in and the full-page states: one left-aligned column. */
.auth-screen {
  box-sizing: border-box; max-width: 400px; margin: 0 auto;
  display: flex; flex-direction: column; gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-4);
  padding-top: max(var(--sp-6), env(safe-area-inset-top));
  padding-bottom: max(var(--sp-6), env(safe-area-inset-bottom));
}
@media (min-width: 600px) {
  .auth-screen { padding-top: var(--sp-10); padding-bottom: var(--sp-10); }
}
.auth-screen > * { margin: 0; }
.auth-screen h2 { font-size: var(--fs-20); }
.lockup { display: flex; align-items: center; gap: 10px; font-size: 26px; font-weight: 500; letter-spacing: -0.025em; }
```

- [ ] **Step 3: Suite and typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`
Expected: all pass. `login.test.tsx`, `ResumePrompt.test.tsx` and `App*.test.tsx` need no edits. If a query by heading name `'doc-scanner'` fails, check that the `<Mark>` and the text have no stray whitespace text node between them, and remove it.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(pwa): owine sign-in lockup and full-page states" -- pwa/src/ui/LoginScreen.tsx pwa/src/ui/ResumePrompt.tsx pwa/src/ui/App.tsx pwa/src/ui/ScannerScreen.tsx pwa/src/theme/auth.css
```

---

### Task 8: Settings

**Files:**
- Create: `pwa/src/theme/settings.css`
- Modify: `pwa/src/ui/SettingsScreen.tsx`, `pwa/src/ui/PasskeysSection.tsx`, `pwa/src/main.tsx`, `pwa/tests/ui/PasskeysSection.test.tsx`

- [ ] **Step 1: Failing test for the danger Remove**

Find the test in `pwa/tests/ui/PasskeysSection.test.tsx` that renders a list with passkeys (search for `Remove Phone`). Add these lines to it after the list has rendered, or write a new test using the same setup:

```tsx
    await screen.findByRole('button', { name: 'Remove Phone' });
    expect(screen.getAllByRole('button', { name: /^Remove / })[0]).toHaveClass('btn-danger');
```

Some setups render one passkey and some two, so use `getAllByRole`, which works for both. The list loads asynchronously, so `findByRole` waits for it first.

Run: `pnpm exec vitest run tests/ui/PasskeysSection.test.tsx`
Expected: FAIL (the button has `btn-secondary`).

- [ ] **Step 2: Markup**

- `PasskeysSection.tsx`: the passkey Remove button's `class="btn btn-secondary btn-small"` becomes `class="btn btn-danger btn-small"`.
- `SettingsScreen.tsx`:
  - The `<fieldset … style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>` becomes `<fieldset disabled={busy} class="plain-fieldset">`.
  - The theme group `<div class="card" role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 8 }}>…</div>` becomes `<div class="card"><div class="segmented" role="radiogroup" aria-label="Theme">…</div></div>`. The section stays one card, as the spec says, with the segmented control inside it.
  - Each theme button's `class={pref === p ? 'btn' : 'btn btn-secondary'}` becomes `class="segment"`, and its `style={{ textTransform: 'capitalize' }}` is deleted. `role`, `aria-checked`, `onClick` and the text stay.
  - Sign out and the never-file-here Remove keep `btn-secondary`.

- [ ] **Step 3: `pwa/src/theme/settings.css`**

```css
/* Settings. The page layout is the inbox's: see inbox.css. */
.plain-fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.segmented { display: flex; gap: var(--sp-1); padding: var(--sp-1); background: var(--paper-3); border-radius: var(--r-3); }
.segment {
  flex: 1; min-height: 40px; border: 0; border-radius: var(--r-2);
  background: transparent; color: var(--ink-2);
  font: 500 var(--fs-14)/1 var(--font-sans); text-transform: capitalize; cursor: pointer;
}
.segment:hover { color: var(--ink); }
.segment[aria-checked="true"] { background: var(--card); color: var(--ink); box-shadow: var(--shadow-1); }
.inbox .card + h2 { margin-top: var(--sp-6); }
```

Add `import './theme/settings.css';` to `main.tsx`, after the inbox import.

- [ ] **Step 4: Suite and typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`
Expected: all pass. `SettingsScreen.test.tsx` queries the theme by `role="radio"` and name, so the class change doesn't affect it.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/theme/settings.css
git commit -m "feat(pwa): owine settings, segmented theme control" -- pwa/src/theme/settings.css pwa/src/ui/SettingsScreen.tsx pwa/src/ui/PasskeysSection.tsx pwa/src/main.tsx pwa/tests/ui/PasskeysSection.test.tsx
```

---

### Task 9: Scanner and edit corners

**Files:**
- Create: `pwa/src/theme/scanner.css`
- Modify: `pwa/src/ui/ScannerScreen.tsx`, `pwa/src/ui/EditCornersScreen.tsx`, `pwa/src/main.tsx`, `pwa/tests/ui/EditCornersScreen.test.tsx`

- [ ] **Step 1: Failing test for the handle hit area**

In `pwa/tests/ui/EditCornersScreen.test.tsx`, add:

```tsx
  it('draws the corners as styled handles positioned inline', () => {
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={() => {}} />);
    for (const k of ['tl', 'tr', 'bl', 'br']) {
      const handle = screen.getByLabelText(`Corner ${k}`) as HTMLElement;
      expect(handle).toHaveClass('corner-handle');
      expect(handle.style.left).toMatch(/px$/);
    }
  });
```

Don't assert exact positions. happy-dom lays the wrapper out at 0×0, so `observe()` computes a degenerate scale. The 22 px centring is checked by eye in Task 10.

Run: `pnpm exec vitest run tests/ui/EditCornersScreen.test.tsx`
Expected: FAIL (no `corner-handle` class).

- [ ] **Step 2: Edit corners markup**

In `EditCornersScreen.tsx`, replace `const HANDLE_RADIUS = 14;` with:

```ts
/** Half the handle's 44 px touch target, centred on the corner; the visible ring is 28 px. */
const HANDLE_HIT_RADIUS = 22;
```

Replace the returned JSX with:

```tsx
  return (
    <main class="camera">
      <header class="camera-bar">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <strong class="camera-title">Adjust corners</strong>
        <span />
      </header>
      <div ref={wrapRef} class="corners-view" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
          <div
            key={k}
            class="corner-handle"
            onPointerDown={onPointerDown(k)}
            // Strings with units: Preact 11's core no longer appends "px" to numbers
            // (only preact/compat does), and browsers ignore a unitless length.
            style={{
              left: `${quad[k].x * render.scale + render.offsetX - HANDLE_HIT_RADIUS}px`,
              top: `${quad[k].y * render.scale + render.offsetY - HANDLE_HIT_RADIUS}px`,
            }}
            aria-label={`Corner ${k}`}
          />
        ))}
      </div>
      <footer class="camera-foot camera-foot--split">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn" onClick={() => onApply(quad)} disabled={!valid}>Apply</button>
      </footer>
      {!valid && <p class="error-text camera-error">Corners must form a quadrilateral</p>}
    </main>
  );
```

- [ ] **Step 3: Scanner markup**

In `ScannerScreen.tsx`, replace the main return (from `<main style={{` through `</main>`) with:

```tsx
    <main class="camera">
      <header class="camera-bar">
        <button class="btn btn-secondary" onClick={cancel}>← Cancel</button>
        <div class="camera-title">Page {pageCount + 1}</div>
        <button class={autoCapture ? 'btn btn-small' : 'btn btn-secondary btn-small'} onClick={toggleAuto} aria-pressed={autoCapture}>
          Auto {autoCapture ? 'on' : 'off'}
        </button>
      </header>
      <div class="camera-view">
        <video ref={videoRef} class="camera-video" playsInline muted autoPlay />
        <div class={stability === 'stable' ? 'camera-hint camera-hint--stable' : 'camera-hint'}>{stabilityMsg}</div>
        {SHOW_DIAGNOSTICS && (
          <div class="camera-diag">
            <div>frames: {diag.frames} · stab: {stability} · canvas: {diag.canvasW}×{diag.canvasH}</div>
            <div>contour pts: {diag.contourPts} · quad: {diag.lastQuad ? 'detected' : 'none'}</div>
            {diag.lastErr && <div class="camera-diag-err">err: {diag.lastErr}</div>}
          </div>
        )}
      </div>
      <footer class="camera-foot">
        <span class="camera-count">Pages: {pageCount}</span>
        <button aria-label="Capture" class="shutter" onClick={shutter}>
          <span class="shutter-dot" aria-hidden="true" />
        </button>
        <button class="btn" onClick={done} disabled={pageCount === 0}>Done →</button>
      </footer>
    </main>
```

The `Pages: {pageCount}` span used to be `class="muted"`. If any scan-flow test queries it by class, keep `muted` as well: `class="muted camera-count"`.

- [ ] **Step 4: `pwa/src/theme/scanner.css`**

```css
/* Camera surfaces: the scanner and edit corners. Dark in both themes. */
.camera {
  display: flex; flex-direction: column; height: 100dvh;
  background: var(--ink-bg); color: var(--ink-fg);
  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);
}
.camera-bar {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--ink-line);
}
.camera-bar > :first-child { justify-self: start; }
.camera-bar > :last-child { justify-self: end; }
.camera-title {
  font: 500 var(--fs-13)/1.2 var(--font-mono); letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--ink-fg-2);
}
.camera .btn-secondary { background: rgb(255 255 255 / 0.06); color: var(--ink-fg); border-color: var(--ink-line); }
.camera .btn-secondary:hover, .camera .btn-secondary:active { background: rgb(255 255 255 / 0.12); }
.camera .btn:disabled { background: var(--ink-bg-2); color: var(--ink-fg-2); border-color: var(--ink-line); }

.camera-view { flex: 1; position: relative; overflow: hidden; min-height: 0; }
.camera-video { display: block; width: 100%; height: 100%; object-fit: cover; }
.camera-hint {
  position: absolute; top: var(--sp-3); left: 0; right: 0; text-align: center;
  font-weight: 500; color: var(--ink-warning); text-shadow: 0 1px 3px rgb(0 0 0 / 0.7);
}
.camera-hint--stable { color: var(--ink-success); }
.camera-diag {
  position: absolute; bottom: var(--sp-2); left: var(--sp-2); right: var(--sp-2);
  padding: 6px; border-radius: var(--r-1); background: rgb(0 0 0 / 0.7);
  color: var(--ink-success); font: 400 11px/1.4 var(--font-mono);
}
.camera-diag-err { color: var(--ink-danger); }

.camera-foot {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  padding: var(--sp-3); border-top: 1px solid var(--ink-line);
}
.camera-foot > :last-child { justify-self: end; }
.camera-foot--split { display: flex; gap: var(--sp-2); }
.camera-foot--split .btn { flex: 1; }
.camera-count { font: 400 var(--fs-13)/1.2 var(--font-mono); color: var(--ink-fg-2); }

/* The shutter echoes the mark: a ring with the accent dot sitting on it. */
.shutter {
  position: relative; justify-self: center; width: 68px; height: 68px; padding: 0;
  border-radius: 50%; border: 3px solid var(--ink-fg); background: rgb(255 255 255 / 0.12); cursor: pointer;
}
.shutter:active { background: rgb(255 255 255 / 0.24); }
.shutter-dot {
  position: absolute; right: 2px; bottom: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--ink-bg);
}

.corners-view { flex: 1; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.corner-handle {
  position: absolute; width: 44px; height: 44px;
  display: grid; place-items: center; touch-action: none; cursor: grab;
}
.corner-handle::before {
  content: ''; width: 28px; height: 28px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid var(--ink-fg);
  background: radial-gradient(circle, var(--accent) 0 4px, rgb(14 22 32 / 0.35) 4.5px);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.5);
}
.camera-error { margin: 0; padding: var(--sp-1); text-align: center; color: var(--ink-danger); }
```

Add `import './theme/scanner.css';` to `main.tsx`, after the settings import.

- [ ] **Step 5: No stray inline styles, no old literals**

Run:
```bash
grep -rn "style={{" pwa/src/ui
```
Expected: exactly one hit, the corner handle in `EditCornersScreen.tsx`, which is computed per render. (`ReviewCard`'s `style={meterStyle}` doesn't match the pattern and is meant to stay.) Any other hit is a missed move.

```bash
grep -rnE "#(fff|000|111|444|4ade80|fbbf24|aaffaa|ff8888)\b" pwa/src/ui || echo "clean"
```
Expected: `clean`.

- [ ] **Step 6: Suite and typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`
Expected: all pass, including `App-scan-flow.test.tsx`.

- [ ] **Step 7: Commit**

```bash
git add pwa/src/theme/scanner.css
git commit -m "feat(pwa): owine camera surfaces for scanner and edit corners" -- pwa/src/theme/scanner.css pwa/src/ui/ScannerScreen.tsx pwa/src/ui/EditCornersScreen.tsx pwa/src/main.tsx pwa/tests/ui/EditCornersScreen.test.tsx
```

---

### Task 10: Docs, full verification and the PR

**Files:**
- Modify: `CLAUDE.md` (the PWA paragraph)

- [ ] **Step 1: CLAUDE.md**

In the `### PWA (pwa/src/)` paragraph, replace "the rest of `ui/`, `theme/`;" with:

> the rest of `ui/` (`Mark.tsx` is the page-and-dot mark), `theme/` (owine tokens in `tokens.css`, whose two dark blocks `tests/theme/tokens.test.ts` keeps identical, then `base.css` and one stylesheet per area); app icons are rendered by `server/scripts/render-pwa-icons.mjs`;

Commit:
```bash
git commit -m "docs: note the owine theme files in CLAUDE.md" -- CLAUDE.md
```

- [ ] **Step 2: All gates from the root**

Run: `pnpm test && pnpm --filter @doc-scanner/pwa run typecheck && pnpm --filter @doc-scanner/server run typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 3: Visual pass (needs the owner)**

1. Start the dev stack: `pnpm dev`. It needs `SESSION_ENCRYPTION_KEY` and `ANTHROPIC_API_KEY` in the environment; ask the owner how they normally run it locally.
2. Open `http://localhost:5173` in Playwright. **The owner signs in.** Never move a session cookie or credentials into Playwright yourself.
3. To get review cards, add two or three sample PDFs with **Add**.
4. Screenshot each screen at 390×844 and 1024×768, in light and in dark (Settings → Theme): sign-in, inbox (review card, in progress, filed), folder picker (Change), chooser (More → Combine with…), settings, scanner (camera permission may be denied in Playwright; then the camera-unavailable state is what you can check) and edit corners if reachable.
5. On each screen and theme, inject axe-core once and run a WCAG 2.1 AA check. Load it from the CDN inside the page; don't add it as a dependency. Fix any violation before going on.
6. Check by eye: Geist is rendering (not a system font), the dark-mode control borders are visible, and no light surface shows through on the camera screens in light mode.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/owine-rebrand
gh pr create --title "feat(pwa): owine rebrand" --body "$(cat <<'EOF'
Restyles the PWA in the owine design system: tokens, Geist type, the page-and-dot mark and app icons, and a layout pass on every screen. Copy, roles and accessible names are unchanged.

Spec: docs/superpowers/specs/2026-10-14-owine-rebrand-design.md
Plan: docs/superpowers/plans/2026-10-14-owine-rebrand.md

- theme.css is split into tokens.css (a test keeps the two dark blocks identical), base.css and one stylesheet per area
- Geist and Geist Mono are self-hosted via @fontsource-variable (5.3.0)
- review card: page column, confidence meter with the auto-file threshold (the inbox now reads /api/settings once)
- list rows get state dots; scanner and edit corners are dark camera surfaces in both themes
- one deviation from owine: dark --line-strong is #626e80 (owine's #3d4654 is 1.87:1)

After deploy: check the home-screen icon on iOS and the maskable icon on Android.
EOF
)"
```

Then follow the repo's PR routine: wait for the Sourcery review, address it, enable auto-merge and watch CI.
