# owine Rebrand of the PWA: Design Spec

**Date:** 2026-10-14
**Status:** Implemented; planned in [`2026-10-14-owine-rebrand.md`](../plans/2026-10-14-owine-rebrand.md)
**Branch:** `feat/owine-rebrand`
**Mocks (private artifacts):** [identity](https://claude.ai/code/artifact/f78c9ebd-5d17-4bfe-ae25-497fa8bc62eb) (option B chosen), [inbox and review card](https://claude.ai/code/artifact/4f464b63-d5d5-4d4a-ba8f-4af09ec7126b) (variant 2 chosen)

## Why this exists

The PWA looks generic today. `theme/theme.css` uses system fonts, a white or near-black ground and a stock blue. It has no mark: the home-screen icon is a placeholder PNG, and the manifest's colours don't match the app. doc-scanner is an owine project, and the owine design system covers palette, type, spacing, radii, shadows, motion and a mark. This spec applies that system to every screen and restyles the layout where it helps.

## Scope

**In:** design tokens, fonts, the mark and app icons, and layout and styling on every screen. That covers sign-in and the full-page states, the inbox (header, banners, review card, list rows, folder picker, document chooser, drop overlay), settings (including passkeys), the scanner and edit corners.

**Out:**
- **Copy.** owine writes everything in lowercase; this app keeps its current sentence case, by the owner's decision. Text, roles and accessible names don't change, so the existing tests keep working as the regression net. The few tests that do have to change are listed under Testing.
- **Instrument Serif.** owine's serif is for one warm word per surface, and a utility app doesn't need it.
- **Server changes.**
- **Service-worker changes.**
- **New behaviour,** with one exception: the inbox reads the auto-file threshold (see Inbox).

## Approach

The single `theme/theme.css` is replaced by stylesheets split by area, all imported from `main.tsx`:

| file | holds |
|---|---|
| `theme/tokens.css` | every owine token, in three theme blocks |
| `theme/base.css` | element defaults and shared controls: `.btn` (+ `-secondary`, `-danger`, `-small`, `-block`, `-square`, new `-icon`), `.card`, `.field`, `.warn`, `.chip`, `.badge`, `.muted`, `.error-text`, `.visually-hidden`, a `.stack` gap utility |
| `theme/inbox.css` | inbox, review card, rows, folder picker, chooser, drop overlay |
| `theme/auth.css` | `.auth-screen` and the full-page states |
| `theme/settings.css` | settings and passkeys |
| `theme/scanner.css` | scanner and edit corners |

The existing class names stay, so most components don't change. The owine skill's `kit.css` is **not** adopted, because its `.btn`, `.card` and `.field` would clash with ours.

**Inline styles.** There are 30 `style={{…}}` objects: Scanner 13, EditCorners 9, Settings 3, Login 2, ResumePrompt 2 and `App.tsx` 1. Static ones move into the area stylesheet. Values computed per render stay inline, preferably as a CSS custom property that the stylesheet reads, for example `style={{ '--x': … }}`. Those are the corner-handle `left`/`top`, the video's computed sizing and the scanner overlay's position.

## Tokens and theming

**Names.** The owine names become the canonical tokens:
- Surfaces: `--paper`, `--paper-2`, `--paper-3`, `--card`.
- Lines: `--line` (decorative) and `--line-strong` (control borders, at least 3:1).
- Text: `--ink` through `--ink-4`.
- Accent: `--accent`, `-hover`, `-press`, `-soft`, `-ink`, and `--on-accent`.
- Semantic: `--success`, `--warning`, `--danger`, each with `-soft`.
- Camera surfaces: `--ink-bg` and `--ink-fg`.
- Type: `--font-sans`, `--font-mono`, and a UI type scale.
- Spacing on a 4 px grid; radii `--r-1` to `--r-4` (4, 6, 10, 16); `--shadow-1` to `-3`; `--ring`.
- Motion: 120 and 200 ms, owine's ease-out and ease-in-out.

The old names (`--bg`, `--bg-elev`, `--fg`, `--fg-muted`, `--border`, `--accent-fg`, `--warn-bg`, `--warn-border`) are removed, not aliased. Their only users are `theme.css` and `EditCornersScreen`'s three inline `var(--bg)`, `var(--bg-elev)` and `var(--border)`. Commit 1 renames all of them (see Delivery), so a grep for each old name comes back empty from commit 1 on.

**One deviation from owine.** owine's dark `--line-strong` is `#3d4654`, which is only 1.87:1 on the dark paper. That fails WCAG 1.4.11 for control borders, which axe doesn't check. This app uses **`#626e80`** instead: 3.44:1 on `#14181f` and 3.13:1 on `#1b212a`. The light `#948b78` passes at 3.07:1.

**Theme blocks.** The PWA supports system, light and dark (`use-theme.ts` sets `data-theme` only for an explicit choice). owine's own CSS has only `[data-theme="dark"]`, so `tokens.css` has three blocks:

1. bare `:root`: the complete light palette, with `color-scheme: light`;
2. `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`: the dark overrides, with `color-scheme: dark`;
3. `:root[data-theme="dark"] { … }`: the same dark overrides.

Plain CSS can't share blocks 2 and 3, so a unit test parses `tokens.css` and checks two things:
- the two dark blocks declare the same properties with the same values;
- every property they declare also appears in bare `:root`.

**Chrome colours.**
- `use-theme.ts` writes `theme-color` as `#f6f4ef` (light) and `#14181f` (dark).
- `index.html` starts its `theme-color` at `#f6f4ef`. Until the JS runs, a dark-mode device shows a light status bar for a moment. This is a known trade-off, the same as today's `#ffffff`, and isn't fixed here.
- The manifest's `background_color` and `theme_color` are both `#f6f4ef`.

**States.**
- **Warnings:** `--warning-soft` ground, text in `--ink` with the leading word in `--warning`, 1 px border.
- **Errors:** `--danger` text.
- **Focus:** `--ring` on every focusable control, replacing the 2 px outlines. This deviates from owine on purpose. Owine's ring is a 3 px accent at 25%, about 1.4:1, which fails owine's own "at least 3:1" focus floor. So `--ring` is a solid two-tone ring: 2 px of paper, then 2 px of accent, with literal colours per theme. A transparent 2 px outline sits behind it, so forced-colours mode still shows focus, and checkboxes get a real accent outline because WebKit may not paint box-shadow on them.
- **Hover:** behind `@media (hover: hover)`, so a tapped button on a phone doesn't keep its hover tint.
- **Disabled:** `--paper-3` ground with `--ink-4` text, not opacity. That's `--paper-3`, not owine's `--paper-2`, because `--paper-2` is already the secondary button's hover and press colour.
- **Motion:** transitions only inside `prefers-reduced-motion: no-preference`.

## Type, icons and the mark

**Fonts.** `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` at 5.3.0 (OFL-1.1). Both are imported once in `main.tsx`, so Vite emits them as hashed assets. They're unicode-range subset files, so in practice only the latin file loads, about 60 to 70 KB in total. The stacks are `'Geist Variable', ui-sans-serif, system-ui, -apple-system, sans-serif` and `'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace`, with `font-display: swap`. There's no Google Fonts request, which matters behind Authelia.

**Scale.**

| role | size, weight, tracking |
|---|---|
| body, inputs (at least 16 px or iOS zooms on focus) | 16 px |
| UI text | 15 px |
| captions and notes | 13 px |
| mono meta | 12 px |
| section labels | 12 px mono, uppercase via CSS, 0.08em |
| screen titles | 22 to 26 px, 500, −0.02em |
| review rationale | 14 px, `--ink-2` |

Mono is for what the machine reports: original file names, folder paths, percentages, sizes, page counts and status lines. Names the user types stay in Geist.

**Icons.** `ui/icons.tsx` holds only icons actually used, copied from lucide (ISC, noted in a comment), with a 1.5 px stroke, `currentColor` and `aria-hidden`. At first that's only `Settings`. Arrows in "← Cancel" and "Done →" stay unicode.

**The mark: page and dot.** A sheet with a folded corner, drawn with the owine ring's thin stroke. The accent dot sits offset at the lower right, where the ring's dot sits.
- `ui/Mark.tsx` is inline SVG: stroke `currentColor`, dot `var(--accent)`, `aria-hidden`, with a `size` prop.
- `public/icons/`:
  - `favicon.svg`: an ink rounded square (6 px of 32) with a paper sheet and an accent dot.
  - `icon-192.png` and `icon-512.png`: full-bleed ink square, `purpose: "any"`.
  - `icon-maskable-512.png`: the art inside the central 80% safe zone, `purpose: "maskable"`.
  - `apple-touch-icon.png`: 180 px.
- The PNGs are rendered from SVG source by a committed script, `server/scripts/render-pwa-icons.mjs`. It lives in the server workspace because Node resolves `sharp` from the script's own location, and `sharp` is a dependency of `server/` only (pnpm doesn't hoist it). It writes into `pwa/public/icons/`. The PNGs are committed, so the build doesn't depend on the script.
- `index.html` gains `<link rel="icon" type="image/svg+xml">` and `<link rel="apple-touch-icon">`, and the manifest lists the three PNGs.

## Screens

### Inbox

- **Header:** `Mark` (22 px), then the `Inbox` h1, then Add (secondary), Scan (primary) and Settings (icon-only, `aria-label="Settings"`).
- **Banners:**
  - The locked banner, sign-in-again and can't-reach-the-server notices use the `.warn` style. The locked banner's Unlock is the primary button.
  - The passkey nudge is a plain card.
  - The `role="status"` live region stays always rendered.
- **Section headings:** mono caps via CSS. Accessible names don't change, for example "Needs review (2)".
- **Review card:** see the [inbox mock](https://claude.ai/code/artifact/4f464b63-d5d5-4d4a-ba8f-4af09ec7126b), variant 2.
  - Thumbnail column on the left: 88 px wide, 120 px at 600 px and up, 3:4, 1 px `--line` border, `--r-1`. Without `hasThumbnail`, or after the image fails to load, the column is gone and the fields span the full width; there's never an empty box. `ReviewCard` tracks this in a `thumbFailed` state that `onError` sets, replacing today's `hidden = true`, and renders the column only when `hasThumbnail && !thumbFailed`.
  - Beside it: a mono meta line (original name · source), then Name.
  - Below:
    - Folder: a label row with Change as a link-style button, then the path in mono. The New folder badge is an `--accent-soft` tag.
    - The confidence meter.
    - A hairline, then the rationale.
    - The prepare note, the content-not-seen note and the "Paired with" line, as 13 px notes that keep the `.muted` class.
    - Errors, then actions: Approve (primary, grows), Discard, More.
- **Confidence meter.**
  - Text: the confidence line keeps its current text as direct text of one `<p>`, for example "72% confident · confidence 0.720 is below 0.80". There's no inner span around the percentage, because `getByText` matches only an element's own text and an inner span would break `ReviewCard.test.tsx:24`. The whole `<p>` gets `font-variant-numeric: tabular-nums` and stays in Geist.
  - Bar: a 4 px bar under the line, filled to the confidence, on `--paper-3`. This changes the mock, which split the reason and the percentage to either side of the bar; keeping the line whole leaves its text and its test unchanged.
  - Fill colour: `--warning` below the threshold, `--accent` at or above it (a document at or above can still be in review, for example because auto-file is off or it's anchored), and `--ink-3` when the threshold isn't known.
  - Threshold: `InboxScreen` calls `documents.settings()` once on mount through its injected `documents` prop (`DocumentsApi` already has `settings`), never the `documentsApi` singleton. The call is awaited inside `try`/`catch` in an async function, so a rejection is swallowed. It passes `autoFileThreshold` to each card and guards against setting state after unmount with a `useLayoutEffect` mounted flag (Preact 11 runs `useEffect` cleanups after paint).
  - Tick: with a threshold, a 1 px `--ink-3` tick marks it.
  - Accessibility: the bar is `aria-hidden`. When the threshold is known, the confidence line ends with a `.visually-hidden` " (auto-file threshold 80%)", so the line still contains the existing text and screen readers get the threshold too. Without a threshold (still loading, or the fetch failed) there's no tick and no hidden text, and nothing is reported to the user.
  - Placement: when there's no suggestion, there's no line and no bar, the same as today.
- **Rows:**
  - **State dot:** an 8 px dot before the name.
    - Waiting or uploading: open ring, 1.5 px `--accent`.
    - Filed: solid `--success`.
    - Failed: solid `--danger`.
    - Discarded and device scans: open ring, `--line-strong`.
    - The dot is `aria-hidden`, because the status text already says the same thing.
  - **Status and path lines:** mono, 12 px, `--ink-3`. An error line stays Geist 13 px in `--danger`.
  - **Uploads:** keep the native `<progress>` (3 px, accent) so its role is unchanged.
  - **Chips:** a hairline chip. `auto` uses `--accent-soft` / `--accent-ink`.
- **Folder picker and document chooser:** a search input above one bordered list (`--line`, `--r-2`) of 44 px rows with `--paper-2` on hover. Paths are in mono.
- **Drop overlay:** `--accent-soft` at about 90%, with a 64 px `Mark` and the existing text. It replaces the 3 px dashed accent border, since owine never uses thick or accent-coloured borders.

### Sign-in and full-page states

This covers `LoginScreen`, `ResumePrompt`, `App`'s loading, expired and unreachable states, and the scanner's camera-unavailable state. They share `.auth-screen`: one left-aligned column, 400 px max, safe-area padding kept, children spaced with `.stack`. Sign-in opens with the lockup: `Mark` (30 px) plus "doc-scanner" at 26 px, weight 500. Primary actions are full-width.

### Settings

- Mono-caps section labels, each section one card.
- The theme `radiogroup` is styled as a segmented control. The markup doesn't change.
- Passkey rows follow the inbox row pattern: label in Geist, date and credential info in mono.
- A passkey's Remove (`PasskeysSection`) uses `.btn-danger`, in `--danger` with `--on-accent` text, because it deletes a credential. Sign out and the never-file-here Remove stay `.btn-secondary`.

### Scanner and edit corners

Both are camera surfaces: `--ink-bg` ground and `--ink-fg` text in **both** themes.

- **Scanner:**
  - Top bar: Cancel as a ghost button on dark, "Page 3" in mono. Auto-capture stays the same `aria-pressed` button with its "Auto on/off" text, styled as a toggle; it doesn't become `role="switch"`.
  - Bottom bar, on a three-column grid: page count in mono, then the shutter, then Done → (primary).
  - The shutter is a 68 px paper ring (3 px stroke) around a translucent disc, with the accent dot sitting offset on the ring, echoing the mark.
  - The diagnostics overlay is mono.
- **Edit corners:** restyle only. Nothing draws an outline between the handles today, and none is added.
  - Handles are 28 px paper rings with an accent centre, each with a 44 px hit area. Today `HANDLE_RADIUS = 14` sets both the size and the position offset. It becomes `HANDLE_HIT_RADIUS = 22`, giving a 44 px box centred on the corner (so the `left`/`top` maths keeps one constant), and the 28 px ring is drawn by an inner element or `::before`. Positions stay inline.
  - The markup stays as it is: the header keeps its Cancel and the "Adjust corners" title, the footer keeps Cancel and Apply, and the invalid-quad message stays put. Header and footer take the dark camera-surface styling.

## Testing and verification

- **Regression net:** text, roles and accessible names are unchanged, so the existing `getByRole`/`getByText` queries (about 450) must pass unedited, except for these expected edits:
  - `tests/theme/use-theme.test.ts`: the `theme-color` values become `#f6f4ef` / `#14181f`.
  - `tests/ui/ReviewCard.test.tsx`, "hides a thumbnail that fails to load": after `onError` the column is unmounted, so the test asserts the `img` is gone, not `img.hidden`.
  - `tests/ui/InboxScreen.test.tsx`: the shared `documents` mock in `setup()` gains `settings`, returning an already-resolved promise with a threshold of 0.8, like `folderLoad`, so tests that don't wait for it log no `act()` warnings. The three tests that build their own `documents` mock with only `folders`/`refreshFolders` (about lines 244, 266 and 287) gain the same `settings`. The production call is never written as `settings?.()` to suit a mock.

  Any other failing test is a regression, to be fixed in the code, not the test. The App tests need no edits. `App.tsx` renders `InboxScreen` with the default `documentsApi`, so they reach `/api/settings` through real `fetch`. Their stubs already answer unrouted requests with 404 or 503, which rejects into the catch.
- **New unit tests:**
  - token parity, as above;
  - `use-theme` `theme-color` values;
  - review card: no thumbnail means no column; an image that fails to load removes the column; with a threshold, the tick renders and the confidence `<p>` passes `toHaveTextContent(/auto-file threshold 80%/)` (a bare `getByText` would find only the span, not prove the line contains it); without one, neither appears and the card still works; the bar is `aria-hidden`;
  - inbox: `documents.settings()` is called once, its threshold reaches the cards, and a rejected call shows no error;
  - header: the Settings button is found by `getByRole('button', { name: 'Settings' })`.
- **Gates:** `pnpm test`, `pnpm --filter @doc-scanner/pwa run typecheck` and `pnpm build`.
- **Visual pass:**
  - Run `pnpm dev`, and drive it through Playwright at 390 px and 1024 px in light and dark.
  - Screens: sign-in, inbox (with review, waiting, failed and filed documents), folder picker, chooser, settings, scanner and edit corners.
  - The owner signs in; the session cookie isn't moved into Playwright.
  - One axe-core WCAG 2.1 AA pass per screen and theme, injected for the run, not added as a dependency.
- **After deploy:** check the home-screen icon on iOS and the maskable icon on Android. Playwright can't show OS masking.

## Delivery

One PR, squash-titled `feat(pwa): owine rebrand`. Atomic commits, in order:

1. Replace `theme.css`: `tokens.css` with owine values, and every existing rule moved unchanged into `base.css` or its area file with token names renamed. `EditCornersScreen`'s three inline old-token vars are renamed too, and the old-name grep is empty. Adds the token-parity test, and changes `use-theme.ts`'s `theme-color` values together with `use-theme.test.ts`. After this commit the app has owine colours on today's layout.
2. Fonts.
3. Mark, icons, `index.html` (`theme-color` start value, icon links) and the manifest. `use-theme.ts` already changed in commit 1.
4. Inbox and review card, including the settings fetch.
5. Sign-in and full-page states.
6. Settings.
7. Scanner and edit corners.

Every commit leaves the app working and the tests green.
