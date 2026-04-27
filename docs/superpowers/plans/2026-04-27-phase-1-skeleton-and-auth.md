# Phase 1: Skeleton + Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo skeleton (Node/Hono server + Vite/Preact PWA + SQLite + Docker), vendor the Proton SRP code, and implement a working email/password (+ optional TOTP) login flow against the real Proton API. Demoable end state: open the PWA in a browser, log in with your real Proton credentials, see a "logged in as <email>" screen, restart the container, refresh the page, still logged in.

**Architecture:** A monorepo with `server/` (Node 20 + Hono + TypeScript + better-sqlite3) and `pwa/` (Vite + Preact + TypeScript) as siblings, plus a root `Dockerfile` (multi-stage) and `compose.yml` for local dev. The server vendors a minimal subset of `@proton/srp` and its `@proton/crypto` dependencies into `server/src/vendor/proton-srp/` (MIT, pinned to a specific WebClients commit SHA, no runtime npm dependency). Proton session tokens are encrypted at rest with AES-GCM and stored in SQLite. The PWA talks to the server over a same-origin REST API behind an HttpOnly session cookie.

**Tech Stack:** Node 20+, TypeScript, Hono, better-sqlite3, pino, Vitest, Playwright, Vite, Preact, Docker. Vendored: `@proton/srp` and minimum `@proton/crypto` helpers from `ProtonMail/WebClients`.

**Reference spec:** `docs/superpowers/specs/2026-04-27-doc-scanner-design.md`

---

## File Structure (locked in before tasks)

```
.
├── compose.yml
├── Dockerfile
├── .dockerignore
├── .gitignore
├── .nvmrc                       # specific patch (e.g. 20.20.2)
├── .npmrc                       # save-exact=true, engine-strict=true
├── package.json
├── package-lock.json            # committed; npm ci in CI/Docker
├── tsconfig.base.json
├── README.md
├── .env.example
├── renovate.json                # Mend Renovate config — auto-PRs for upgrades
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts
│   │   ├── config.ts
│   │   ├── db.ts
│   │   ├── logger.ts
│   │   ├── migrations/
│   │   │   └── 001_initial.sql
│   │   ├── auth/
│   │   │   ├── srp.ts
│   │   │   ├── session-store.ts
│   │   │   └── proton-api.ts
│   │   ├── http/
│   │   │   ├── server.ts
│   │   │   ├── routes-auth.ts
│   │   │   └── middleware.ts
│   │   └── vendor/
│   │       └── proton-srp/   (vendored from WebClients)
│   └── tests/
│       ├── auth/
│       ├── http/
│       └── helpers/
├── pwa/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── public/
│   │   ├── manifest.webmanifest
│   │   └── sw.js
│   ├── src/
│   │   ├── main.tsx
│   │   ├── api.ts
│   │   └── ui/
│   │       ├── App.tsx
│   │       ├── LoginScreen.tsx
│   │       └── StatusScreen.tsx
│   └── tests/
└── docs/superpowers/{specs,plans}/
```

**Decomposition rationale:** auth is split into three tightly-scoped files (`srp.ts` for protocol, `proton-api.ts` for HTTP, `session-store.ts` for persistence) so each can be tested independently and the vendored SRP code is isolated under `vendor/`. HTTP routes are kept thin and delegate to auth modules.

---

## Task 1: Initialize repo skeleton + tooling

**Files:** `.gitignore`, `.nvmrc`, `.npmrc`, `.dockerignore`, `package.json` (root), `tsconfig.base.json`, `README.md`, `.env.example`, `renovate.json`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.log
.env
.env.local
.DS_Store
data/
coverage/
.vite/
playwright-report/
test-results/
```

- [ ] **Step 2: Create `.nvmrc`** containing `20.20.2` (specific patch — bumped by Renovate)

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
.git
.env
.env.local
data
coverage
*.log
docs
```

- [ ] **Step 4: Create root `package.json` with workspaces**

```json
{
  "name": "doc-scanner",
  "private": true,
  "type": "module",
  "workspaces": ["server", "pwa"],
  "scripts": {
    "dev": "npm run dev --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:integration": "INTEGRATION=1 npm run test --workspaces --if-present"
  },
  "engines": { "node": ">=20.20" }
}
```

- [ ] **Step 4b: Create `.npmrc`** so future `npm install <pkg>` writes exact pins, not caret ranges:

