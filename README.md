# doc-scanner

A personal-use, self-hosted PWA for scanning paper documents from a phone camera and uploading them to Proton Drive. The server is a small TypeScript service that authenticates against Proton's SRP flow on the user's behalf and proxies end-to-end-encrypted uploads through the official Proton Drive SDK.

> **Status:** Phases 1–4 are merged to `main`: Proton SRP login with encrypted-at-rest sessions, Drive upload via `@protontech/drive-sdk`, the camera scanner pipeline (auto-capture + crop), and client-side OCR with searchable-PDF assembly. The client-side Tesseract OCR from Phase 4 doesn't work on iOS Safari, so **Phase 5** replaces it with server-side Claude Haiku vision that OCRs a scan and suggests a filename and folder in one call. It also adds confirm-and-upload and an offline outbox. Phase 5 is designed ([spec](docs/superpowers/specs/2026-05-08-phase-5-ai-organize-design.md), [plan](docs/superpowers/plans/2026-05-08-phase-5-ai-organize.md)) and partly built on the unmerged `phase-5-ai-organize` branch, but none of it is on `main` yet. The app isn't deployed anywhere yet. CI builds the Docker image but doesn't push it.

## Quickstart

Prerequisites: Node.js `24.21.0` (pinned in `.nvmrc`) and pnpm `12.6.0` (the `packageManager` field, via Corepack). `engineStrict` is on, so `pnpm install` fails on any other Node version.

```bash
fnm use                 # or: nvm use (reads .nvmrc)
corepack enable         # provides the pinned pnpm
pnpm install
cp .env.example .env
# fill in SESSION_ENCRYPTION_KEY and ANTHROPIC_API_KEY;
# set INSECURE_COOKIES=true for local http:// development
set -a; . ./.env; set +a  # the server doesn't read .env itself; export it into the shell
pnpm run dev
```

`pnpm run dev` starts the server (`tsx watch`, port `3000`) and the Vite dev server (port `5173`, which proxies `/api` to `:3000`) in parallel. Open `http://localhost:5173`.

Other root scripts, which fan out to both workspaces with `pnpm -r`:

| Script                  | Runs                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm test`             | Vitest in both workspaces.                                                                        |
| `pnpm build`            | The PWA production build (`tsc && vite build`). The server has no build step; see below.         |
| `pnpm test:integration` | The server's `*.integration.test.ts` files against a real Proton account, with `INTEGRATION=1` set. Needs credentials; see below. |

The integration tests share one login in a single fork, because Proton rate-limits logins:

```bash
PROTON_TEST_EMAIL=... PROTON_TEST_PASSWORD=... pnpm test:integration
```

For a containerised run, `docker compose up --build` reads `.env` for interpolation, serves the built PWA from the server on port `3000`, and persists the database under `./data` (mounted at `/data`, where the image points `DB_PATH`).

The repo is a pnpm workspace (`pnpm-workspace.yaml`) with two packages:

- `server/` (`@doc-scanner/server`) is a Hono HTTP API in TypeScript, using Node's built-in `node:sqlite` for storage (forward-only SQL migrations applied on open). It runs from TypeScript source under `tsx` in dev and in production, with no compiled `dist/`. `@protontech/crypto`, a peer of the Drive SDK, ships raw `.ts` files that plain `node` refuses to load from `node_modules`. When `PWA_DIST_PATH` is set, the server also serves the built PWA.
- `pwa/` (`@doc-scanner/pwa`) is a Preact + Vite PWA covering camera capture and auto-crop (jscanify), OCR (Tesseract.js, being replaced in Phase 5), searchable PDF assembly (`@cantoo/pdf-lib`), and local scan storage in IndexedDB (`idb`).

## Environment variables

`.env.example` lists the variables for local and Compose runs:

| Variable                 | Purpose                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_ENCRYPTION_KEY` | **Required.** 32 random bytes, base64-encoded. Encrypts Proton session tokens at rest.                                                       |
| `ANTHROPIC_API_KEY`      | **Required** at startup. Used by the document analyzer (Claude Haiku 5.5 by default; about $0.003 per document).                             |
| `ANALYZER_MODEL`         | Model the analyzer calls (default `claude-haiku-5-5`).                                                                                       |
| `ANALYZER_EFFORT`        | Analyzer reasoning effort: `low`, `medium` (default) or `high`. Limited to these three as a cost guard.                                      |
| `AUTO_FILE_THRESHOLD`    | Minimum analyzer confidence, 0 to 1 with at most two decimals (default `0.80`), for a document to be filed without review.                   |
| `AUTO_FILE_ENABLED`      | Default `false`: every document goes to review. Turn on only once real use shows the unchanged-approval rate is high enough at the threshold. |
| `DB_PATH`                | Path to the SQLite database file (default `./data/app.db`, relative to the server's working directory).                                      |
| `PORT`                   | HTTP port the server listens on (default `3000`).                                                                                            |
| `LOG_LEVEL`              | Pino log level: `debug`, `info` (default), `warn`, or `error`.                                                                               |
| `TRUST_PROXY`            | Parsed as a boolean (default `true`), but no code reads it yet.                                                                              |
| `INSECURE_COOKIES`       | Default `false`. Set `true` **only** for local `http://` development: it drops the `Secure` flag from the session cookie. Deployments must use HTTPS. |
| `SENTRY_DSN`             | Optional server-side error reporting to GlitchTip. Disabled when unset. See [`docs/observability.md`](docs/observability.md).               |
| `SENTRY_ENVIRONMENT`     | Optional environment tag, used in two places. At runtime it tags server events. Compose also passes it as a Docker **build** arg, which compiles it into the PWA bundle as the browser's environment tag. |
| `SENTRY_BROWSER_DSN`     | Optional. A Docker **build** arg that compiles the browser DSN into the PWA bundle. See [`docs/observability.md`](docs/observability.md).    |

`PWA_DIST_PATH` is also read. It points the server at the built PWA, and `compose.yml` sets it for the container, so you normally don't set it yourself.

Generate a session key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Vendored Proton SRP code

Proton's web clients implement a custom SRP (Secure Remote Password) flow that the public account API requires. To authenticate against it, this project vendors a small subset of Proton's open-source SRP implementation into `server/src/vendor/proton-srp/`. That code is licensed under the **MIT License** and carries upstream copyright. The vendored directory contains its own `LICENSE` and `README.md` attributing the original authors. Renovate is configured (`renovate.json`) to never auto-update files under `server/src/vendor/**`, so re-vendoring is a manual operation.

## License

This project is for personal use and is not currently published under a license. Vendored third-party code keeps its original (MIT) license. See `server/src/vendor/proton-srp/LICENSE`.
