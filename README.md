# doc-scanner

A personal-use, self-hosted PWA for scanning paper documents from a phone camera and uploading them to Proton Drive. The server is a small TypeScript service that authenticates against Proton's SRP flow on the user's behalf and proxies end-to-end-encrypted uploads through the official Proton Drive SDK.

> **Status:** Proton SRP login with encrypted-at-rest sessions, Drive upload through `@protontech/drive-sdk`, and the camera scanner (auto-capture and crop) are on `main`. Work now follows the AI document filing design ([spec](docs/superpowers/specs/2026-10-09-ai-document-filing-design.md)), in slices. Slice 1, the server pipeline (Claude Haiku suggests a filename and folder; auto-filing is off for now), and slice 2, the review UI, are merged (#261, #263). Slice 4, entrypoints, adds an offline upload queue, adding files from the inbox by picker or drag and drop, and scans sent as image-only PDFs. Slice 3, preparing, is done: the server makes image-only PDFs and document photos searchable with `ocrmypdf` and renders a first-page thumbnail for the review card, falling back to the original file if a tool is missing, fails or times out. On-device OCR (Tesseract) did not work on iOS Safari and is retired. The OCR tools add about 319 MB to the Docker image (883 vs 564 MB). For local development they are optional: `brew install ocrmypdf img2pdf`, otherwise documents are filed without a text layer. The app isn't deployed anywhere yet. CI publishes a multi-arch image to `ghcr.io/owine/doc-scanner` (`main`, `sha-<full commit sha>`) on every push to `main`, once the tests and the OCR smoke test pass. Publishing a `vX.Y.Z` GitHub Release retags that same image, without rebuilding it, as `X.Y.Z`, `X.Y`, `X` and `latest` (the floating tags only move forward, to the newest release). release-drafter keeps the next release's notes as a draft; publishing it cuts the release.

## Quickstart

Prerequisites: Node.js at the exact version pinned in `.nvmrc` and pnpm (the version pinned in the `packageManager` field, via Corepack). `engineStrict` is on, so `pnpm install` fails on any other Node version.

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

For a containerised run, `docker compose pull && docker compose up -d` runs the newest release (`ghcr.io/owine/doc-scanner:latest`, amd64 and arm64). Set `DOC_SCANNER_TAG` to hold a series (`1` or `1.0`) or one release (`1.0.0`), to `main` to follow every push to `main`, or to `sha-<full commit sha>` for a single build. Without the `pull`, `up` keeps a tag it already has. The package is private, so run `docker login ghcr.io` once on the host with a token that has `read:packages`. To build from this checkout instead, add the overlay: `docker compose -f compose.yml -f compose.build.yml up -d --build`. Compose reads `.env` for interpolation. The container serves the built PWA from the server on `127.0.0.1:3000`, has a healthcheck on `/api/health`, and persists the database and inbox under `./data` (mounted at `/data`, where the image points `DB_PATH`).

For production, put a reverse proxy in front that terminates HTTPS (the session cookie is `Secure`, and the camera and service worker need a secure context) and accepts 50 MB request bodies (nginx's default of 1 MB rejects most scans). Back up `./data` together with `SESSION_ENCRYPTION_KEY`: the queued files, sessions and each document's names, paths and analysis are encrypted with keys derived from it, so without the key they can't be read. Some metadata, such as sizes, hashes, MIME types, states and timestamps, is stored in plain text. Run one container only; the document worker and live Proton sessions are in-process.

With Authelia in front, set `AUTH_PROXY_USER` to your Authelia username (header mode). A restart then keeps you signed in, and filing pauses until you tap **Unlock** with a passkey (add one in Settings → Passkeys: an iCloud Keychain passkey on iOS 18.4 or later, or 1Password) or sign in to Proton again. Header mode trusts `Remote-User`, so: keep the container port unpublished, with the proxy on a shared Docker network; or, if the port is published (including the `127.0.0.1:3000` in `compose.yml`), set `AUTH_PROXY_SECRET` and have the proxy send it as `X-Doc-Scanner-Proxy-Secret` on every request. Either way, the proxy must overwrite or strip any client-supplied `Remote-User` on every route to the app, including Authelia `bypass` rules.

The proxy must pass Authelia's `Remote-User` response header on to the app. In Traefik, list it in the ForwardAuth middleware's `authResponseHeaders: Remote-User`. In nginx, copy it from the `auth_request` answer with `auth_request_set $user $upstream_http_remote_user;` and `proxy_set_header Remote-User $user;`. The proxy adds the secret to every request the same way: in Traefik, a `headers` middleware with `customRequestHeaders` setting `X-Doc-Scanner-Proxy-Secret`; in nginx, `proxy_set_header X-Doc-Scanner-Proxy-Secret <secret>;`. A request that names a `Remote-User` the app refuses logs a warning, at most once a minute, saying only why (`user mismatch`, `secret missing` or `secret mismatch`).

Passkeys belong to the app's hostname. If the hostname changes, the passkeys stop working and must be added again in Settings → Passkeys. When Authelia's session expires, the app says "Your sign-in has expired." and offers **Reload**, which goes through Authelia's sign-in again.

The repo is a pnpm workspace (`pnpm-workspace.yaml`) with two packages:

- `server/` (`@doc-scanner/server`) is a Hono HTTP API in TypeScript, using Node's built-in `node:sqlite` for storage (forward-only SQL migrations applied on open). It runs from TypeScript source under `tsx` in dev and in production, with no compiled `dist/`. `@protontech/crypto`, a peer of the Drive SDK, ships raw `.ts` files that plain `node` refuses to load from `node_modules`. When `PWA_DIST_PATH` is set, the server also serves the built PWA.
- `pwa/` (`@doc-scanner/pwa`) is a Preact + Vite PWA covering camera capture and auto-crop (jscanify), an upload queue for added files and scans, image-only PDF assembly (`@cantoo/pdf-lib`), and local scan storage in IndexedDB (`idb`).

## Environment variables

`.env.example` lists the variables for local and Compose runs:

| Variable                 | Purpose                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_ENCRYPTION_KEY` | **Required.** 32 random bytes, base64-encoded. Encrypts Proton session tokens at rest.                                                       |
| `ANTHROPIC_API_KEY`      | **Required** at startup. Used by the document analyzer (Claude Haiku 5.5 by default; about $0.003 per document).                             |
| `ANALYZER_MODEL`         | Model the analyzer calls (default `claude-haiku-5-5`).                                                                                       |
| `ANALYZER_EFFORT`        | Analyzer reasoning effort: `low`, `medium` (default) or `high`. Limited to these three as a cost guard.                                      |
| `AUTO_FILE_THRESHOLD`    | Minimum analyzer confidence, 0.5 to 1 with at most two decimals (default `0.80`), for a document to be filed without review.                 |
| `AUTO_FILE_ENABLED`      | Default `false`: every document goes to review. Turn on only once real use shows the unchanged-approval rate is high enough at the threshold. |
| `DB_PATH`                | Path to the SQLite database file (default `./data/app.db`, relative to the server's working directory).                                      |
| `PORT`                   | HTTP port the server listens on (default `3000`).                                                                                            |
| `LOG_LEVEL`              | Pino log level: `debug`, `info` (default), `warn`, or `error`.                                                                               |
| `TRUST_PROXY`            | Parsed as a boolean (default `true`), but no code reads it yet.                                                                              |
| `INSECURE_COOKIES`       | Default `false`. Set `true` **only** for local `http://` development: it drops the `Secure` flag from the session cookie. Deployments must use HTTPS. |
| `AUTH_PROXY_USER`        | Optional. Your Authelia username. It turns on header mode: the proxy's `Remote-User` signs requests in, so a restart doesn't sign you out, and a passkey can unlock filing. Unset, the app uses its own sign-in cookie. |
| `AUTH_PROXY_SECRET`      | Optional, at least 32 characters, and only with `AUTH_PROXY_USER`. Needed when the port is published (as `compose.yml` does on `127.0.0.1`); the proxy sends it as `X-Doc-Scanner-Proxy-Secret`. |
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