```ini
save-exact=true
engine-strict=true
```

- [ ] **Step 5: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 6: Create `.env.example`**

```dotenv
# 32 random bytes, base64-encoded. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
SESSION_ENCRYPTION_KEY=
ANTHROPIC_API_KEY=
DB_PATH=./data/app.db
PORT=3000
LOG_LEVEL=info
TRUST_PROXY=true
```

- [ ] **Step 7: Create minimal `README.md`** documenting quickstart, env vars, and MIT attribution for vendored code.

- [ ] **Step 8: Create `renovate.json`** (recommended config for dependency management — Mend Renovate handles all upgrades):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "config:recommended",
    ":dependencyDashboard",
    ":semanticCommits",
    ":pinDevDependencies",
    "schedule:earlyMondays",
    "group:monorepos",
    "group:recommended"
  ],
  "rangeStrategy": "pin",
  "lockFileMaintenance": { "enabled": true, "schedule": ["before 6am on monday"] },
  "packageRules": [
    {
      "description": "Auto-merge devDependency patch + minor updates after CI passes",
      "matchDepTypes": ["devDependencies"],
      "matchUpdateTypes": ["patch", "minor"],
      "automerge": true
    },
    {
      "description": "Auto-merge type definition updates",
      "matchPackagePatterns": ["^@types/"],
      "automerge": true
    },
    {
      "description": "Group all Hono updates together",
      "matchPackagePatterns": ["^hono$", "^@hono/"],
      "groupName": "hono"
    },
    {
      "description": "Group all Vitest updates",
      "matchPackagePatterns": ["^vitest$", "^@vitest/"],
      "groupName": "vitest"
    },
    {
      "description": "Group all Preact + Vite tooling",
      "matchPackagePatterns": ["^preact$", "^@preact/", "^vite$"],
      "groupName": "preact-vite"
    },
    {
      "description": "Hold major upgrades for manual review",
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "labels": ["dependencies", "major-upgrade"]
    },
    {
      "description": "Pin Docker base images to digest",
      "matchManagers": ["dockerfile"],
      "pinDigests": true
    },
    {
      "description": "Never auto-update vendored Proton SRP code (manual re-vendor only)",
      "matchFileNames": ["server/src/vendor/**"],
      "enabled": false
    }
  ],
  "vulnerabilityAlerts": { "labels": ["security"], "automerge": false },
  "prConcurrentLimit": 5,
  "prHourlyLimit": 2
}
```

NOTE: Enable Renovate at https://github.com/apps/renovate after first push. The Dependency Dashboard issue it opens is the source of truth for all pending updates.

- [ ] **Step 9: Commit**

```bash
git add .gitignore .nvmrc .dockerignore .npmrc package.json tsconfig.base.json README.md .env.example renovate.json
git commit -m "chore: initialize repo skeleton with exact pinning and Renovate config"
```

---

## Task 2: Bootstrap server package

**Files:** `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/{index,config,logger}.ts`, `server/tests/config.test.ts`

- [ ] **Step 1: Create `server/package.json`** with **exact-pinned** versions (no `^`/`~`; Renovate manages bumps):

```json
{
  "name": "@doc-scanner/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/node-server": "2.0.0",
    "better-sqlite3": "12.9.0",
    "hono": "4.12.15",
    "pino": "10.3.1",
    "pino-pretty": "13.1.3",
    "zod": "4.3.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "7.6.13",
    "@types/node": "25.6.0",
    "tsx": "4.21.0",
    "typescript": "6.0.3",
    "vitest": "4.1.5"
  }
}
```

NOTE: Versions above are known-good as of 2026-04-27. If a package has moved when you implement this, prefer the latest patch of the listed minor (Renovate will subsequently bump to the latest). If a major has bumped, treat that as a deliberate decision: consult release notes for breaking changes, especially for `zod` (v3→v4 schema syntax), `vitest`, `vite`, and `pino`.

- [ ] **Step 2: Create `server/tsconfig.json`** extending `../tsconfig.base.json` with `outDir: dist`, `rootDir: src`, `types: [node]`.

- [ ] **Step 3: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts', 'node_modules/**'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `server/src/logger.ts`**

```ts
import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});
```

- [ ] **Step 5: Create `server/src/config.ts`** using Zod schema validating `SESSION_ENCRYPTION_KEY` (must be 32 bytes base64), `ANTHROPIC_API_KEY` (required), `DB_PATH` (default `./data/app.db`), `PORT` (default 3000), `LOG_LEVEL` (enum), `TRUST_PROXY` (boolean string). Export `loadConfig(env)` that throws on invalid input with all issues listed.

- [ ] **Step 6: Create `server/src/index.ts` (minimal — boots Hono with healthcheck)**

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const config = loadConfig();
const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true }));
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'server listening');
});
```

