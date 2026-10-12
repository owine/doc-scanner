# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal-use, self-hosted PWA for scanning paper documents from a phone camera and uploading them to Proton Drive. A phone-facing Preact PWA captures/crops pages and accepts any file from the inbox; a small TypeScript server authenticates against Proton's SRP flow on the user's behalf and proxies **end-to-end-encrypted** uploads through the official Proton Drive SDK.

## Toolchain (strict)

- **Node `24.21.0`** (pinned in `.nvmrc`, enforced by `engineStrict` — `pnpm install` **fails** on any other version). Run `fnm use` / `nvm use` first. Node 26 breaks some happy-dom tests — that's an environment mismatch, not a real failure.
- **pnpm** at the version pinned in `packageManager` (via Corepack; Renovate bumps it, so don't hard-code a version). This is a pnpm workspace; **do not use npm**.
- Install with `pnpm install`. All pnpm settings live in **`pnpm-workspace.yaml`**, not `.npmrc` — pnpm reads only auth/registry keys from `.npmrc` and silently ignores the rest, so anything put there looks enforced while doing nothing (pnpm 12 does now reject an unknown key in `pnpm-workspace.yaml` itself, with `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`). The hardening block sets a 7-day `minimumReleaseAge`, exact pins, strict engines, and gates package build scripts through `allowBuilds`. `minimumReleaseAgeStrict` and `trustLockfile` are load-bearing for different reasons; the comments in that file are the canonical explanation, so read them before changing anything in the block.

## Common commands

Run from the repo root (they fan out across workspaces via `pnpm -r`):

```bash
pnpm dev            # server (tsx watch) + pwa (vite) in parallel
pnpm test           # all workspace tests
pnpm build          # pwa build (server has no build step — see below)
pnpm test:integration  # sets INTEGRATION=1; runs *.integration.test.ts (needs real Proton creds)
```

Per-workspace (`@doc-scanner/server`, `@doc-scanner/pwa`):

```bash
pnpm --filter @doc-scanner/server test          # vitest run (server)
pnpm --filter @doc-scanner/server run typecheck # tsc --noEmit (main + vendor projects)
pnpm --filter @doc-scanner/pwa run typecheck

# Single file / single test by name — run the vitest binary directly WITH the
# loader (the `test` script does not forward extra args):
cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/drive/client.test.ts
cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run -t "clearCaches"
```

**Server tests need the `NODE_OPTIONS=--import=tsx` loader** (the `test` script sets it; supply it yourself when invoking `vitest` directly). Without it, any test importing the Drive SDK crashes with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (see "tsx runtime" below).

Integration tests (`server/tests/**/*.integration.test.ts`) are `describe.skipIf`-gated on `INTEGRATION=1` and require `PROTON_TEST_EMAIL` / `PROTON_TEST_PASSWORD`. They run single-fork on purpose to share one login (Proton rate-limits repeated logins).

## Required environment

`SESSION_ENCRYPTION_KEY` (32 random bytes, base64 — encrypts Proton session tokens at rest) and `ANTHROPIC_API_KEY` are **both required** or the server exits at startup (`server/src/config.ts`). Others: `DB_PATH`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `INSECURE_COOKIES`. Analyzer settings: `ANALYZER_MODEL` (default `claude-haiku-5-5`), `ANALYZER_EFFORT` (`low|medium|high`, default `medium`), `AUTO_FILE_THRESHOLD` (0.5 to 1, at most two decimals, default `0.80`), `AUTO_FILE_ENABLED` (default `false`). `AUTO_FILE_ENABLED` is off on purpose: auto-filing is switched on later from real-use audit data, not eval data. All four can be overridden by values saved through `/api/settings`. Queued documents are stored AES-GCM-encrypted in `<dirname(DB_PATH)>/inbox` (in Docker, `/data/inbox`, on the persisted volume). Optional error reporting to GlitchTip (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, build-time `SENTRY_BROWSER_DSN`) is off when unset; `docs/observability.md` covers it, including what the `beforeSend` scrubbers must never let through. Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## The tsx runtime (important, non-obvious)

The server runs its TypeScript **source** under `tsx` in dev, prod, and Docker (`node --import tsx server/src/index.ts`) — there is intentionally **no compiled `dist/`** and no server `build` script. Reason: `@protontech/drive-sdk`'s peer `@protontech/crypto` ships raw `.ts` source with no compiled JS, and plain `node` refuses to type-strip `.ts` under `node_modules`. tsx's esbuild loader compiles it on demand. Consequences to remember:

- The server `tsconfig.json` sets `allowImportingTsExtensions: true`; `src/types/protontech-crypto-shims.d.ts` declares `Uint8Array.toHex` (a TC39 method the peer uses; the runtime polyfill is `src/polyfills/typed-array-base64.ts`, **not** core-js — don't delete it).
- Migrations load from `src/migrations` relative to `import.meta.url`, so running source directly is required; the Docker image copies `server/src` (+ `server/node_modules` for the tsx symlink), not a build output.

## Architecture

**Monorepo:** `server/` (Hono HTTP API on Node's built-in `node:sqlite`) and `pwa/` (Preact 11 + Vite). Same-origin REST behind an HttpOnly session cookie; the server also serves the built PWA when `PWA_DIST_PATH` is set.

### Server (`server/src/`)

- **Auth (`auth/`)** — `ProtonAuth.login` runs Proton's SRP handshake (via the vendored code), then fetches and decrypts the user's PGP user key and every active address key (`keys.ts`). Sessions are AES-GCM-encrypted at rest in SQLite (`session-store.ts`); a `LiveSession` holding the decrypted keys + a constructed `DriveClient` lives in-process for the cookie's lifetime (`live-session.ts`).
- **Drive (`drive/`)** — a **ports-and-adapters** integration with `@protontech/drive-sdk`. `DriveClient` (`client.ts`) is a thin facade that constructs `ProtonDriveClient` by injecting ~6 adapters we own: `DriveAccount` (exposes decrypted keys — note `keys[].id` is the address *key* ID, not the address ID), `DriveHttpClient` (fetch + 401-refresh-and-replay), `DriveSrpModule`, `EntitiesCache` (SQLite, encrypted), `CryptoCache` (memory-only — decrypted key material must never touch disk), `EventIdStore`, plus an OpenPGP crypto module (`crypto-module.ts`, an `openpgp`-backed CryptoProxy shim). **Keep `client.ts` thin** — it's the re-port surface when the SDK bumps.
- **DB (`db.ts`)** — `node:sqlite` `DatabaseSync`; forward-only numbered SQL migrations in `migrations/` applied on open.
- **Analyzer (`analyze/`)** — the Claude call (structured outputs). The model sees short folder IDs, not Drive UIDs; `resolve.ts` maps its answer back and clamps confidence. The auto-file threshold is printed into the prompt. Offline eval harness in `server/evals/analyzer/`; `--approve-harness` on `run-eval.mjs` is the user's step, never pass it yourself.
- **Documents (`documents/`)** — a `documents` table (`repo.ts`) driven by one in-process worker (`worker.ts`) through `received → analyzing → preparing → ready → (filing | needs_review | awaiting_login) → filed`, with stages in `stages/` and `pipeline.ts` wiring it from config. Every transition is a compare-and-set; working states re-run safely after a crash. A stage that fails 3 times moves the document to `failed` and reports it (see `docs/observability.md`). Originals wait in the encrypted `inbox-store.ts`. The repo seals each row's names, paths, analysis, decision, review reason and error (AES-GCM, bound to row id and column); a row that won't decrypt is quarantined to `failed`, never thrown into the worker loop. An unusable analysis (refused, truncated, invalid) also goes through `preparing`, so its card has a thumbnail, and `decide` then sends it to review with the analyzer's reason. A retry resumes at `preparing` for an analysed row. Filing sends the prepared blob only when the row records `preparedMime` and the blob exists.
- **Prepare (`prepare/`)** — `ocrmypdf --skip-text` makes image-only PDFs searchable (a sidecar holding only `[OCR skipped…]` means born-digital, so the original is kept; exit 8, or exit 2 with a signature or dynamic-XFA error, means protected, also kept; exit 3 is a missing tool). `img2pdf` turns document photos (`isDocument: true`) into PDFs first (an image it refuses, such as a 16-bit PNG, is retried once as a JPEG through `sharp`); Ghostscript (bounded to a fixed box with `-dFIXEDMEDIA -dPDFFitPage`) and `sharp` make the 400 px thumbnail. The fallback rule: a tool missing, failing or timing out (OCR 5 min, img2pdf 60 s, thumbnail 30 s) files the **original** with a `prepare_note`; a text layer is never worth losing a document. Safety: no shell, fixed argument lists, a mode-0700 temp directory per job that is also the tool's `TMPDIR` and is always removed, a sweep of leftover ones (lstat, never following symlinks): every one at server startup, when no job can be running (`createPrepareTools({ atStartup: true })` in `index.ts`), and ones older than 10 minutes before every job, a process-group kill on timeout, an allowlisted tool environment (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `OMP_THREAD_LIMIT`) so server secrets never reach them, tool output never logged, and a content check before any parsing (a PDF must start with `%PDF-` at byte 0, because Ghostscript runs a file as PostScript whenever `%!` comes before `%PDF-`, even after junk, a BOM or a NUL, img2pdf input must match its declared type's magic bytes, sharp input must sniff as jpeg, png, webp, tiff, gif or heif; anything else, such as PostScript (or a PostScript/PDF polyglot) named as PDF or SVG named as an image, runs no tool and the original is filed). A row with `filingTarget` set skips preparing and keeps its recorded blobs and fields, so the file stage's SHA-1 dedupe still finds an earlier upload; every other run first clears `preparedMime`, `prepareNote` and `hasThumbnail`, so a crashed run's leftovers are never filed or served. Restore sends an analysed document whose discard won during preparing (`preparedMime` null, no `filingTarget`) back through `preparing`, and `decideStage` keeps any recorded `reviewReason`, so a restored document is always reviewed. If `imageToPdf` fails or times out the note is "Could not turn the photo into a PDF." The decide log never carries the analyzer's detail. The tools are optional in development (`brew install ocrmypdf img2pdf`; without them preparation falls back with a note) and unit tests use fakes. The worker is single-threaded, so one long OCR job (up to 5 minutes, about 5 s per noisy page on 2 cores) blocks the queue. The tools add about 319 MB to the image (883 vs 564 MB). `server/scripts/smoke-prepare.ts` exercises the real tools in the built image; CI runs it on every image build (both architectures), and the container must run with an init (`--init`, or tini as in production) so killed tools are reaped.
- **Settings (`settings/`)** — effective settings are env defaults overridden by values saved in `app_settings` (`filing.*` keys).
- **Crypto (`crypto/at-rest.ts`)** — `AtRestCipher`, AES-256-GCM with a per-purpose HKDF subkey of `SESSION_ENCRYPTION_KEY` (`inbox`, `folder-cache`, `documents`); optional associated data binds a value to where it is stored.
- **HTTP (`http/`)** — Hono routes + session middleware; `routes-documents.ts` serves `/api/documents`, `/api/folders` and `/api/settings`.
- **Vendor (`vendor/proton-srp/`)** — a pinned MIT subset of Proton's SRP/crypto. Never edited or auto-updated (Renovate-blocked); re-vendoring is manual. Has its own tsconfig project.

### PWA (`pwa/src/`)

`documents/` (the documents API client, `DocumentSync` polling `GET /api/documents?since=`, pure grouping and folder search), `ui/inbox/` (the home screen: review cards, folder picker, activity rows) and `ui/SettingsScreen.tsx` (filing settings, folder refresh, theme, sign-out); `uploads/` (an IndexedDB upload queue, see below), `scanner/` (camera capture + auto-crop), `pdf/` (`@cantoo/pdf-lib`: image-only PDFs from scans, no text layer, loaded on demand), the rest of `ui/`, `theme/`; `api.ts` talks to the server; local state via `idb`. There is no on-device OCR; the server reads the page images.

**Upload queue (`uploads/`).** `UploadQueue` (owned by `App`, started after sign-in, stopped at sign-out) sends one file at a time with XMLHttpRequest, for progress. A file over 50 MiB minus 64 KiB (`MAX_UPLOAD_BYTES`) fails at once, unsent. Transient failures (network, timeout, 408, 409, 429, 5xx, and a 2xx that isn't the server's answer, `bad_response`) retry after 5 s, 15 s, 60 s, then every 5 min, and nothing is sent while `navigator.onLine` is false; the `online` event makes everything queued due at once. Permanent ones (413, 400, a file that can't be read, checked by reading its first byte before each send) stop as `failed` and wait for the user. A 401 pauses the queue until the next `start()`, except a 401 for an upload begun in an earlier session, which is ignored and sent again. Scans enter as image-only PDFs named by the scan's own `createdAt` (deterministic bytes, so the server's duplicate check catches a double send); the local scan is deleted once the server accepts it, before the queue forgets the upload. A failed PDF build is kept on the queue (`buildErrorOf`), so the scan's row says why. After sign-in `App` also imports the PDF builder chunk so the service worker caches it, and a scan finished offline can still be built. On a device's first visit that import runs before the service worker controls the page, so `sw-warm.ts` fetches the hashed chunks already loaded again on the first `controllerchange`, for the worker to cache. In the inbox, the **Add** button and drops anywhere on the window (a window-level listener, so the browser never opens a dropped file) feed the queue, an **Uploading** section shows progress, and **Scans on this device** offers finished scans not sent yet (saved before on-device OCR was retired, or left by a failed PDF build), each with Send to inbox or Delete. Nothing uploads without the user choosing it. Queued files stay in IndexedDB, unencrypted, after sign-out, and the next sign-in on the device sends them (acceptable for a single-user app).

**Preact 11 effect timing.** `useEffect` cleanups run after paint. A mounted guard or a listener that must stop at unmount uses `useLayoutEffect`.

## Drive SDK version gate (read before bumping)

`@protontech/drive-sdk` + `@protontech/crypto` are pinned, grouped into their own PR, and **never automerged** in `renovate.json` — each 0.x minor can carry breaking API changes (0.17 unwrapped node returns and made `NodeEntity.name` a `Result`; 0.19 added `SRPModule.generateKeySalt` and retyped `SessionKey`; 0.20 renamed the sharing surface public-link → URL-access and unwrapped `NodeEntity.activeRevision`). On any bump, re-run typecheck against `drive/{client,srp-module,crypto-module}.ts` and re-verify tests. The `renovate.json` note documents the current state.

Renovate opens these PRs on its own — the `dependencyDashboardApproval` gate was dropped 2026-08-03 because every break of this kind is a compile error that CI's `tsc --noEmit` already catches, so the manual tick delayed PR *creation* without adding detection. A human still merges. The risk that remains is a change that typechecks but behaves differently, which only reading the diff catches — so read the diff.

## Conventions

- **Conventional Commits** with scopes (`feat(drive):`, `fix(...)`, `test(...)`, `chore(renovate):`). Prefer **atomic commits** (split logically distinct changes even when developed together). Commits are signed.
- PRs are **squash-merged** to `main` (the squash title becomes the commit, so give the PR a conventional-commit title). Merge commits are disabled.
- Docs live in `docs/superpowers/{specs,plans,notes}/` (dated design specs and implementation plans); consult them for feature intent and history.
