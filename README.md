# doc-scanner

A personal-use, self-hosted PWA for scanning paper documents from a phone camera and uploading them to Proton Drive. The server is a small TypeScript service that authenticates against Proton's SRP flow on the user's behalf and proxies encrypted uploads.

> **Status:** Phase 1 (skeleton + auth) — work in progress. No code yet beyond tooling and configuration. See the [design spec](docs/superpowers/specs/2026-04-27-doc-scanner-design.md) and the [Phase 1 plan](docs/superpowers/plans/2026-04-27-phase-1-skeleton-and-auth.md) for what's intended.

## Quickstart

Prerequisites: Node.js `20.20.2` (see `.nvmrc`).

```bash
nvm use
npm install
cp .env.example .env
# fill in SESSION_ENCRYPTION_KEY and ANTHROPIC_API_KEY
npm run dev
```

The repo is an npm workspace monorepo with two packages:

- `server/` — Hono-based HTTP API (Node.js, TypeScript, SQLite via better-sqlite3)
- `pwa/` — Preact + Vite PWA

Neither workspace exists yet; they land in subsequent Phase 1 tasks.

## Environment variables

See `.env.example` for the full list. Highlights:

| Variable                  | Purpose                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `SESSION_ENCRYPTION_KEY`  | 32 random bytes, base64-encoded. Used to encrypt Proton session tokens at rest.          |
| `ANTHROPIC_API_KEY`       | Used for OCR / document understanding via the Claude API.                                |
| `DB_PATH`                 | Path to the SQLite database file (default `./data/app.db`).                              |
| `PORT`                    | HTTP port the server listens on (default `3000`).                                        |
| `LOG_LEVEL`               | Pino log level (`debug`, `info`, `warn`, `error`).                                       |
| `TRUST_PROXY`             | Set to `true` when running behind a reverse proxy (e.g. for correct client IPs).         |

Generate a session key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Vendored Proton SRP code

Proton's web clients implement a custom SRP (Secure Remote Password) flow that the public account API requires. To authenticate against it, this project vendors a small subset of Proton's open-source SRP implementation into `server/src/vendor/proton-srp/` (added in Phase 1, Task 4). That code is licensed under the **MIT License** and carries upstream copyright. The vendored directory contains its own `LICENSE` and `NOTICE` files attributing the original authors. Renovate is configured (`renovate.json`) to never auto-update files under `server/src/vendor/**`; re-vendoring is a manual operation.

## License

This project is for personal use and is not currently published under a license. Vendored third-party code retains its original (MIT) license — see `server/src/vendor/proton-srp/LICENSE` once present.