- [ ] **Step 7: Install + verify boot**

```bash
npm install
cd server
SESSION_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
ANTHROPIC_API_KEY=test npx tsx src/index.ts &
sleep 2 && curl -sf http://localhost:3000/api/health && echo " — OK"
kill %1
```

Expected: `{"ok":true} — OK`

- [ ] **Step 8: Write `server/tests/config.test.ts`** with three cases: missing key throws, short key throws, valid env produces parsed config with defaults.

- [ ] **Step 9: Run `cd server && npm test`** — expect 3 passing.

- [ ] **Step 10: Commit**

```bash
git add server/ package-lock.json
git commit -m "feat(server): bootstrap Hono server with config validation and healthcheck"
```

---

## Task 3: SQLite + migrations

**Files:** `server/src/db.ts`, `server/src/migrations/001_initial.sql`, `server/tests/db.test.ts`, `server/tests/helpers/test-db.ts`. Modify `server/src/index.ts`.

- [ ] **Step 1: Create migration `server/src/migrations/001_initial.sql`** with three tables: `schema_version (version PK, applied_at)`, `sessions (id CHECK id=1, encrypted_blob BLOB, email, created_at, updated_at)`, `audit_log (id PK AUTOINCREMENT, timestamp, event, detail JSON, remote_user)`. Index on `audit_log.timestamp`.

- [ ] **Step 2: Create `server/src/db.ts`** that opens better-sqlite3 with WAL journal mode, `synchronous=NORMAL`, `foreign_keys=ON`, and runs all `migrations/NNN_*.sql` files in order, tracking applied versions in `schema_version`. Use a transaction per migration.

- [ ] **Step 3: Create `server/tests/helpers/test-db.ts`** that returns `{ db, cleanup }` using `mkdtempSync` for an isolated temp DB per test.

- [ ] **Step 4: Write `server/tests/db.test.ts`** asserting: tables `sessions`, `audit_log`, `schema_version` exist after open; `MAX(version)` is 1.

- [ ] **Step 5: Run `cd server && npm test`** — expect tests passing.

- [ ] **Step 6: Wire DB into `server/src/index.ts`** — `mkdirSync(dirname(config.DB_PATH))`, then `openDb(config.DB_PATH)`. Add `void db` to suppress unused warning until later tasks.

- [ ] **Step 7: Commit**

```bash
git add server/src/db.ts server/src/migrations/ server/src/index.ts server/tests/
git commit -m "feat(server): add SQLite with migration runner and initial schema"
```

---

## Task 4: Vendor Proton SRP code

**Files:** `server/src/vendor/proton-srp/{README.md,LICENSE,*.ts}`. Modify `server/tsconfig.json`.

- [ ] **Step 1: Identify pinned commit SHA**

```bash
curl -s https://api.github.com/repos/ProtonMail/WebClients/commits/main \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])"
```

Save as `PIN_SHA`.

- [ ] **Step 2: Create vendor directory tree** under `server/src/vendor/proton-srp/` with subdirs `utils/` and `crypto/`.

- [ ] **Step 3: Fetch the SRP package files** from `https://raw.githubusercontent.com/ProtonMail/WebClients/<PIN_SHA>/packages/srp/lib/<file>` for: `srp.ts`, `keys.ts`, `passwords.ts`, `constants.ts`, `interface.ts`, `getAuthVersionWithFallback.ts`, `utils/modulus.ts`, `utils/username.ts`. Save under `server/src/vendor/proton-srp/`.

- [ ] **Step 4: Resolve transitive imports.** Read each vendored file; for every `@proton/*` import path, fetch the source from WebClients and place under `server/src/vendor/proton-srp/crypto/` (for `@proton/crypto/*`), `shared/`, etc. — flattening the path. Rewrite imports in vendored files to relative paths within the vendor tree. Repeat until no `@proton/*` imports remain. Known initial set: `@proton/crypto/lib/bigInteger`, `@proton/crypto/lib/utils`, `@proton/shared/lib/helpers/encoding`, `@proton/utils/mergeUint8Arrays`.

