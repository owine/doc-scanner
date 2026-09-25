# Observability

The server logs structured JSON to stdout (Pino) and, when configured, reports exceptions to a Sentry-compatible endpoint (self-hosted GlitchTip) with `@sentry/hono` / `@sentry/node`. The PWA reports through `@sentry/browser`. Both are optional: with no DSN nothing initializes and the app behaves exactly as it does without error reporting.

The failure this exists for: **a scan that fails to upload to Proton Drive is a lost document.**

## Environment variables

All optional.

| Var | Where | Purpose | Default |
|---|---|---|---|
| `SENTRY_DSN` | server, runtime | Server-side GlitchTip DSN. Init is skipped when unset or empty. | unset |
| `SENTRY_ENVIRONMENT` | server runtime **and** Docker build arg | Environment tag on events (`production`, `staging`, …). | `NODE_ENV`-derived on the server (`production` / `development`); the Vite mode in the PWA |
| `SENTRY_RELEASE` | server, runtime | Release tag. **Set by the image**: the Dockerfile copies the `GIT_SHA` build arg into it. The literal `dev` (the Dockerfile default) is ignored. | `GIT_SHA` |
| `SENTRY_BROWSER_DSN` | Docker build arg | Browser DSN, compiled into the PWA bundle as `VITE_SENTRY_DSN`. Use a **separate GlitchTip project** from the server. A browser DSN is public by design (it ships in the JS), so a build arg is fine. | unset |
| `GIT_SHA` | Docker build arg | Release for both sides. CI already passes it. For local compose builds: `GIT_SHA=$(git rev-parse HEAD) docker compose build`. | `dev` |
| `VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE` | PWA build, outside Docker | What the Docker build args turn into. Set them directly for `pnpm --filter @doc-scanner/pwa build` (shell env or `pwa/.env.local`). | unset |

The browser DSN is **build-time**: changing it means rebuilding the image. That's fine while every deploy builds from source (`compose.yml` uses `build: .`). If the image is ever published to GHCR and shared between environments, switch to runtime injection (the server hands the DSN to the page, as house-manager does with `SENTRY_BROWSER_DSN`), so one image doesn't carry one environment's DSN.

## Where to set them

doc-scanner isn't deployed yet: CI builds the image but doesn't push it, and no stack in `docker-piwine` / `docker-piwine-office` / `docker-zendc` runs it. Until it is:

- **This repo's `compose.yml`** reads all of the above from `.env` (see `.env.example`).
- **When it moves to a homelab stack**, follow house-manager's convention: add `DOCSCANNER_SENTRY_DSN` (and a `DOCSCANNER_SENTRY_BROWSER_DSN` build arg) to that host's `compose.env` and map them in the stack's `compose.yaml`. That also needs CI to start pushing an image, which is its own change.

## What gets reported

| Source | Event | Tags |
|---|---|---|
| Hono (`@sentry/hono` middleware) | Any unhandled route error (5xx / thrown `Error`). Handled 4xx responses are not reported. | route as the transaction name |
| `DriveClient.uploadFile` | Failure resolving the root folder / a free name | `drive.operation: folder-lookup` |
| `DriveClient.uploadFile` | Failure creating the uploader, uploading, or completing | `drive.operation: upload` |
| `DriveClient` HTTP adapter | Access-token refresh failed. The SDK still gets the original 401, as before; this was previously invisible. | `drive.operation: session-refresh` |
| `ProtonAuth.login` | Login failed for a reason **other than** a wrong password (Proton code `8002`), a missing TOTP, or a TOTP rejected by the 2FA step. Covers outages, rate limiting, auth-version changes and key setup. | `auth.operation: login`, `auth.stage: info \| srp \| 2fa \| keys` |
| PWA `request(…, { reportAs })` | Network failure or 5xx on a request that opted in. Opt-in, because only a lost upload is worth hearing about, and a phone going offline would otherwise report every call. | `api.operation`, `api.path`, `api.failure: network \| http`, `api.status`, `network.online` |

