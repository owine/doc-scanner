# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal-use, self-hosted PWA for scanning paper documents from a phone camera and uploading them to Proton Drive. A phone-facing Preact PWA captures/crops pages; a small TypeScript server authenticates against Proton's SRP flow on the user's behalf and proxies **end-to-end-encrypted** uploads through the official Proton Drive SDK.

> The root `README.md` is stale (it describes a pre-implementation Phase 1 on Node 20 / npm / better-sqlite3). Trust the code and this file, not the README, for stack and status.

## Toolchain (strict)

- **Node `24.18.1`** (pinned in `.nvmrc`, enforced by `engineStrict` — `pnpm install` **fails** on any other version). Run `fnm use` / `nvm use` first. Node 26 breaks some happy-dom tests — that's an environment mismatch, not a real failure.
- **pnpm `11.18.0`** via Corepack. This is a pnpm workspace; **do not use npm**.
- Install with `pnpm install`. All pnpm settings live in **`pnpm-workspace.yaml`**, not `.npmrc` — pnpm 11 reads only auth/registry keys from `.npmrc` and silently ignores the rest, so anything put there looks enforced while doing nothing. The hardening block sets a 7-day `minimumReleaseAge`, exact pins, strict engines, and gates package build scripts through `allowBuilds`. `minimumReleaseAgeStrict` and `trustLockfile` are load-bearing for different reasons; the comments in that file are the canonical explanation, so read them before changing anything in the block.

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

`SESSION_ENCRYPTION_KEY` (32 random bytes, base64 — encrypts Proton session tokens at rest) and `ANTHROPIC_API_KEY` are **both required** or the server exits at startup (`server/src/config.ts`). Others: `DB_PATH`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `INSECURE_COOKIES`. Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## The tsx runtime (important, non-obvious)

The server runs its TypeScript **source** under `tsx` in dev, prod, and Docker (`node --import tsx server/src/index.ts`) — there is intentionally **no compiled `dist/`** and no server `build` script. Reason: `@protontech/drive-sdk`'s peer `@protontech/crypto` ships raw `.ts` source with no compiled JS, and plain `node` refuses to type-strip `.ts` under `node_modules`. tsx's esbuild loader compiles it on demand. Consequences to remember:

- The server `tsconfig.json` sets `allowImportingTsExtensions: true`; `src/types/protontech-crypto-shims.d.ts` declares `Uint8Array.toHex` (a TC39 method the peer uses; the runtime polyfill is `src/polyfills/typed-array-base64.ts`, **not** core-js — don't delete it).
- Migrations load from `src/migrations` relative to `import.meta.url`, so running source directly is required; the Docker image copies `server/src` (+ `server/node_modules` for the tsx symlink), not a build output.

## Architecture

**Monorepo:** `server/` (Hono HTTP API on Node's built-in `node:sqlite`) and `pwa/` (Preact + Vite). Same-origin REST behind an HttpOnly session cookie; the server also serves the built PWA when `PWA_DIST_PATH` is set.

### Server (`server/src/`)

- **Auth (`auth/`)** — `ProtonAuth.login` runs Proton's SRP handshake (via the vendored code), then fetches and decrypts the user's PGP user key and every active address key (`keys.ts`). Sessions are AES-GCM-encrypted at rest in SQLite (`session-store.ts`); a `LiveSession` holding the decrypted keys + a constructed `DriveClient` lives in-process for the cookie's lifetime (`live-session.ts`).
- **Drive (`drive/`)** — a **ports-and-adapters** integration with `@protontech/drive-sdk`. `DriveClient` (`client.ts`) is a thin facade that constructs `ProtonDriveClient` by injecting ~6 adapters we own: `DriveAccount` (exposes decrypted keys — note `keys[].id` is the address *key* ID, not the address ID), `DriveHttpClient` (fetch + 401-refresh-and-replay), `DriveSrpModule`, `EntitiesCache` (SQLite, encrypted), `CryptoCache` (memory-only — decrypted key material must never touch disk), `EventIdStore`, plus an OpenPGP crypto module (`crypto-module.ts`, an `openpgp`-backed CryptoProxy shim). **Keep `client.ts` thin** — it's the re-port surface when the SDK bumps.
- **DB (`db.ts`)** — `node:sqlite` `DatabaseSync`; forward-only numbered SQL migrations in `migrations/` applied on open.
- **HTTP (`http/`)** — Hono routes + session middleware.
- **Vendor (`vendor/proton-srp/`)** — a pinned MIT subset of Proton's SRP/crypto. Never edited or auto-updated (Renovate-blocked); re-vendoring is manual. Has its own tsconfig project.

### PWA (`pwa/src/`)

`scanner/` (camera capture + auto-crop), `ocr/`, `pdf/` (`@cantoo/pdf-lib`), `ui/`, `theme/`; `api.ts` talks to the server; local state via `idb`. Tesseract.js assets are copied in by a `predev`/`prebuild` script.

## Drive SDK version gate (read before bumping)

`@protontech/drive-sdk` + `@protontech/crypto` are pinned and held behind **manual dashboard approval, never automerge** in `renovate.json` — each minor can carry breaking API changes (0.17 unwrapped node returns and made `NodeEntity.name` a `Result`; 0.19 added `SRPModule.generateKeySalt` and retyped `SessionKey`). On any bump, re-run typecheck against `drive/{client,srp-module,crypto-module}.ts` and re-verify tests. The `renovate.json` note documents the current state.

## Conventions

- **Conventional Commits** with scopes (`feat(drive):`, `fix(...)`, `test(...)`, `chore(renovate):`). Prefer **atomic commits** (split logically distinct changes even when developed together). Commits are signed.
- PRs are **squash-merged** to `main` (the squash title becomes the commit, so give the PR a conventional-commit title). Merge commits are disabled.
- Docs live in `docs/superpowers/{specs,plans,notes}/` (dated design specs and implementation plans); consult them for feature intent and history.