- [ ] **Step 5: Fetch the LICENSE** from WebClients into `server/src/vendor/proton-srp/LICENSE`.

- [ ] **Step 6: Write `server/src/vendor/proton-srp/README.md`** documenting source, pinned SHA, list of vendored files, modifications (only import-path rewrites), and re-vendoring procedure.

- [ ] **Step 7: Add path mapping in `server/tsconfig.json`**

```json
"paths": { "@vendor/proton-srp/*": ["./src/vendor/proton-srp/*"] }
```

- [ ] **Step 8: Smoke-compile**

```bash
cd server && npx tsc --noEmit
```

Expected: clean. Type errors typically mean missing transitive deps — fetch and repeat.

- [ ] **Step 9: Commit**

```bash
git add server/src/vendor/ server/tsconfig.json
git commit -m "vendor: copy @proton/srp + minimal @proton/crypto deps from WebClients@<PIN_SHA>"
```

---

## Task 5: Proton API HTTP client

**Files:** `server/src/auth/proton-api.ts`, `server/tests/auth/proton-api.test.ts`

Pure HTTP transport for Proton's `/auth/v4/*` endpoints. No SRP math here. Sets the `x-pm-appversion` header (per ToS).

- [ ] **Step 1: Write failing test** at `server/tests/auth/proton-api.test.ts` with two cases: (a) `getAuthInfo` POSTs to `/auth/v4/info` with username body and includes the appversion header; parses JSON. (b) Non-2xx response throws `ProtonApiError` with parsed `Error` field.

- [ ] **Step 2: Run `cd server && npm test -- proton-api`** — expect FAIL (module not found).

- [ ] **Step 3: Implement `server/src/auth/proton-api.ts`** — class `ProtonApi` with constructor `(baseUrl, appVersion)`. Methods: `getAuthInfo(username)` POST `/auth/v4/info`, `submitAuth(body)` POST `/auth/v4`, `submit2FA(uid, accessToken, totp)` POST `/auth/v4/2fa` (sends `x-pm-uid` + `Authorization: Bearer`), `refresh(uid, refreshToken)` POST `/auth/v4/refresh`. Private `request<T>` helper sets headers (`content-type`, `accept`, `x-pm-appversion`), parses JSON response, throws `ProtonApiError(message, status, code)` on non-2xx. Export TypeScript interfaces for `AuthInfo` and `AuthResponse`.

- [ ] **Step 4: Run test** — expect 2 passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/proton-api.ts server/tests/auth/proton-api.test.ts
git commit -m "feat(auth): add Proton API HTTP client with x-pm-appversion compliance"
```

---

## Task 6: SRP login module

**Files:** `server/src/auth/srp.ts`, `server/tests/auth/srp.test.ts`, `server/tests/auth/srp.integration.test.ts`

- [ ] **Step 1: Write failing unit test** at `server/tests/auth/srp.test.ts` — single case: `getAuthInfo` returning `Version: 99` causes `ProtonAuth.login` to throw `AuthVersionError`. Note in the test file: full happy-path is integration-only because we lack SRP fixture vectors.

- [ ] **Step 2: Run `npm test -- srp.test`** — expect FAIL.

- [ ] **Step 3: Implement `server/src/auth/srp.ts`** — class `ProtonAuth(api)` with:
  - `login(email, password, totp?)` — calls `getAuthInfo`, validates `Version === AUTH_VERSION` (else `AuthVersionError`), runs vendored SRP to produce `clientEphemeral` + `clientProof`, calls `submitAuth`, if `2FA.Enabled` and no `totp` throws `TwoFactorRequiredError`, else calls `submit2FA`. Returns `ProtonSession { uid, accessToken, refreshToken, email }`.
  - `refresh(session)` — calls `api.refresh`, returns updated session.
  - Adjust call to vendored SRP function (likely `getSrp(info, { username, password })`) to match the actual signature found in Task 4 — the contract is "AuthInfo + creds → { clientEphemeral, clientProof }".

- [ ] **Step 4: Run unit test** — expect 1 passing.

- [ ] **Step 5: Write integration test** `server/tests/auth/srp.integration.test.ts` using `describe.skipIf(process.env.INTEGRATION !== '1')`. Reads `PROTON_TEST_EMAIL`, `PROTON_TEST_PASSWORD`, `PROTON_TEST_TOTP` from env. Calls `auth.login(...)`, asserts `uid`, `accessToken`, `refreshToken` all truthy. Catches `TwoFactorRequiredError` and re-throws with hint to set TOTP env.

- [ ] **Step 6: Run integration test (manual, gated)**

```bash
cd server
INTEGRATION=1 \
  PROTON_TEST_EMAIL=your-real-email@proton.me \
  PROTON_TEST_PASSWORD='your-real-password' \
  PROTON_TEST_TOTP=$(oathtool --totp -b YOUR_TOTP_SECRET 2>/dev/null) \
  npx vitest run tests/auth/srp.integration.test.ts