**No PWA endpoint opts in yet.** The scan upload call doesn't exist until Phase 5 (plan Task 14). When it lands, it must pass `reportAs: 'upload'`. Server-side, the Phase 5 upload route goes through `DriveClient.uploadFile`, so it is covered already.

A failure reported by `DriveClient` and then rethrown through a route produces **one** event: the SDK marks a captured error and drops a second capture of the same object.

## What is never sent

Enforced by a `beforeSend` scrubber in each workspace (`server/src/observability/scrub.ts`, `pwa/src/observability/scrub.ts`; keep them in step). Each category below has a test that plants a value and asserts it appears nowhere in the serialized event.

- **Request bodies.** `request` keeps only `method` and the URL **without** its query string.
- **Cookies and auth headers.** All request headers are dropped, including `authorization`, `cookie`, `x-pm-uid` and `remote-user`.
- **Proton session tokens and credentials.** Values under keys matching token / password / session / uid / mailbox / key / salt / email / … are redacted wherever they appear in `extra`, custom contexts and breadcrumbs. `Bearer …` in free text is redacted.
- **File contents.** Binary values (`Uint8Array`, `ArrayBuffer`, `Blob`) and `data:` URLs are replaced. The upload path never hands the bytes to the reporter.
- **Filenames and document names.** Filename-shaped strings are redacted in exception messages. `DriveClient` also redacts the exact document name it was given, since the SDK can echo it unquoted.
- **User data.** `event.user` is dropped and `sendDefaultPii` is off, so no IP address is sent.
- **Local variables.** `includeLocalVariables` is off, and any `vars` on stack frames are dropped.
- **Console and form-input breadcrumbs.** Dropped outright. Other breadcrumbs keep only method / URL (no query) / status.

Tracing is off (`tracesSampleRate: 0`), and there is no session replay.

## Source maps

**Not uploaded.** GlitchTip's docs (6.x) document source-map upload only through its own `glitchtip-cli` (beta). They don't claim support for `@sentry/vite-plugin`, so it isn't wired in. Browser stack traces from the minified bundle will point at `assets/index-*.js`. If readable browser traces become necessary, evaluate `glitchtip-cli sourcemaps inject/upload` in the Docker build, with its token as a BuildKit secret (`RUN --mount=type=secret,…`), never a build arg.

## Setting up GlitchTip

1. Create two projects in GlitchTip: one for the server (platform Node), one for the PWA (platform Browser JavaScript).
2. Put the server project's DSN in `SENTRY_DSN` and the PWA project's DSN in `SENTRY_BROWSER_DSN`.
3. Rebuild the image (the browser DSN is compiled in) and restart: `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build`.
4. To check it end to end, stop Proton access from the container, or point the server at a bad Proton host, and try `POST /api/drive/test-upload`. A `drive.operation` event should appear.

## Implementation notes

- `server/src/instrument.ts` is the **first import** of `server/src/index.ts`. ES modules evaluate in import order, so Sentry initializes before any other app module.
- `registerEsmLoaderHooks: false`: the hooks exist to auto-instrument imports for tracing, which is off. Leaving them on would put `import-in-the-middle` between tsx and the Drive SDK's raw-`.ts` crypto peer for no benefit.
- Unhandled promise rejections still **crash** the server with a DSN set (`onUnhandledRejectionIntegration({ mode: 'strict' })`). The SDK's default `warn` mode only logs, which would silently swallow what Node 24 treats as fatal. `tests/observability/process-crash.test.ts` checks both cases in a child process.
- The Hono middleware is mounted in `createApp` only when Sentry is initialized, because it `console.warn`s on every `createApp` otherwise.
- The PWA SDK adds about 29 KB gzipped to the entry chunk even with no DSN (a static import). Lazy-loading it when a DSN is present would remove that, at the cost of async init and missing errors from before it loads.