```

Expected: 1 passing. **If this fails, do not move on** — re-inspect Task 4's vendored imports. Most likely cause: a missing transitive dep producing wrong SRP math.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/srp.ts server/tests/auth/
git commit -m "feat(auth): SRP login with TOTP support, integration-tested against Proton"
```

---

## Task 7: Encrypted session store

**Files:** `server/src/auth/session-store.ts`, `server/tests/auth/session-store.test.ts`

- [ ] **Step 1: Write failing test** at `server/tests/auth/session-store.test.ts` covering: round-trip save/load, `load()` returns null when empty, `clear()` removes session, wrong key throws on `load()`, second `save()` overwrites. Use the test-db helper.

- [ ] **Step 2: Run `npm test -- session-store`** — expect FAIL.

- [ ] **Step 3: Implement `server/src/auth/session-store.ts`** — class `SessionStore(db, base64Key)`. Constructor decodes key and asserts 32 bytes. Methods: `save(session)` — JSON-stringify, AES-256-GCM encrypt with random 12-byte IV, store `iv || tag || ct` in single-row `sessions` table (`id=1`) using `INSERT ... ON CONFLICT(id) DO UPDATE`; `load()` — read row, split blob into IV/tag/CT, decrypt, parse JSON; `clear()` — `DELETE FROM sessions WHERE id=1`.

- [ ] **Step 4: Run tests** — expect 5 passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/session-store.ts server/tests/auth/session-store.test.ts
git commit -m "feat(auth): AES-GCM encrypted session store with single-row contract"
```

---

## Task 8: HTTP auth routes

**Files:** `server/src/http/{server,routes-auth,middleware}.ts`, `server/tests/http/routes-auth.test.ts`. Modify `server/src/index.ts`.

- [ ] **Step 1: Write failing test** at `server/tests/http/routes-auth.test.ts`. Use `app.request(...)` (Hono in-process). Cases: login success returns 200 + HttpOnly cookie + `{ok, email}`; bad credentials returns 401; `TwoFactorRequiredError` returns 422 with `{error: 'totp_required'}`; status without cookie returns 401; status with cookie returns 200 + email; logout clears cookie, status afterward returns 401. Inject a fake `ProtonAuth` via `createApp({ db, encryptionKey, protonAuth })`.

- [ ] **Step 2: Implement `server/src/http/middleware.ts`** — exports `COOKIE_NAME`, `sessionMiddleware(store)` (reads cookie, looks up sid in in-memory `liveSids: Set<string>`, loads session, sets `c.get('auth')`), `issueSession(c)` (generates 32-byte sid, adds to set, sets HttpOnly+SameSite=Strict+Secure cookie), `revokeSession(c)` (removes from set, deletes cookie). Export `_resetSids()` for tests.

- [ ] **Step 3: Implement `server/src/http/routes-auth.ts`** — `authRoutes({ store, protonAuth })` returns a Hono sub-app with `sessionMiddleware`. Routes:
  - `POST /login` validates body with Zod (`email`, `password`, optional `totp` 6-digit), calls `protonAuth.login`, on success `store.save` + `issueSession` + log audit (record `Remote-User` header if present); on `TwoFactorRequiredError` → 422 `{error: 'totp_required'}`; on other failure → 401 `{error: 'auth_failed', reauth_required: true}`.
  - `POST /logout` — `store.clear` + `revokeSession` + 200.
  - `GET /status` — return `{email}` if `c.get('auth')`, else 401.

- [ ] **Step 4: Implement `server/src/http/server.ts`** — `createApp(deps: { db, encryptionKey, protonAuth?, protonApiBaseUrl?, appVersion? })` constructs default `ProtonApi` + `ProtonAuth` if not injected. Mounts `/api/health` and `/api/auth/*`.

- [ ] **Step 5: Wire into `server/src/index.ts`**

```ts
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './http/server.js';
import { logger } from './logger.js';

const config = loadConfig();
mkdirSync(dirname(config.DB_PATH), { recursive: true });
const db = openDb(config.DB_PATH);
const app = createApp({ db, encryptionKey: config.SESSION_ENCRYPTION_KEY });
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'server listening');
});
```

- [ ] **Step 6: Add `beforeEach(_resetSids)` to test file.**

- [ ] **Step 7: Run all tests** — expect ~17 passing.

- [ ] **Step 8: Commit**

```bash
git add server/src/http/ server/src/index.ts server/tests/http/
git commit -m "feat(http): /api/auth login/logout/status with cookie session middleware"
```

---

## Task 9: PWA bootstrap

**Files:** `pwa/package.json`, `pwa/tsconfig.json`, `pwa/vite.config.ts`, `pwa/index.html`, `pwa/public/{manifest.webmanifest,sw.js}`, `pwa/src/{main.tsx,api.ts}`, `pwa/src/ui/{App,LoginScreen,StatusScreen}.tsx`, `pwa/tests/{setup.ts,ui/login.test.tsx}`.

- [ ] **Step 1: Create `pwa/package.json`** with exact-pinned versions:

```json
{
  "name": "@doc-scanner/pwa",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "preact": "10.29.1"
  },
  "devDependencies": {
    "@preact/preset-vite": "2.10.5",
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/preact": "3.2.4",
    "@types/node": "25.6.0",
    "happy-dom": "20.9.0",
    "typescript": "6.0.3",
    "vite": "8.0.10",
    "vitest": "4.1.5"
  }
}
```

Same caveat as server: versions are 2026-04-27 currents; if a major has moved, evaluate before bumping.

- [ ] **Step 2: Create `pwa/tsconfig.json`** extending base, with `jsx: react-jsx`, `jsxImportSource: preact`, `lib: [ES2022, DOM, DOM.Iterable, WebWorker]`, `noEmit: true`.

- [ ] **Step 3: Create `pwa/vite.config.ts`** — preact plugin, dev server on 5173 with `/api` proxied to `localhost:3000`, vitest config with `environment: 'happy-dom'` and `setupFiles: ['./tests/setup.ts']`.

- [ ] **Step 4: Create `pwa/tests/setup.ts`** importing `@testing-library/jest-dom/vitest`.

- [ ] **Step 5: Create `pwa/index.html`** minimal — single `<div id="app">` + `<script type="module" src="/src/main.tsx">`, manifest link.

- [ ] **Step 6: Create `pwa/public/manifest.webmanifest`** — name, start_url `/`, display `standalone`, theme/background colors, two icons (192/512). Placeholder PNGs in `pwa/public/icons/` are fine for P1.

- [ ] **Step 7: Create `pwa/public/sw.js` (stub for P1)**

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
```

(Real caching/background-sync arrives in Phase 5.)

- [ ] **Step 8: Create `pwa/src/api.ts`** — typed fetch client. `LoginRequest/Response`, `StatusResponse` interfaces. `request<T>(path, init)` helper sends `credentials: same-origin`, content-type JSON, parses response, throws `ApiError(message, status, code)` on non-2xx. Exports `api.login`, `api.logout`, `api.status`.

- [ ] **Step 9: Create `pwa/src/ui/LoginScreen.tsx`** — form with email + password inputs, conditional TOTP input shown after a `totp_required` response, `role="alert"` warning box ("This is an unofficial app… Your password is never stored"). On submit, calls `api.login`; on `ApiError` with `code === 'totp_required'`, sets `needsTotp = true`. Calls `onLoggedIn(email)` on success.

- [ ] **Step 10: Create `pwa/src/ui/StatusScreen.tsx`** — shows "Logged in as {email}" + sign-out button that calls `api.logout` then `onLoggedOut()`.

- [ ] **Step 11: Create `pwa/src/ui/App.tsx`** — on mount, calls `api.status`; sets `email` on success; on `ApiError` with status 401, stays unauthed; renders `LoginScreen` or `StatusScreen` accordingly.

- [ ] **Step 12: Create `pwa/src/main.tsx`** — Preact `render(<App />, ...)` + register `/sw.js` if SW available.

- [ ] **Step 13: Write `pwa/tests/ui/login.test.tsx`** — two cases: warning is rendered with "unofficial" + "never stored" text; email + password inputs render with correct labels.

- [ ] **Step 14: Install + run**

```bash
npm install
cd pwa && npm test
```

Expect 2 passing.

- [ ] **Step 15: Commit**

```bash
git add pwa/ package-lock.json
git commit -m "feat(pwa): bootstrap Vite + Preact PWA with login/status screens"
```

---

## Task 10: Dockerize

**Files:** `Dockerfile`, `compose.yml`

- [ ] **Step 1: Create multi-stage `Dockerfile`** — stages: `deps` (install workspaces from package-lock with `npm ci`), `build` (run `tsc` for server, `vite build` for pwa), `runtime` (`node:20.20-alpine3.22` + tini, copies `server/dist`, `server/src/migrations` (renamed to dist/migrations), `node_modules`, `pwa/dist`). Sets `DB_PATH=/data/app.db`, `EXPOSE 3000`, `VOLUME ["/data"]`, `ENTRYPOINT ["/sbin/tini","--"]`, `CMD ["node","server/dist/index.js"]`.

PIN BASE IMAGE TO DIGEST: After the first successful build, capture the resolved digest with `docker buildx imagetools inspect node:20.20-alpine3.22 | grep Digest` and pin in the Dockerfile as `FROM node:20.20-alpine3.22@sha256:<digest> AS deps` (and same for `runtime` stage). Renovate (`pinDigests: true` for dockerfile manager — see Task 1) will keep digests current after that.

  NOTE: PWA static asset serving from the server is added in Phase 4. For Phase 1, the runtime image only serves `/api/*`; the PWA runs via `vite dev` for the smoke test.

- [ ] **Step 2: Create `compose.yml`**

```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    volumes: ["./data:/data"]
    environment:
      SESSION_ENCRYPTION_KEY: ${SESSION_ENCRYPTION_KEY:?required}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:?required}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      TRUST_PROXY: "true"
    restart: unless-stopped
```

- [ ] **Step 3: Build the image**

```bash
docker build -t doc-scanner:phase1 .
```

Expected: clean build.

- [ ] **Step 4: Smoke-run the container**

```bash
docker run --rm -p 3000:3000 \
  -e SESSION_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  -e ANTHROPIC_API_KEY=test \
  -v $(pwd)/data:/data \
  doc-scanner:phase1 &
sleep 3
curl -sf http://localhost:3000/api/health
docker kill $(docker ps -q --filter ancestor=doc-scanner:phase1)
```

Expected: `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile compose.yml
git commit -m "build: add multi-stage Dockerfile and compose.yml for local dev"
```

---

## Task 11: End-to-end manual smoke

Not automated. Validates the demo path described in the goal.

- [ ] **Step 1: Boot the stack**

Terminal 1: `docker compose up --build`
Terminal 2: `cd pwa && npm run dev`

- [ ] **Step 2: Open `http://localhost:5173`** — see the login screen with the credential warning.

- [ ] **Step 3: Log in** with real Proton email + password (+ TOTP if applicable). Land on StatusScreen showing your email.

- [ ] **Step 4: Verify session persists across server restart**

`docker compose restart app`. Refresh the browser. Status endpoint should still return your email — encrypted blob survived restart, cookie still valid.

KNOWN LIMITATION: in-memory `liveSids` map (Task 8) resets on restart, so server restart **does** force re-login in P1. Acceptable Phase 1 behavior; persisting sids is trivial later.

- [ ] **Step 5: Verify logout clears state.** Click "Sign out", return to login. Refresh, stay logged out.

- [ ] **Step 6: Record smoke results** at the bottom of this plan: date, WebClients SHA used, deviations.

- [ ] **Step 7: Final commit + tag**

```bash
git add docs/
git commit -m "docs: phase 1 smoke test recorded"
git tag phase-1-complete
```

---

## Phase 1 Done — Definition

- All unit tests pass (`npm test` from root).
- Integration test against real Proton passes (`INTEGRATION=1 npm test`).
- Docker image builds and runs.
- Manual smoke (Task 11) succeeds end-to-end.
- `server/src/vendor/proton-srp/README.md` records the WebClients SHA used.

When all true, Phase 1 is done; ready for Phase 2 (Drive integration).

---

## Smoke Results (filled in during Task 11)

_Date:_
_WebClients SHA pinned:_
_Notes:_
