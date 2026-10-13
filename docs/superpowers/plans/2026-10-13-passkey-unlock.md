# Passkey Unlock and Proxy Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server restart no longer forces a full Proton login. Authelia's `Remote-User` decides who the user is (header mode), and one passkey tap, through the WebAuthn PRF extension, unlocks the Proton keys again.

**Architecture:**

- **Header mode:** with `AUTH_PROXY_USER` set, the session middleware signs a request in when `Remote-User` matches it (and, with `AUTH_PROXY_SECRET`, when `X-Doc-Scanner-Proxy-Secret` matches too). There is one live session, under `PROXY_SID`. A state-changing request needs `Sec-Fetch-Site: same-origin`, or no such header. Cookie mode is unchanged.
- **Passkey unlock:** `PasskeyStore` wraps the mailbox passphrase twice: AES-GCM under `HKDF(PRF output, salt)`, then the `passkeys` at-rest cipher. After a restart, `POST /api/auth/unlock` unwraps it, and `ProtonAuth.resume` opens the keys with the stored tokens, refreshing them once if they expired. `startLiveSession` registers the session; the existing listener then resumes the documents waiting in `awaiting_login`.
- **Re-login:** login, unlock and logout share one mutex. A login never logs out first. A different Proton `User.ID` clears the SDK caches, the folder cache and the passkeys. A changed key salt removes the passkeys.
- **PWA:** `App` routes on `{ proton, passkeys, unlockAvailable }`. The inbox shows a locked banner with **Unlock**, and a nudge; Settings gets Passkeys. `auth/passkeys.ts` wraps WebAuthn, and `auth/flows.ts` joins it to the API.

**Tech Stack:** TypeScript, Hono, `node:sqlite`, `node:crypto` (HKDF-SHA256, AES-256-GCM), openpgp, zod 4, vitest; PWA: Preact 11, WebAuthn (PRF extension), @testing-library/preact, happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-13-passkey-unlock-design.md`.

**Deviations from the spec** (Task 17 records them in the spec):

1. `GET /api/passkeys` answers `{ passkeys, notice }`, not a bare array. The spec has Settings say "Your passkeys were removed because your Proton password changed" once, but gives that no channel. `notice` is `'password_changed'` on the first read after such a removal, and the read clears it.
2. `ProtonAuth.resume` returns no `keySaltFingerprint` and doesn't call `getKeySalts`. Nothing shows that Proton serves key salts to a resumed or refreshed session, and the value isn't needed: a successful unlock proves the passphrase, and so the KeySalt, unchanged since enrolment, and while any passkey exists the stored `passkeys.key_salt_fingerprint` is current. The unlock route carries that stored value into the live session (`LiveSession.keySaltFingerprint` is `string | null`), and enrolment writes the fingerprint only when the session knows it.
3. The PWA fetches `unlock/begin` when the locked banner appears (and again after any failed unlock), and `passkeys/begin` when **Add passkey** is tapped. The passkey prompt then starts straight from the next tap, with no request in between: WebKit may refuse a prompt that follows a network round trip. Either flow still fetches for itself if that early fetch failed.

**Additions the spec doesn't ask for:**

- `ProtonApi` requests time out after 30 seconds (`AbortSignal.timeout`), so a hung Proton call can't hold the auth mutex. A `TimeoutError` counts as transient: an unlock answers 503 `proton_unavailable`.
- If `startLiveSession` fails, it disposes the `MailboxSecret` before rethrowing. A login as a different account forgets the old live session before it stores the new tokens, so a failure part-way can't leave account A's keys beside account B's tokens.
- The PWA also signals a passkey as unknown when the server refuses it for any reason (not only an expired enrolment), or when a setup is abandoned at Finish setup. It keeps a passkey whose add got no answer, since the server may have stored it.
- After the unlock refusals `proton_login_required`, `passkeys_stale` and `passkey_unreadable`, the app reads its status again, so its Proton state and passkey count match the server's.

**Readings of the spec** that the code makes explicit:

- The `User.ID` comparison and the key-salt check run in both modes. Cookie mode is development only; clearing a previous account's data there costs nothing.
- Logout takes the mutex too, so an unlock that finishes later can't bring a forgotten session back.
- The `Sec-Fetch-Site` check covers `PATCH` as well as `POST`/`PUT`/`DELETE`.
- `KeyDecryptError` reason `user_key` covers any active user key that won't decrypt: `keys.ts` decrypts every active user key, not only the primary one, and throws on the first failure.
- A 401 on `resume`'s retry, after a successful refresh, is not mapped by the spec; it answers 500 and changes nothing.
- "A network error" is undici's `TypeError('fetch failed')`, or a `TypeError` that carries the socket error as its `cause`, or a `TimeoutError`/`AbortError`. Any other `TypeError` is a bug: it is reported and answers 500.
- WebAuthn requires a `challenge`, and nothing verifies one here, so the PWA sends 32 random bytes.
- In header mode the middleware reads the stored email from the `sessions.email` column (plaintext) instead of decrypting the session, because it runs on every request.

## Before you start

- Work on the existing branch `feat/passkey-unlock` (the spec commits are already on it).
- Node must be the `.nvmrc` version **for the vitest workers too**. `fnm use` alone is not enough. Run this once per shell:

  ```bash
  export PATH="$HOME/.local/share/fnm/node-versions/v$(cat .nvmrc)/installation/bin:$PATH"
  node -v   # v24.21.0
  ```

- Run tests:
  - Server, single file: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run <path>`. The loader is required.
  - PWA, single file: `cd pwa && pnpm exec vitest run <path>`.
  - Everything: `pnpm test` and `pnpm -r run typecheck` from the repo root.
- Commits are Conventional Commits with scopes, signed (the git config already does this), one logical change each.
- Rules that apply everywhere in this plan:
  - **Never log a PRF output, the passphrase, a salt or a passkey label, and never return the first two.** Logs carry a credential id's first 8 characters (`shortId`), outcomes and error type names (`errorName`).
  - **Preact 11 runs `useEffect` cleanups after paint.** Mounted guards use `useLayoutEffect`, as `SettingsScreen` does.
  - **The PWA has `exactOptionalPropertyTypes`.** Pass an optional prop that may be undefined with a conditional spread (`{...(x ? { client: x } : {})}`), never as `prop={undefined}`. The server's tsconfig turns the option off, and server tests are not typechecked.
- Every code block in Tasks 1 to 16 was run against a copy of this branch: each task's new tests failed as described, then passed, and the server and PWA typechecks were clean after every task. Applying the steps in order reproduces that code exactly.

## File map

**Server: create**

| File | Responsibility |
|---|---|
| `server/src/migrations/009_passkey_unlocks.sql` | `passkey_unlocks` table |
| `server/src/auth/passkey-store.ts` | `PasskeyStore`: the two-layer wrap, list, unwrap, remove; `decodeBase64url`, `shortId` |
| `server/src/auth/app-settings.ts` | Plain `app_settings` values: `proton.user_id`, `passkeys.key_salt_fingerprint`, `passkeys.user_handle`, `passkeys.removed_notice` |
| `server/src/auth/mutex.ts` | `Mutex`: login, unlock and logout take turns |
| `server/src/http/routes-passkeys.ts` | `/api/passkeys`: begin, add, list, remove |
| `server/tests/helpers/auth-app.ts` | An app with a fake `ProtonAuth`, header mode by default, and passkey fixtures |
| `server/tests/http/middleware.test.ts`, `server/tests/http/routes-auth-header.test.ts`, `server/tests/http/routes-passkeys.test.ts`, `server/tests/http/routes-unlock.test.ts`, `server/tests/observability/unlock-route.test.ts`, `server/tests/auth/passkey-store.test.ts`, `server/tests/auth/app-settings.test.ts`, `server/tests/auth/proton-auth.test.ts`, `server/tests/auth/mutex.test.ts` | Their tests |

**Server: modify**

| File | Change |
|---|---|
| `server/src/config.ts` | `AUTH_PROXY_USER`, `AUTH_PROXY_SECRET` |
| `server/src/http/middleware.ts` | `AuthMode`, header mode, `Sec-Fetch-Site`, `PROXY_SID`, `forgetAllSessions`, `headerOnly` |
| `server/src/auth/session-store.ts` | `storedEmail()` |
| `server/src/http/server.ts` | Mode, `PasskeyStore`, `clearAccountData`, the passkey router |
| `server/src/http/routes-auth.ts` | `startLiveSession`, header-mode login and logout, status, mutex, re-login, unlock |
| `server/src/http/routes-drive.ts`, `server/src/http/routes-documents.ts` | Take the mode |
| `server/src/index.ts` | `authModeFrom(config)` |
| `server/src/crypto/at-rest.ts` | Purpose `'passkeys'` |
| `server/src/auth/keys.ts` | `KeyDecryptError.reason`; returns `{ decryptedKeys, userId }` |
| `server/src/auth/srp.ts` | `LoginResult.userId`/`keySaltFingerprint`; `resume`, `SessionEndedError`, `isTransientProtonError` |
| `server/src/auth/proton-api.ts` | A 30-second timeout on every request |
| `server/src/auth/live-session.ts` | `LiveSession.userId`, `keySaltFingerprint` (`string \| null`) |
| `server/src/drive/folder-cache-store.ts` | `clear()` |
| `server/src/documents/pipeline.ts` | `clearAccountData()` |
| `server/src/observability/report.ts` | `captureAuthFailure` operation `'unlock'` |
| Existing tests | Login fakes gain `userId`/`keySaltFingerprint`; schema version 9 |

**PWA: create**

| File | Responsibility |
|---|---|
| `pwa/src/auth/passkeys.ts` | WebAuthn: `enrolPasskey`, `unlockWithPasskey`, `forgetCredential`, base64url |
| `pwa/src/auth/flows.ts` | `unlock`, `enrol` and the injectable `UnlockClient`/`PasskeysClient` |
| `pwa/src/ui/inbox/LockedBanner.tsx` | The locked banner |
| `pwa/src/ui/PasskeysSection.tsx` | Settings → Passkeys |
| `pwa/tests/auth/fake-webauthn.ts` | Fakes for `navigator.credentials` |
| `pwa/tests/api.test.ts`, `pwa/tests/auth/passkeys.test.ts`, `pwa/tests/auth/flows.test.ts`, `pwa/tests/ui/LockedBanner.test.tsx`, `pwa/tests/ui/PasskeysSection.test.tsx` | Their tests |

**PWA: modify**

| File | Change |
|---|---|
| `pwa/src/api.ts` | `StatusResponse` with `proton`, `passkeys`, `unlockAvailable`; `passkeys.*`, `unlock`, `unlock.begin` |
| `pwa/src/ui/App.tsx` | Status in state, the `proton-login` route, `signInAgain`, nudge, props |
| `pwa/src/ui/LoginScreen.tsx` | Cancel |
| `pwa/src/ui/inbox/InboxScreen.tsx` | Locked banner, nudge |
| `pwa/src/ui/SettingsScreen.tsx` | Passkeys section, sign-out note |
| `pwa/src/theme/theme.css` | Nudge styles |

**Docs and deployment:** `compose.yml`, `.env.example`, `README.md`, `CLAUDE.md`, the parent spec's Trust boundary, the spec.

---

### Task 1: Config: `AUTH_PROXY_USER` and `AUTH_PROXY_SECRET`

**Files:**
- Modify: `server/src/config.ts`
- Test: `server/tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/tests/config.test.ts`, four tests:

Before

```ts
  it('rejects a threshold with more than two decimals', () => {
```

add

```ts
  it('treats blank proxy settings as unset (Compose passes unset variables as empty)', () => {
    const cfg = loadConfig({ ...base, AUTH_PROXY_USER: '', AUTH_PROXY_SECRET: '  ' });
    expect(cfg.AUTH_PROXY_USER).toBeUndefined();
    expect(cfg.AUTH_PROXY_SECRET).toBeUndefined();
  });

  it('reads the proxy user and a long enough secret', () => {
    const cfg = loadConfig({ ...base, AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: 's'.repeat(32) });
    expect(cfg.AUTH_PROXY_USER).toBe('owine');
    expect(cfg.AUTH_PROXY_SECRET).toBe('s'.repeat(32));
  });

  it('rejects a proxy secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...base, AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: 'short' })).toThrow(
      /AUTH_PROXY_SECRET: must be at least 32 characters/,
    );
  });

  it('rejects a proxy secret without a proxy user, which would do nothing', () => {
    expect(() => loadConfig({ ...base, AUTH_PROXY_SECRET: 's'.repeat(32) })).toThrow(/AUTH_PROXY_SECRET: needs AUTH_PROXY_USER/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/config.test.ts`

Expected: FAIL, 3 tests: `expected undefined to be 'owine'` and twice `expected [Function] to throw an error`. The blank-value test already passes (zod strips unknown keys); it guards the `blankToUndefined` wiring.

- [ ] **Step 3: Implement**

In `server/src/config.ts`, add the two variables at the end of `ConfigSchema`, and a refinement for the secret without a user. Zod 4's `.superRefine` keeps the object type, so `Config` gains `AUTH_PROXY_USER?: string` and `AUTH_PROXY_SECRET?: string`:

Replace

```ts
  AUTO_FILE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});
```

with

```ts
  AUTO_FILE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Header mode (passkey-unlock spec §1): the reverse proxy (Authelia) says who
  // the user is, through Remote-User. Unset: the app's own cookie sign-in.
  AUTH_PROXY_USER: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  // For a published port: the proxy also sends this, so nothing else can claim Remote-User.
  AUTH_PROXY_SECRET: z.preprocess(blankToUndefined, z.string().min(32, 'must be at least 32 characters').optional()),
}).superRefine((c, ctx) => {
  // Without a proxy user the secret would silently do nothing.
  if (c.AUTH_PROXY_SECRET !== undefined && c.AUTH_PROXY_USER === undefined) {
    ctx.addIssue({ code: 'custom', path: ['AUTH_PROXY_SECRET'], message: 'needs AUTH_PROXY_USER' });
  }
});
```

- [ ] **Step 4: Run the tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/config.test.ts`

Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/tests/config.test.ts
git commit -m "feat(server): read AUTH_PROXY_USER and AUTH_PROXY_SECRET"
```

---

### Task 2: Header mode in the session middleware, `Sec-Fetch-Site`, and the proxy secret

**Files:**
- Create: `server/tests/http/middleware.test.ts`
- Modify: `server/src/http/middleware.ts`, `server/src/auth/session-store.ts`, `server/src/http/server.ts`, `server/src/http/routes-auth.ts`, `server/src/http/routes-drive.ts`, `server/src/http/routes-documents.ts`, `server/src/index.ts`
- Test: `server/tests/auth/session-store.test.ts`, `server/tests/http/routes-documents.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/http/middleware.test.ts`. It mounts the middleware on a bare Hono app with a probe route:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from '../helpers/test-db.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';
import {
  COOKIE_MODE,
  PROXY_SECRET_HEADER,
  _resetSids,
  authModeFrom,
  sessionMiddleware,
  type AuthContext,
  type AuthMode,
} from '../../src/http/middleware.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const SECRET = 's'.repeat(40);
const HEADER: AuthMode = { kind: 'header', user: 'owine', secret: null };
const WITH_SECRET: AuthMode = { kind: 'header', user: 'owine', secret: SECRET };

let cleanups: (() => void)[] = [];
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(mode: AuthMode) {
  const { db, cleanup } = createTestDb();
  cleanups.push(cleanup);
  const store = new SessionStore(db, KEY);
  const app = new Hono<{ Variables: { auth?: AuthContext } }>();
  app.use('*', sessionMiddleware(store, mode));
  app.all('/probe', (c) => c.json({ auth: c.get('auth') ?? null }));
  return { app, store };
}

type App = ReturnType<typeof setup>['app'];

async function probe(app: App, method = 'GET', headers: Record<string, string> = {}) {
  const res = await app.request('/probe', { method, headers });
  return { status: res.status, body: (await res.json()) as { auth: AuthContext | null; error?: string } };
}

describe('sessionMiddleware in header mode', () => {
  it('signs in the configured proxy user, with no cookie', async () => {
    const { app } = setup(HEADER);
    const res = await app.request('/probe', { headers: { 'Remote-User': 'owine' } });
    expect(await res.json()).toEqual({ auth: { email: 'owine', sid: 'proxy' } });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('names the user by the stored Proton email, else Remote-Email, else the user', async () => {
    const { app, store } = setup(HEADER);
    expect((await probe(app, 'GET', { 'Remote-User': 'owine', 'Remote-Email': 'me@example.test' })).body.auth?.email).toBe('me@example.test');
    store.save({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });
    expect((await probe(app, 'GET', { 'Remote-User': 'owine', 'Remote-Email': 'me@example.test' })).body.auth?.email).toBe('e@x.test');
  });

  it('leaves a wrong or missing user signed out', async () => {
    const { app } = setup(HEADER);
    expect((await probe(app, 'GET', { 'Remote-User': 'mallory' })).body.auth).toBeNull();
    expect((await probe(app)).body.auth).toBeNull();
  });

  it('with a secret, needs the matching secret header too', async () => {
    const { app } = setup(WITH_SECRET);
    const user = { 'Remote-User': 'owine' };
    expect((await probe(app, 'GET', user)).body.auth).toBeNull();
    expect((await probe(app, 'GET', { ...user, [PROXY_SECRET_HEADER]: 't'.repeat(40) })).body.auth).toBeNull();
    // A different length must be refused, not thrown by timingSafeEqual.
    const short = await probe(app, 'GET', { ...user, [PROXY_SECRET_HEADER]: 'short' });
    expect(short).toEqual({ status: 200, body: { auth: null } });
    expect((await probe(app, 'GET', { ...user, [PROXY_SECRET_HEADER]: SECRET })).body.auth?.sid).toBe('proxy');
  });

  it('refuses a state-changing request from another site', async () => {
    const { app } = setup(HEADER);
    const user = { 'Remote-User': 'owine' };
    for (const method of ['POST', 'PUT', 'DELETE']) {
      for (const site of ['cross-site', 'same-site', 'none']) {
        const res = await probe(app, method, { ...user, 'Sec-Fetch-Site': site });
        expect([method, site, res.status, res.body]).toEqual([method, site, 403, { error: 'cross_site' }]);
      }
      expect((await probe(app, method, { ...user, 'Sec-Fetch-Site': 'same-origin' })).body.auth?.sid).toBe('proxy');
      // No header: not a browser, so not a browser being tricked into it.
      expect((await probe(app, method, user)).body.auth?.sid).toBe('proxy');
    }
    expect((await probe(app, 'GET', { ...user, 'Sec-Fetch-Site': 'cross-site' })).body.auth?.sid).toBe('proxy');
  });
});

describe('sessionMiddleware in cookie mode', () => {
  it('ignores Remote-User and does not check Sec-Fetch-Site', async () => {
    const { app } = setup(COOKIE_MODE);
    expect((await probe(app, 'GET', { 'Remote-User': 'owine' })).body.auth).toBeNull();
    expect((await probe(app, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200);
  });
});

describe('authModeFrom', () => {
  it('is cookie mode without a proxy user, and header mode with one', () => {
    expect(authModeFrom({ AUTH_PROXY_USER: undefined, AUTH_PROXY_SECRET: undefined })).toEqual({ kind: 'cookie' });
    expect(authModeFrom({ AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: undefined })).toEqual({ kind: 'header', user: 'owine', secret: null });
    expect(authModeFrom({ AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: SECRET })).toEqual({ kind: 'header', user: 'owine', secret: SECRET });
  });
});
```

In `server/tests/auth/session-store.test.ts`:

Before

```ts
  it('clear() removes the session', () => {
```

add

```ts
  it('reads the stored email without decrypting, even with the wrong key', () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new SessionStore(db, KEY);
    expect(store.storedEmail()).toBeNull();
    store.save(sample);
    expect(new SessionStore(db, Buffer.alloc(32, 9).toString('base64')).storedEmail()).toBe('a@b.test');
    store.clear();
    expect(store.storedEmail()).toBeNull();
  });
```

Append to `server/tests/http/routes-documents.test.ts` (every router gets the mode from `createApp`):

```ts
describe('header mode', () => {
  it('signs every router in by the proxy user', async () => {
    const { db, cleanup } = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'routes-docs-'));
    cleanups.push(cleanup, () => rmSync(dir, { recursive: true, force: true }));
    const pipeline = createPipeline({
      db,
      dataDir: dir,
      encryptionKey: KEY,
      defaults: { model: 'm', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
      analyzerFor: () => ({ analyze: vi.fn() }),
      liveSession: () => undefined,
      prepare: fakePrepare(),
    });
    const app = createApp({ db, encryptionKey: KEY, pipeline, authMode: { kind: 'header', user: 'owine', secret: null } });
    for (const path of ['/api/documents?since=0', '/api/settings', '/api/auth/status']) {
      expect([path, (await app.request(path, { headers: { 'Remote-User': 'owine' } })).status]).toEqual([path, 200]);
      expect([path, (await app.request(path)).status]).toEqual([path, 401]);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/middleware.test.ts tests/auth/session-store.test.ts tests/http/routes-documents.test.ts`

Expected: FAIL, 7 tests: `store.storedEmail is not a function`, `authModeFrom is not a function`, `expected { auth: null } to deeply equal { auth: { email: 'owine', …(1) } }`, a cross-site POST answering 200 instead of 403, and `[ '/api/documents?since=0', 401 ]` instead of 200. The cookie-mode middleware test already passes.

- [ ] **Step 3: Implement the middleware**

Replace the whole of `server/src/http/middleware.ts`. Cookie mode is unchanged. `forgetAllSessions()` is logout's in-memory part without the cookie, which header-mode logout (Task 6) needs:

```ts
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { SessionStore } from '../auth/session-store.js';
import { getLiveSession, disposeAllLiveSessions, type LiveSession } from '../auth/live-session.js';

export const COOKIE_NAME = 'docscanner_sid';

/** Header mode's one live-session id: the proxy, not a cookie, says who the user is. */
export const PROXY_SID = 'proxy';

/** Sent by the proxy when AUTH_PROXY_SECRET is set (passkey-unlock spec §1). */
export const PROXY_SECRET_HEADER = 'X-Doc-Scanner-Proxy-Secret';

/**
 * How a request is signed in. Cookie mode (development): the app's own
 * session cookie, issued by a Proton login. Header mode: the reverse proxy's
 * `Remote-User` equals `user` (and, with a secret, the request carries it).
 */
export type AuthMode = { kind: 'cookie' } | { kind: 'header'; user: string; secret: string | null };

export const COOKIE_MODE: AuthMode = { kind: 'cookie' };

export function authModeFrom(config: Pick<Config, 'AUTH_PROXY_USER' | 'AUTH_PROXY_SECRET'>): AuthMode {
  if (config.AUTH_PROXY_USER === undefined) return COOKIE_MODE;
  return { kind: 'header', user: config.AUTH_PROXY_USER, secret: config.AUTH_PROXY_SECRET ?? null };
}

// Cookie mode only. In-memory map: cookie sid -> "logged in" marker. The
// actual Proton session lives in SessionStore (encrypted, persistent). This
// map exists only to bind a browser cookie to "this server has a session
// loaded for it"; it resets on restart, which forces re-login by design.
const liveSids = new Set<string>();

export interface AuthContext {
  email: string;
  sid: string;
  liveSession?: LiveSession;
}

type Env = { Variables: { auth?: AuthContext } };

/** Methods that change state: header mode refuses them from another site. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Compares SHA-256 digests: equal lengths for timingSafeEqual, whatever was sent. */
function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export const sessionMiddleware = (store: SessionStore, mode: AuthMode = COOKIE_MODE): MiddlewareHandler<Env> => async (c, next) => {
  if (mode.kind === 'header') {
    // The app's own SameSite=Strict cookie used to stop cross-site requests;
    // Authelia's cookie is usually Lax. Browsers send Sec-Fetch-Site on every
    // request; a client without it (curl) is not a browser being tricked.
    const site = c.req.header('Sec-Fetch-Site');
    if (UNSAFE_METHODS.has(c.req.method) && site !== undefined && site !== 'same-origin') {
      return c.json({ error: 'cross_site' }, 403);
    }
    if (c.req.header('Remote-User') === mode.user && (mode.secret === null || secretMatches(c.req.header(PROXY_SECRET_HEADER), mode.secret))) {
      c.set('auth', {
        email: store.storedEmail() ?? c.req.header('Remote-Email') ?? mode.user,
        sid: PROXY_SID,
        liveSession: getLiveSession(PROXY_SID),
      });
    }
    await next();
    return;
  }
  const sid = getCookie(c, COOKIE_NAME);
  if (sid && liveSids.has(sid)) {
    const session = store.load();
    if (session) {
      const liveSession = getLiveSession(sid);
      c.set('auth', { email: session.email, sid, liveSession });
    }
  }
  await next();
};

export function issueSession(c: Context<Env>, secureCookie: boolean = true): string {
  const sid = randomBytes(32).toString('base64url');
  liveSids.add(sid);
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true, sameSite: 'Strict', secure: secureCookie, path: '/',
  });
  return sid;
}

/**
 * Logout's in-memory part. The session store holds a single row and logout
 * clears it, so this means "logged out everywhere": every sid is forgotten
 * and every live session is disposed, so nothing (the document worker
 * included) can keep using, or refresh the tokens of, a login that no longer
 * exists.
 */
export function forgetAllSessions(): void {
  liveSids.clear();
  disposeAllLiveSessions();
}

/** Cookie-mode logout: forgets every session and deletes the cookie. */
export function revokeAllSessions(c: Context<Env>): void {
  forgetAllSessions();
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

// For tests: reset the in-memory sid set
export function _resetSids(): void { liveSids.clear(); }
```

In `server/src/auth/session-store.ts` (the `email` column is plaintext, so header mode can read it on every request without decrypting):

After

```ts
  clear(): void {
    this.db.prepare('DELETE FROM sessions WHERE id = 1').run();
  }
```

add

```ts
  /**
   * The stored session's email, or null when none is stored. Read from the
   * plaintext column, without decrypting: header mode asks on every request.
   */
  storedEmail(): string | null {
    const row = this.db.prepare('SELECT email FROM sessions WHERE id = 1').get() as { email: string } | undefined;
    return row?.email ?? null;
  }
```

- [ ] **Step 4: Pass the mode to every router**

`server/src/http/routes-drive.ts`:

Replace

```ts
import { sessionMiddleware, type AuthContext } from './middleware.js';
```

with

```ts
import { sessionMiddleware, type AuthContext, type AuthMode } from './middleware.js';
```

Replace

```ts
export function driveRoutes(deps: { db: DB; store: SessionStore }) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store));
```

with

```ts
export function driveRoutes(deps: { db: DB; store: SessionStore; authMode: AuthMode }) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store, deps.authMode));
```

`server/src/http/routes-documents.ts`:

Replace

```ts
import { sessionMiddleware, type AuthContext } from './middleware.js';
```

with

```ts
import { sessionMiddleware, type AuthContext, type AuthMode } from './middleware.js';
```

Replace

```ts
function guarded(store: SessionStore): Hono<Env> {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(store), requireAuth);
```

with

```ts
function guarded(store: SessionStore, mode: AuthMode): Hono<Env> {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(store, mode), requireAuth);
```

Replace

```ts
export function documentRoutes(deps: { store: SessionStore; pipeline: Pipeline }) {
```

with

```ts
export function documentRoutes(deps: { store: SessionStore; pipeline: Pipeline; authMode: AuthMode }) {
```

Replace

```ts
export function folderRoutes(deps: { store: SessionStore; pipeline: Pipeline }) {
```

with

```ts
export function folderRoutes(deps: { store: SessionStore; pipeline: Pipeline; authMode: AuthMode }) {
```

Replace

```ts
export function settingsRoutes(deps: { store: SessionStore; pipeline: Pipeline }) {
```

with

```ts
export function settingsRoutes(deps: { store: SessionStore; pipeline: Pipeline; authMode: AuthMode }) {
```

Replace each of the 3 occurrences of

```ts
  const r = guarded(deps.store);
```

with

```ts
  const r = guarded(deps.store, deps.authMode);
```

`server/src/http/routes-auth.ts` (only the mode for now; Task 6 changes login and logout):

Replace

```ts
import { issueSession, revokeAllSessions, sessionMiddleware, type AuthContext } from './middleware.js';
```

with

```ts
import { issueSession, revokeAllSessions, sessionMiddleware, type AuthContext, type AuthMode } from './middleware.js';
```

Replace

```ts
  appVersion?: string;
  secureCookie?: boolean;
}) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store));
```

with

```ts
  authMode: AuthMode;
  appVersion?: string;
  secureCookie?: boolean;
}) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store, deps.authMode));
```

`server/src/http/server.ts`:

After

```ts
import type { Pipeline } from '../documents/pipeline.js';
```

add

```ts
import { COOKIE_MODE, type AuthMode } from './middleware.js';
```

Replace

```ts
  pwaDistPath?: string;
  pipeline?: Pipeline;
}
```

with

```ts
  pwaDistPath?: string;
  pipeline?: Pipeline;
  /** Header mode signs requests in by the proxy's Remote-User; cookie mode by default. */
  authMode?: AuthMode;
}
```

After

```ts
  const store = new SessionStore(deps.db, deps.encryptionKey);
```

add

```ts
  const authMode = deps.authMode ?? COOKIE_MODE;
```

Replace

```ts
  app.route('/api/auth', authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, appVersion: deps.appVersion, secureCookie: deps.secureCookie }));
  app.route('/api/drive', driveRoutes({ db: deps.db, store }));
  if (deps.pipeline) {
    const pipelineDeps = { store, pipeline: deps.pipeline };
```

with

```ts
  app.route('/api/auth', authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, authMode, appVersion: deps.appVersion, secureCookie: deps.secureCookie }));
  app.route('/api/drive', driveRoutes({ db: deps.db, store, authMode }));
  if (deps.pipeline) {
    const pipelineDeps = { store, pipeline: deps.pipeline, authMode };
```

`server/src/index.ts` (the log line carries the mode only, never the user or the secret):

After

```ts
import { createApp } from './http/server.js';
```

add

```ts
import { authModeFrom } from './http/middleware.js';
```

Replace

```ts
const app = createApp({
  db,
  pipeline,
```

with

```ts
const authMode = authModeFrom(config);
// The mode only: never the user or the secret.
logger.info({ authMode: authMode.kind, proxySecret: authMode.kind === 'header' && authMode.secret !== null }, 'sign-in mode');

const app = createApp({
  db,
  pipeline,
  authMode,
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http tests/auth/session-store.test.ts && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/http/middleware.ts server/src/auth/session-store.ts server/src/http/server.ts server/src/http/routes-auth.ts server/src/http/routes-drive.ts server/src/http/routes-documents.ts server/src/index.ts server/tests/http/middleware.test.ts server/tests/auth/session-store.test.ts server/tests/http/routes-documents.test.ts
git commit -m "feat(server): sign requests in by the proxy's Remote-User in header mode"
```

---

### Task 3: Migration 009, the `passkeys` cipher purpose, and `PasskeyStore`

**Files:**
- Create: `server/src/migrations/009_passkey_unlocks.sql`, `server/src/auth/app-settings.ts`, `server/src/auth/passkey-store.ts`, `server/tests/auth/app-settings.test.ts`, `server/tests/auth/passkey-store.test.ts`
- Modify: `server/src/crypto/at-rest.ts`
- Test: `server/tests/crypto/at-rest.test.ts`, `server/tests/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/auth/passkey-store.test.ts`. It checks the spec's construction independently, with `hkdfSync` and `createDecipheriv`, not through the store:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { createTestDb } from '../helpers/test-db.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { PasskeyStore, decodeBase64url } from '../../src/auth/passkey-store.js';
import { logger } from '../../src/logger.js';
import type { DB } from '../../src/db.js';

const KEY = Buffer.alloc(32, 5).toString('base64');
const ID = 'cred-AAAAAAAAAAAAAAAA';
const OTHER = 'cred-BBBBBBBBBBBBBBBB';
const PRF = new Uint8Array(32).fill(7);
const SALT = new Uint8Array(32).fill(3);
const PASS = 'mailbox-passphrase-Northwind';
const LABEL = 'Northwind phone';
const NOW = new Date('2026-10-13T10:00:00.000Z');

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  vi.restoreAllMocks();
});

function setup(): { s: PasskeyStore; db: DB } {
  const t = createTestDb();
  cleanup = t.cleanup;
  return { s: new PasskeyStore(t.db, new AtRestCipher(KEY, 'passkeys'), () => NOW), db: t.db };
}

const add = (s: PasskeyStore, credentialId = ID, prf: Uint8Array = PRF, salt: Uint8Array = SALT) =>
  s.add({ credentialId, label: LABEL, salt, prf, passphrase: new TextEncoder().encode(PASS) });

const text = (r: unknown) => (r instanceof Uint8Array ? new TextDecoder().decode(r) : r);

describe('PasskeyStore', () => {
  it('unwraps the passphrase with the right PRF output', () => {
    const { s } = setup();
    add(s);
    expect(text(s.unwrap(ID, PRF))).toBe(PASS);
  });

  it('follows the spec: HKDF(prf, salt) inside, the passkeys cipher outside, both bound to the id', () => {
    const { s, db } = setup();
    add(s);
    const row = db.prepare('SELECT wrapped FROM passkey_unlocks WHERE credential_id = ?').get(ID) as { wrapped: Uint8Array };
    const inner = new AtRestCipher(KEY, 'passkeys').open(row.wrapped, Buffer.from(ID));
    const key = Buffer.from(hkdfSync('sha256', PRF, SALT, 'docscanner-passkey-unlock', 32));
    const decipher = createDecipheriv('aes-256-gcm', key, inner.subarray(0, 12));
    decipher.setAuthTag(inner.subarray(12, 28));
    decipher.setAAD(Buffer.from(ID));
    expect(Buffer.concat([decipher.update(inner.subarray(28)), decipher.final()]).toString('utf8')).toBe(PASS);
  });

  it('answers wrong_secret for another PRF output, and keeps the row', () => {
    const { s } = setup();
    add(s);
    expect(s.unwrap(ID, new Uint8Array(32).fill(8))).toBe('wrong_secret');
    expect(s.count()).toBe(1);
  });

  it('answers unknown for an id it does not have', () => {
    const { s } = setup();
    expect(s.unwrap(ID, PRF)).toBe('unknown');
  });

  it('answers unreadable when the outer layer will not open, and removes only that row', () => {
    const { s, db } = setup();
    add(s);
    add(s, OTHER);
    const warn = vi.spyOn(logger, 'warn');
    db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(new Uint8Array(60), ID);
    expect(s.unwrap(ID, PRF)).toBe('unreadable');
    expect(s.list().map((p) => p.credentialId)).toEqual([OTHER]);
    expect(warn).toHaveBeenCalledWith({ credential: 'cred-AAA' }, 'passkey unlock unreadable; removed');
  });

  it('binds a wrap to its credential id', () => {
    const { s, db } = setup();
    add(s);
    add(s, OTHER);
    const { wrapped } = db.prepare('SELECT wrapped FROM passkey_unlocks WHERE credential_id = ?').get(ID) as { wrapped: Uint8Array };
    db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(wrapped, OTHER);
    expect(s.unwrap(OTHER, PRF)).toBe('unreadable');
  });

  it('seals the label: the raw row holds neither the label nor the passphrase', () => {
    const { s, db } = setup();
    add(s);
    const row = db.prepare('SELECT * FROM passkey_unlocks').get() as Record<string, unknown>;
    for (const value of Object.values(row)) {
      const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
      expect(bytes.includes(Buffer.from(LABEL))).toBe(false);
      expect(bytes.includes(Buffer.from(PASS))).toBe(false);
    }
    expect(s.list()[0]?.label).toBe(LABEL);
  });

  it('lists each passkey with its dates, and touch records the last use', () => {
    const { s } = setup();
    expect(add(s)).toEqual({ credentialId: ID, label: LABEL, createdAt: NOW.toISOString(), lastUsedAt: null });
    expect(s.list()).toEqual([{ credentialId: ID, label: LABEL, createdAt: NOW.toISOString(), lastUsedAt: null }]);
    s.touch(ID);
    expect(s.list()[0]?.lastUsedAt).toBe(NOW.toISOString());
  });

  it('lists every id with its salt', () => {
    const { s } = setup();
    add(s);
    expect(s.saltsFor().map((p) => ({ id: p.credentialId, salt: Array.from(p.salt) }))).toEqual([{ id: ID, salt: Array.from(SALT) }]);
  });

  it('removes one, or all of them', () => {
    const { s } = setup();
    add(s);
    expect(s.remove(ID)).toBe(true);
    expect(s.remove(ID)).toBe(false);
    add(s);
    add(s, OTHER);
    expect(s.removeAll()).toBe(2);
    expect(s.count()).toBe(0);
  });

  it('replaces the wrap when the same credential is added again', () => {
    const { s } = setup();
    add(s);
    const prf2 = new Uint8Array(32).fill(9);
    add(s, ID, prf2, new Uint8Array(32).fill(4));
    expect(s.count()).toBe(1);
    expect(text(s.unwrap(ID, prf2))).toBe(PASS);
  });
});

describe('decodeBase64url', () => {
  it('decodes base64url and refuses anything else', () => {
    expect(Array.from(decodeBase64url('AQID-_8')!)).toEqual([1, 2, 3, 251, 255]);
    expect(decodeBase64url('AQ+D')).toBeNull();
    expect(decodeBase64url('AQ==')).toBeNull();
  });
});
```

Create `server/tests/auth/app-settings.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { SETTING, deleteSetting, readSetting, takeSetting, writeSetting } from '../../src/auth/app-settings.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe('app settings', () => {
  it('reads, overwrites, takes once and deletes a value', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    expect(readSetting(t.db, SETTING.protonUserId)).toBeNull();
    writeSetting(t.db, SETTING.protonUserId, 'user-1');
    writeSetting(t.db, SETTING.protonUserId, 'user-2');
    expect(readSetting(t.db, SETTING.protonUserId)).toBe('user-2');
    writeSetting(t.db, SETTING.removedNotice, 'password_changed');
    expect(takeSetting(t.db, SETTING.removedNotice)).toBe('password_changed');
    expect(takeSetting(t.db, SETTING.removedNotice)).toBeNull();
    deleteSetting(t.db, SETTING.protonUserId);
    expect(readSetting(t.db, SETTING.protonUserId)).toBeNull();
  });
});
```

In `server/tests/crypto/at-rest.test.ts`:

Before

```ts
  it('rejects tampered ciphertext', () => {
```

add

```ts
  it('gives passkey wraps a key of their own', () => {
    const sealed = new AtRestCipher(MASTER, 'passkeys').seal(new Uint8Array([1]));
    expect(() => new AtRestCipher(MASTER, 'documents').open(sealed)).toThrow(/unable to authenticate/i);
  });
```

In `server/tests/db.test.ts`, the schema version becomes 9 (both places):

Replace each of the 2 occurrences of

```ts
    expect(v.v).toBe(8);
```

with

```ts
    expect(v.v).toBe(9);
```

Replace

```ts
    expect(secondCount).toBe(8);
```

with

```ts
    expect(secondCount).toBe(9);
```

and a test for the new table:

Before

```ts
  it('migration 003 keys event cursors by scope and adds app_settings', () => {
```

add

```ts
  it('migration 009 adds passkey_unlocks', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cols = (db.prepare("SELECT name FROM pragma_table_info('passkey_unlocks')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['credential_id', 'label', 'salt', 'wrapped', 'created_at', 'last_used_at']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth/passkey-store.test.ts tests/auth/app-settings.test.ts tests/crypto/at-rest.test.ts tests/db.test.ts`

Expected: FAIL: `Cannot find module '../../src/auth/passkey-store.js'` and `'../../src/auth/app-settings.js'`; `expected 8 to be 9` (three tests) and `expected [] to deeply equal [ 'credential_id', … ]`. The at-rest test passes at runtime already (the purpose is only a string there); the type change is for the typecheck.

- [ ] **Step 3: Add the migration**

Create `server/src/migrations/009_passkey_unlocks.sql`:

```sql
-- Schema version 9: passkeys that can unlock the Proton keys after a restart
-- (docs/superpowers/specs/2026-10-13-passkey-unlock-design.md).
-- wrapped: the mailbox passphrase, sealed under a key derived from the
--   passkey's PRF output (never stored), then sealed again with the
--   'passkeys' at-rest cipher. label is sealed the same way as other names.
CREATE TABLE IF NOT EXISTS passkey_unlocks (
  credential_id TEXT PRIMARY KEY,
  label         BLOB NOT NULL,
  salt          BLOB NOT NULL,
  wrapped       BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
```

- [ ] **Step 4: Add the cipher purpose**

Replace

```ts
export type AtRestPurpose = 'inbox' | 'folder-cache' | 'documents';
```

with

```ts
export type AtRestPurpose = 'inbox' | 'folder-cache' | 'documents' | 'passkeys';
```

- [ ] **Step 5: Implement the settings helpers and the store**

Create `server/src/auth/app-settings.ts`. The keys the spec names live in migration 003's `app_settings` as plain strings, like `drive_client_uid`:

```ts
import type { DB } from '../db.js';

/**
 * Install-scoped values in migration 003's `app_settings`, stored as plain
 * strings (SettingsStore owns the `filing.` keys, client-uid.ts the Drive
 * client uid). None of them is secret.
 */
export const SETTING = {
  /** The Proton `User.ID` of the last login: a different one means a different account. */
  protonUserId: 'proton.user_id',
  /** SHA-256 of the primary user key's KeySalt, written when a passkey is enrolled. */
  keySaltFingerprint: 'passkeys.key_salt_fingerprint',
  /** The WebAuthn user handle: made once, so every passkey belongs to one user. */
  userHandle: 'passkeys.user_handle',
  /** Set when a login removed the passkeys because the password changed; Settings says so once. */
  removedNotice: 'passkeys.removed_notice',
} as const;

export type SettingKey = (typeof SETTING)[keyof typeof SETTING];

export function readSetting(db: DB, key: SettingKey): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeSetting(db: DB, key: SettingKey, value: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteSetting(db: DB, key: SettingKey): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

/** Reads a value and deletes it: for something shown once. */
export function takeSetting(db: DB, key: SettingKey): string | null {
  const value = readSetting(db, key);
  if (value !== null) deleteSetting(db, key);
  return value;
}
```

Create `server/src/auth/passkey-store.ts`. Beyond the spec's method list it has `count()` (for the status) and exports `decodeBase64url`, `shortId`, `CREDENTIAL_ID` and `PRF_BYTES` for the routes:

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import type { AtRestCipher } from '../crypto/at-rest.js';
import { logger } from '../logger.js';

/** `PublicKeyCredential.id` is base64url. Here it is a primary key, associated data and a URL segment. */
export const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,256}$/;

/** PRF outputs are 32 bytes, and so are the salts the server makes. */
export const PRF_BYTES = 32;

const INFO = 'docscanner-passkey-unlock';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export interface PasskeyEntry {
  credentialId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * `unknown`: no such passkey. `wrong_secret`: the PRF output didn't open the
 * inner layer. `unreadable`: the outer layer didn't open (the env key changed,
 * or the row is corrupt); the row is removed.
 */
export type UnwrapResult = Uint8Array | 'unknown' | 'wrong_secret' | 'unreadable';

/** Strict base64url: null for anything with other characters (padding included). */
export function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** What logs carry of a credential id: enough to tell passkeys apart. */
export const shortId = (credentialId: string): string => credentialId.slice(0, 8);

const idAad = (credentialId: string) => Buffer.from(credentialId, 'utf8');
const labelAad = (credentialId: string) => Buffer.from(`${credentialId}\0label`, 'utf8');

/** Spec §2: HKDF-SHA256(ikm = PRF output, salt = the passkey's salt, info), 32 bytes. */
function innerKey(prf: Uint8Array, salt: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', prf, salt, INFO, 32));
}

/** AES-256-GCM, laid out like AtRestCipher's: iv (12) | tag (16) | ciphertext. */
function innerSeal(key: Buffer, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function innerOpen(key: Buffer, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.length < IV_LEN + TAG_LEN) throw new Error('passkey wrap too short');
  const decipher = createDecipheriv(ALGO, key, sealed.subarray(0, IV_LEN), { authTagLength: TAG_LEN });
  decipher.setAuthTag(sealed.subarray(IV_LEN, IV_LEN + TAG_LEN));
  decipher.setAAD(aad);
  return Buffer.concat([decipher.update(sealed.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

interface Row {
  credential_id: string;
  label: Uint8Array;
  salt: Uint8Array;
  wrapped: Uint8Array;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Passkeys that can unlock the Proton keys after a restart (spec §2). Each
 * row wraps the mailbox passphrase twice: inside, under a key derived from
 * the passkey's PRF output, which is never stored; outside, with the
 * 'passkeys' at-rest cipher. Both layers are bound to the credential id. The
 * database alone opens nothing, and the database plus SESSION_ENCRYPTION_KEY
 * still lacks the PRF output. Never logs or returns a PRF output or the
 * passphrase; logs carry the first 8 characters of a credential id.
 */
export class PasskeyStore {
  constructor(
    private readonly db: DB,
    private readonly cipher: AtRestCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Wraps the passphrase for one passkey. Adding a credential id again replaces its row. */
  add(entry: { credentialId: string; label: string; salt: Uint8Array; prf: Uint8Array; passphrase: Uint8Array }): PasskeyEntry {
    const aad = idAad(entry.credentialId);
    const inner = innerSeal(innerKey(entry.prf, entry.salt), entry.passphrase, aad);
    const wrapped = this.cipher.seal(inner, aad);
    const label = this.cipher.seal(Buffer.from(entry.label, 'utf8'), labelAad(entry.credentialId));
    const createdAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO passkey_unlocks (credential_id, label, salt, wrapped, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(credential_id) DO UPDATE SET label = excluded.label, salt = excluded.salt,
           wrapped = excluded.wrapped, created_at = excluded.created_at, last_used_at = NULL`,
      )
      .run(entry.credentialId, label, entry.salt, wrapped, createdAt);
    return { credentialId: entry.credentialId, label: entry.label, createdAt, lastUsedAt: null };
  }

  /** Oldest first, labels opened. */
  list(): PasskeyEntry[] {
    const rows = this.db
      .prepare('SELECT credential_id, label, created_at, last_used_at FROM passkey_unlocks ORDER BY created_at, credential_id')
      .all() as Pick<Row, 'credential_id' | 'label' | 'created_at' | 'last_used_at'>[];
    return rows.map((r) => ({
      credentialId: r.credential_id,
      label: this.openLabel(r.credential_id, r.label),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM passkey_unlocks').get() as { n: number }).n;
  }

  /** Every passkey with its PRF salt: what an unlock asks the authenticator to evaluate. */
  saltsFor(): { credentialId: string; salt: Uint8Array }[] {
    const rows = this.db.prepare('SELECT credential_id, salt FROM passkey_unlocks ORDER BY created_at, credential_id').all() as Pick<
      Row,
      'credential_id' | 'salt'
    >[];
    return rows.map((r) => ({ credentialId: r.credential_id, salt: r.salt }));
  }

  /** The passphrase bytes, or why not. The caller owns (and should zero) the bytes. */
  unwrap(credentialId: string, prf: Uint8Array): UnwrapResult {
    const row = this.db.prepare('SELECT salt, wrapped FROM passkey_unlocks WHERE credential_id = ?').get(credentialId) as
      | Pick<Row, 'salt' | 'wrapped'>
      | undefined;
    if (!row) return 'unknown';
    const aad = idAad(credentialId);
    let inner: Buffer;
    try {
      inner = this.cipher.open(row.wrapped, aad);
    } catch {
      // Not a wrong PRF output: this row can never open again.
      this.remove(credentialId);
      logger.warn({ credential: shortId(credentialId) }, 'passkey unlock unreadable; removed');
      return 'unreadable';
    }
    try {
      return new Uint8Array(innerOpen(innerKey(prf, row.salt), inner, aad));
    } catch {
      return 'wrong_secret';
    }
  }

  touch(credentialId: string): void {
    this.db.prepare('UPDATE passkey_unlocks SET last_used_at = ? WHERE credential_id = ?').run(this.now().toISOString(), credentialId);
  }

  remove(credentialId: string): boolean {
    return Number(this.db.prepare('DELETE FROM passkey_unlocks WHERE credential_id = ?').run(credentialId).changes) > 0;
  }

  /** How many were removed. */
  removeAll(): number {
    return Number(this.db.prepare('DELETE FROM passkey_unlocks').run().changes);
  }

  private openLabel(credentialId: string, sealed: Uint8Array): string {
    try {
      return this.cipher.open(sealed, labelAad(credentialId)).toString('utf8');
    } catch {
      logger.warn({ credential: shortId(credentialId) }, 'passkey label unreadable');
      return 'Passkey';
    }
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth/passkey-store.test.ts tests/auth/app-settings.test.ts tests/crypto/at-rest.test.ts tests/db.test.ts`

Expected: PASS (41 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/migrations/009_passkey_unlocks.sql server/src/auth/app-settings.ts server/src/auth/passkey-store.ts server/src/crypto/at-rest.ts server/tests/auth/passkey-store.test.ts server/tests/auth/app-settings.test.ts server/tests/crypto/at-rest.test.ts server/tests/db.test.ts
git commit -m "feat(server): store passkey-wrapped Proton passphrases"
```

---

### Task 4: `KeyDecryptError` reasons; the Proton user id and key-salt fingerprint from login

**Files:**
- Create: `server/tests/auth/proton-auth.test.ts`
- Modify: `server/src/auth/keys.ts`, `server/src/auth/srp.ts`, `server/src/auth/live-session.ts`, `server/src/http/routes-auth.ts`
- Test: `server/tests/auth/keys.test.ts`, `server/tests/http/routes-auth.test.ts`, `server/tests/http/routes-documents.test.ts`, `server/tests/http/routes-drive.test.ts`, `server/tests/observability/login-route.test.ts`

- [ ] **Step 1: Write the failing tests**

`fetchAndDecryptUserKey` now returns `{ decryptedKeys, userId }`. In `server/tests/auth/keys.test.ts`, the three tests that read the keys destructure them:

Replace each of the 3 occurrences of

```ts
    const result = await fetchAndDecryptUserKey({
```

with

```ts
    const { decryptedKeys: result } = await fetchAndDecryptUserKey({
```

Then assert the reasons in the three existing failure tests:

Replace

```ts
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toThrow(KeyDecryptError);
```

with

```ts
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'user_key' });
```

Replace

```ts
      mailboxPasswordBytes: new TextEncoder().encode('p'),
    })).rejects.toThrow(KeyDecryptError);
```

with

```ts
      mailboxPasswordBytes: new TextEncoder().encode('p'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'no_keys' });
```

Replace

```ts
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    })).rejects.toThrow(KeyDecryptError);
```

with

```ts
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'no_addresses' });
```

and three new tests:

Before

```ts
  it('throws KeyDecryptError on wrong mailbox password', async () => {
```

add

```ts
  it('returns the Proton user id with the keys', async () => {
    const passphrase = 'ids-mailbox-password';
    const userKeyArmored = await makeUserKey(passphrase);
    const { addrKeyArmored, Token } = await makeAddressKeyWithToken(userKeyArmored, passphrase);
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'user-123', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'uk-primary', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn().mockResolvedValue({
        Addresses: [{
          ID: 'addr-1', Email: 'test@example.com', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
          Keys: [{ ID: 'ak-1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: addrKeyArmored, Token, Signature: null, Fingerprint: 'fp2' }],
        }],
      }),
    } as unknown as ProtonApi;

    const result = await fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    expect(result).toEqual({ decryptedKeys: expect.any(Object), userId: 'user-123' });
    expect(result.decryptedKeys.addresses[0]!.addressId).toBe('addr-1');
  });

  it('says no_keys, not user_key, when every user key is inactive', async () => {
    const userKeyArmored = await makeUserKey('pw');
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'k1', Version: 4, Primary: 1, Active: 0, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn(),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'no_keys' });
  });

  it('says address_key when no key of an address opens', async () => {
    const passphrase = 'pw';
    const userKeyArmored = await makeUserKey(passphrase);
    // A legacy key under another passphrase: neither the token path nor the mailbox password opens it.
    const otherKey = await makeLegacyAddressKey('a-different-passphrase');
    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({
        User: {
          ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
          Keys: [{ ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKeyArmored, Fingerprint: 'fp' }],
        },
      }),
      getAddresses: vi.fn().mockResolvedValue({
        Addresses: [{
          ID: 'addr-1', Email: 'test@example.com', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
          Keys: [{ ID: 'ak-1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: otherKey, Fingerprint: 'fp2' }],
        }],
      }),
    } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    })).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'address_key' });
  });
```

Create `server/tests/auth/proton-auth.test.ts`. Like `tests/observability/auth-failures.test.ts`, it mocks `getSrp` to skip the SRP maths. The keys are real: the user key is locked with `computeKeyPassword(PASSWORD, KEY_SALT)`, so `login` runs its real bcrypt step. Task 5 appends the `resume` tests to this file:

```ts
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import { computeKeyPassword } from '../../src/vendor/proton-srp/keys.js';
import type { ProtonAddress, ProtonApi, ProtonUser } from '../../src/auth/proton-api.js';

// Skip the SRP maths (the integration test covers the real proof); the key
// steps after it are what these tests are about.
vi.mock('../../src/vendor/proton-srp/srp.js', () => ({
  getSrp: vi.fn().mockResolvedValue({ clientEphemeral: 'ce', clientProof: 'cp', expectedServerProof: 'sp' }),
}));

const { ProtonAuth, keySaltFingerprint } = await import('../../src/auth/srp.js');

const PASSWORD = 'correct horse battery staple';
/** 16 bytes in base64: 24 characters, as Proton sends a KeySalt. */
const KEY_SALT = Buffer.alloc(16, 3).toString('base64');

let passphrase: string;
let user: ProtonUser;
let address: ProtonAddress;

beforeAll(async () => {
  passphrase = await computeKeyPassword(PASSWORD, KEY_SALT);
  const { privateKey: userKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase, format: 'armored',
  });
  const tokenPassphrase = 'address-token-passphrase';
  const { privateKey: addressKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: tokenPassphrase, format: 'armored',
  });
  const unlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: userKey }), passphrase });
  const Token = (await openpgp.encrypt({
    message: await openpgp.createMessage({ text: tokenPassphrase }),
    encryptionKeys: unlocked.toPublic(),
    format: 'armored',
  })) as string;
  user = {
    ID: 'user-123', Name: 'e', Currency: 'USD', Email: 'e@x.test', DisplayName: 'E',
    Keys: [{ ID: 'uk1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKey, Fingerprint: 'f1' }],
  };
  address = {
    ID: 'addr-1', Email: 'e@x.test', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
    Keys: [{ ID: 'ak1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: addressKey, Token, Signature: null, Fingerprint: 'f2' }],
  };
});

function fakeApi(overrides: Partial<Record<keyof ProtonApi, unknown>> = {}): ProtonApi {
  return {
    getAuthInfo: vi.fn().mockResolvedValue({ Version: 4, Modulus: 'm', ServerEphemeral: 'se', Salt: 's', SRPSession: 'srp' }),
    submitAuth: vi.fn().mockResolvedValue({ UID: 'uid-1', AccessToken: 'at-1', RefreshToken: 'rt-1' }),
    submit2FA: vi.fn(),
    getKeySalts: vi.fn().mockResolvedValue({ KeySalts: [{ ID: 'uk1', KeySalt: KEY_SALT }] }),
    getUser: vi.fn().mockResolvedValue({ User: user }),
    getAddresses: vi.fn().mockResolvedValue({ Addresses: [address] }),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ProtonApi;
}

describe('ProtonAuth.login', () => {
  it('returns the Proton user id and the key-salt fingerprint', async () => {
    const result = await new ProtonAuth(fakeApi()).login('e@x.test', PASSWORD);
    expect(result.userId).toBe('user-123');
    expect(result.keySaltFingerprint).toBe(createHash('sha256').update(KEY_SALT).digest('hex'));
    expect(keySaltFingerprint(KEY_SALT)).toBe(result.keySaltFingerprint);
    result.mailboxSecret.dispose();
  });
});
```

The login fakes in the route tests must now carry the two new fields, because Task 7 writes `userId` to SQLite, and `node:sqlite` refuses to bind `undefined`. In `server/tests/http/routes-auth.test.ts`:

Replace

```ts
    mailboxSecret: new MailboxSecret(new Uint8Array([0])),
    decryptedKeys: testDecryptedKeys,
  };
```

with

```ts
    mailboxSecret: new MailboxSecret(new Uint8Array([0])),
    decryptedKeys: testDecryptedKeys,
    userId: 'user-1',
    keySaltFingerprint: 'fp-1',
  };
```

In `server/tests/http/routes-documents.test.ts`, the `setup()` fake and the `registerLiveSession` call in the `pipeline` describe:

Replace

```ts
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
    }),
    refresh: vi.fn(),
```

with

```ts
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
      userId: 'user-1',
      keySaltFingerprint: 'fp-1',
    }),
    refresh: vi.fn(),
```

Replace

```ts
      decryptedKeys: keys,
      driveClient: {} as DriveClient,
    });
```

with

```ts
      decryptedKeys: keys,
      driveClient: {} as DriveClient,
      userId: 'user-1',
      keySaltFingerprint: 'fp-1',
    });
```

In `server/tests/http/routes-drive.test.ts`:

Replace

```ts
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
    }),
```

with

```ts
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
      userId: 'user-1',
      keySaltFingerprint: 'fp-1',
    }),
```

In `server/tests/observability/login-route.test.ts`:

Replace

```ts
      addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key }], primaryKeyIndex: 0 }],
    },
  };
```

with

```ts
      addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key }], primaryKeyIndex: 0 }],
    },
    userId: 'user-1',
    keySaltFingerprint: 'fp-1',
  };
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth/keys.test.ts tests/auth/proton-auth.test.ts`

Expected: FAIL: the existing key tests with `Cannot read properties of undefined (reading 'primaryKey')` (the destructuring finds no `decryptedKeys`), the user-id test with `expected { …(3) } to deeply equal { decryptedKeys: Any<Object>, userId: 'user-123' }`, the reason tests with `expected KeyDecryptError: … to match object { name: 'KeyDecryptError', …(1) }`, and the login test with `expected undefined to be 'user-123'`.

- [ ] **Step 3: Implement the key reasons and ids**

In `server/src/auth/keys.ts`, replace the `KeyDecryptError` class:

Replace

```ts
export class KeyDecryptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'KeyDecryptError';
  }
}
```

with

```ts
/**
 * Why the keys would not open. Only `user_key` (the passphrase no longer opens
 * a user key) means the passphrase is wrong, so only it makes passkey
 * unlocks stale (passkey-unlock spec §2).
 */
export type KeyDecryptReason = 'user_key' | 'no_keys' | 'no_addresses' | 'address_key';

export class KeyDecryptError extends Error {
  constructor(message: string, public readonly reason: KeyDecryptReason, public readonly cause?: unknown) {
    super(message);
    this.name = 'KeyDecryptError';
  }
}

export interface UnlockedKeys {
  decryptedKeys: DecryptedUserKey;
  /** Proton's `User.ID`: tells a different account from the same one typed differently. */
  userId: string;
}
```

Give every throw its reason, and return the ids:

Replace

```ts
export async function fetchAndDecryptUserKey(params: FetchAndDecryptParams): Promise<DecryptedUserKey> {
```

with

```ts
export async function fetchAndDecryptUserKey(params: FetchAndDecryptParams): Promise<UnlockedKeys> {
```

Replace

```ts
    throw new KeyDecryptError('User has no keys');
```

with

```ts
    throw new KeyDecryptError('User has no keys', 'no_keys');
```

Replace

```ts
      throw new KeyDecryptError(`Failed to decrypt user key ${k.ID}`, e);
```

with

```ts
      throw new KeyDecryptError(`Failed to decrypt user key ${k.ID}`, 'user_key', e);
```

Replace

```ts
  if (decryptedUserKeys.length === 0) throw new KeyDecryptError('No decryptable user keys');
```

with

```ts
  // Every user key inactive: not a passphrase problem.
  if (decryptedUserKeys.length === 0) throw new KeyDecryptError('No decryptable user keys', 'no_keys');
```

Replace

```ts
  if (enabled.length === 0) throw new KeyDecryptError('User has no enabled addresses');
```

with

```ts
  if (enabled.length === 0) throw new KeyDecryptError('User has no enabled addresses', 'no_addresses');
```

Replace

```ts
      throw new KeyDecryptError(`Failed to decrypt any address key for address ${addr.ID}`);
```

with

```ts
      throw new KeyDecryptError(`Failed to decrypt any address key for address ${addr.ID}`, 'address_key');
```

Replace

```ts
    throw new KeyDecryptError('No decryptable address keys');
```

with

```ts
    throw new KeyDecryptError('No decryptable address keys', 'address_key');
```

Replace

```ts
  return {
    primaryAddress: { email: primaryEntry.email, addressId: primaryEntry.addressId },
    primaryKey: primaryUserKey.key,
    addresses: decryptedAddresses,
  };
```

with

```ts
  return {
    decryptedKeys: {
      primaryAddress: { email: primaryEntry.email, addressId: primaryEntry.addressId },
      primaryKey: primaryUserKey.key,
      addresses: decryptedAddresses,
    },
    userId: User.ID,
  };
```

- [ ] **Step 4: Return them from login**

In `server/src/auth/srp.ts`:

Before

```ts
import { getSrp } from '../vendor/proton-srp/srp.js';
```

add

```ts
import { createHash } from 'node:crypto';
```

Replace

```ts
export interface LoginResult {
  session: ProtonSession;
  mailboxSecret: MailboxSecret;
  decryptedKeys: DecryptedUserKey;
}
```

with

```ts
export interface LoginResult {
  session: ProtonSession;
  mailboxSecret: MailboxSecret;
  decryptedKeys: DecryptedUserKey;
  /** Proton's `User.ID`. */
  userId: string;
  /** See keySaltFingerprint(). */
  keySaltFingerprint: string;
}

/**
 * SHA-256 (hex) of the primary user key's KeySalt. Not secret (the salt is
 * public to the account); it changes with the password, so a login can tell
 * that every passkey wrap holds an old passphrase (passkey-unlock spec §1).
 */
export function keySaltFingerprint(keySalt: string): string {
  return createHash('sha256').update(keySalt, 'utf8').digest('hex');
}
```

Replace

```ts
    const decryptedKeys = await fetchAndDecryptUserKey({
      api: this.api,
      uid: auth.UID,
      accessToken: auth.AccessToken,
      mailboxPasswordBytes,
    });

    return {
      session: {
        uid: auth.UID,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        email,
      },
      mailboxSecret,
      decryptedKeys,
    };
```

with

```ts
    const { decryptedKeys, userId } = await fetchAndDecryptUserKey({
      api: this.api,
      uid: auth.UID,
      accessToken: auth.AccessToken,
      mailboxPasswordBytes,
    });

    return {
      session: {
        uid: auth.UID,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        email,
      },
      mailboxSecret,
      decryptedKeys,
      userId,
      keySaltFingerprint: keySaltFingerprint(saltEntry.KeySalt),
    };
```

In `server/src/auth/live-session.ts`, the live session keeps both. The fingerprint is nullable: an unlock carries over the stored one, which Task 9 reads, and enrolment (Task 8) writes it only when known:

Replace

```ts
  decryptedKeys: DecryptedUserKey;
  driveClient: DriveClient;
}
```

with

```ts
  decryptedKeys: DecryptedUserKey;
  driveClient: DriveClient;
  /** Proton's `User.ID` for the account these keys belong to. */
  userId: string;
  /**
   * SHA-256 of the primary user key's KeySalt, which enrolment records. A
   * login computes it; an unlock carries over the stored one (null if none
   * was stored), since the passphrase it opened proves the salt unchanged.
   */
  keySaltFingerprint: string | null;
}
```

In `server/src/http/routes-auth.ts`, pass them on (Task 6 moves this into `startLiveSession`):

Replace

```ts
        decryptedKeys: result.decryptedKeys,
        driveClient,
      });
```

with

```ts
        decryptedKeys: result.decryptedKeys,
        driveClient,
        userId: result.userId,
        keySaltFingerprint: result.keySaltFingerprint,
      });
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth tests/http tests/observability && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS, and the typecheck is clean (including `evals/`, whose `login.decryptedKeys` is unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/keys.ts server/src/auth/srp.ts server/src/auth/live-session.ts server/src/http/routes-auth.ts server/tests/auth/keys.test.ts server/tests/auth/proton-auth.test.ts server/tests/http/routes-auth.test.ts server/tests/http/routes-documents.test.ts server/tests/http/routes-drive.test.ts server/tests/observability/login-route.test.ts
git commit -m "feat(auth): key-decrypt reasons, the Proton user id and the key-salt fingerprint"
```

---

### Task 5: `ProtonAuth.resume`, transient Proton errors, and a request timeout

**Files:**
- Modify: `server/src/auth/srp.ts`, `server/src/auth/proton-api.ts`
- Test: `server/tests/auth/proton-auth.test.ts`, `server/tests/auth/proton-api.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/tests/auth/proton-auth.test.ts`, widen two imports:

Replace

```ts
import type { ProtonAddress, ProtonApi, ProtonUser } from '../../src/auth/proton-api.js';
```

with

```ts
import { ProtonApiError, type ProtonAddress, type ProtonApi, type ProtonUser } from '../../src/auth/proton-api.js';
```

Replace

```ts
const { ProtonAuth, keySaltFingerprint } = await import('../../src/auth/srp.js');
```

with

```ts
const { ProtonAuth, SessionEndedError, isTransientProtonError, keySaltFingerprint } = await import('../../src/auth/srp.js');
```

and append. `resume` must not ask for the key salts: nothing shows that Proton serves them to a resumed or refreshed session, and the unlock doesn't need them (Task 9 carries over the stored fingerprint). Only undici's network failure counts as transient among `TypeError`s, so a bug still reaches the error report:

```ts
describe('ProtonAuth.resume', () => {
  const SESSION = { uid: 'uid-1', accessToken: 'at-1', refreshToken: 'rt-1', email: 'e@x.test' };
  const REFRESHED = { uid: 'uid-2', accessToken: 'at-2', refreshToken: 'rt-2', email: 'e@x.test' };
  const bytes = () => new TextEncoder().encode(passphrase);
  const expired = () => new ProtonApiError('Invalid access token', 401);
  const refreshed = () => vi.fn().mockResolvedValue({ UID: 'uid-2', AccessToken: 'at-2', RefreshToken: 'rt-2' });

  it('opens the keys with the stored tokens and the passphrase', async () => {
    const api = fakeApi();
    const onRefreshed = vi.fn();
    const result = await new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed });
    expect(result).toEqual({ session: SESSION, decryptedKeys: expect.any(Object), userId: 'user-123' });
    expect(result.decryptedKeys.primaryAddress.addressId).toBe('addr-1');
    expect(api.getUser).toHaveBeenCalledWith('uid-1', 'at-1');
    // The key salts aren't needed: the passkey's passphrase opened the keys, so the salt is unchanged.
    expect(api.getKeySalts).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token once and hands the new tokens over before the retry', async () => {
    const getUser = vi.fn().mockRejectedValueOnce(expired()).mockResolvedValue({ User: user });
    const api = fakeApi({ getUser, refresh: refreshed() });
    const onRefreshed = vi.fn();
    const result = await new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed });
    expect(api.refresh).toHaveBeenCalledWith('uid-1', 'rt-1');
    expect(onRefreshed).toHaveBeenCalledWith(REFRESHED);
    expect(onRefreshed.mock.invocationCallOrder[0]!).toBeLessThan(getUser.mock.invocationCallOrder[1]!);
    expect(getUser).toHaveBeenLastCalledWith('uid-2', 'at-2');
    expect(result.session).toEqual(REFRESHED);
  });

  it('has handed over the refreshed tokens when the retry then fails', async () => {
    const getUser = vi.fn().mockRejectedValueOnce(expired()).mockRejectedValueOnce(new ProtonApiError('HTTP 503', 503));
    const onRefreshed = vi.fn();
    await expect(new ProtonAuth(fakeApi({ getUser, refresh: refreshed() })).resume(SESSION, bytes(), { onRefreshed })).rejects.toMatchObject({
      status: 503,
    });
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  for (const status of [400, 401, 422]) {
    it(`says the session ended when Proton refuses the refresh with ${status}`, async () => {
      const api = fakeApi({
        getUser: vi.fn().mockRejectedValue(expired()),
        refresh: vi.fn().mockRejectedValue(new ProtonApiError('Invalid refresh token', status)),
      });
      const onRefreshed = vi.fn();
      await expect(new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed })).rejects.toBeInstanceOf(SessionEndedError);
      expect(onRefreshed).not.toHaveBeenCalled();
    });
  }

  it('passes a transient refresh failure through, as transient', async () => {
    const api = fakeApi({
      getUser: vi.fn().mockRejectedValue(expired()),
      refresh: vi.fn().mockRejectedValue(new ProtonApiError('HTTP 503', 503)),
    });
    const error = await new ProtonAuth(api).resume(SESSION, bytes(), { onRefreshed: vi.fn() }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SessionEndedError);
    expect(isTransientProtonError(error)).toBe(true);
  });

  it('reports a passphrase that no longer opens the user key as user_key', async () => {
    const api = fakeApi();
    await expect(
      new ProtonAuth(api).resume(SESSION, new TextEncoder().encode('an old passphrase'), { onRefreshed: vi.fn() }),
    ).rejects.toMatchObject({ name: 'KeyDecryptError', reason: 'user_key' });
    expect(api.refresh).not.toHaveBeenCalled();
  });
});

describe('isTransientProtonError', () => {
  it('is true for no answer, a timeout, rate limiting and server errors only', () => {
    expect(isTransientProtonError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientProtonError(Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') }))).toBe(true);
    expect(isTransientProtonError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(isTransientProtonError(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    // A bug, not the network: it must reach the error report.
    expect(isTransientProtonError(new TypeError('x'))).toBe(false);
    for (const status of [429, 500, 502, 503]) expect(isTransientProtonError(new ProtonApiError('x', status))).toBe(true);
    for (const status of [400, 401, 422]) expect(isTransientProtonError(new ProtonApiError('x', status))).toBe(false);
    expect(isTransientProtonError(new Error('other'))).toBe(false);
  });
});
```

In `server/tests/auth/proton-api.test.ts`, add a last test inside the describe. It stands in an already-expired signal for `AbortSignal.timeout`, so it doesn't wait 30 seconds:

Before

```ts
  });
});
```

add

```ts
  });

  it('gives up on a request after 30 seconds, as a TimeoutError', async () => {
    // A signal that has already timed out; the fake fetch rejects as fetch does.
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init.signal!.throwIfAborted();
      return new Response('{}');
    });
    const api = new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0');
    await expect(api.getUser('uid-1', 'at-1')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeout).toHaveBeenCalledWith(30_000);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth/proton-auth.test.ts tests/auth/proton-api.test.ts`

Expected: FAIL: the resume tests with `(intermediate value).resume is not a function`; `isTransientProtonError is not a function`; the timeout test with `expected TypeError: … to match object { name: 'TimeoutError' }` (no signal is passed, so the fake fetch reads `undefined.throwIfAborted`). The login test still passes.

- [ ] **Step 3: Implement `resume` and the classifier**

In `server/src/auth/srp.ts`, add the result type, the error and the classifier above the `LoginStage` type. `SessionEndedError` passes its cause through `ErrorOptions` (ES2022 lib), so it doesn't redeclare `cause`:

Before

```ts
/** Where a login got to; reported with failures to show which step broke. */
```

add

```ts
/**
 * What an unlock (spec §2) gets back: the keys open again, maybe with
 * refreshed tokens. No key-salt fingerprint: the passphrase from the passkey
 * opened the keys, so the salt is the one recorded at enrolment.
 */
export interface ResumeResult {
  /** The tokens in use: refreshed if the stored access token had expired. */
  session: ProtonSession;
  decryptedKeys: DecryptedUserKey;
  userId: string;
}

/** Proton refused the refresh token (400, 401 or 422): only a password login helps now. */
export class SessionEndedError extends Error {
  constructor(cause: ProtonApiError) {
    super('Proton ended the session', { cause });
    this.name = 'SessionEndedError';
  }
}

const SESSION_ENDED = new Set([400, 401, 422]);

/**
 * Worth trying again in a moment: rate limiting, a server error, no answer
 * at all, or no answer in time (ProtonApi's timeout). No answer is undici's
 * TypeError('fetch failed'), or a TypeError carrying the socket error as its
 * cause; any other TypeError is a bug and must be reported.
 */
export function isTransientProtonError(error: unknown): boolean {
  if (error instanceof ProtonApiError) return error.status === 429 || error.status >= 500;
  if (error instanceof TypeError) return error.message === 'fetch failed' || 'cause' in error;
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}
```

and `resume` in the class. It owns the private `ProtonApi`, so the routes never need it:

Before

```ts
  async refresh(session: ProtonSession): Promise<ProtonSession> {
```

add

```ts
  /**
   * Opens the keys again with stored tokens and a passphrase from a passkey
   * wrap: no password, no 2FA. An expired access token is refreshed once,
   * and `onRefreshed` hears of the new tokens the moment Proton issues them,
   * before the retry: Proton has already invalidated the old refresh token,
   * so they must be saved even if the retry then fails.
   *
   * Throws SessionEndedError when Proton refuses the refresh,
   * KeyDecryptError when the passphrase doesn't open the keys, and anything
   * else as it came (see isTransientProtonError).
   */
  async resume(
    session: ProtonSession,
    passphraseBytes: Uint8Array,
    opts: { onRefreshed: (session: ProtonSession) => void },
  ): Promise<ResumeResult> {
    try {
      return await this.openKeys(session, passphraseBytes);
    } catch (error) {
      if (!(error instanceof ProtonApiError && error.status === 401)) throw error;
    }
    let refreshed: ProtonSession;
    try {
      refreshed = await this.refresh(session);
    } catch (error) {
      if (error instanceof ProtonApiError && SESSION_ENDED.has(error.status)) throw new SessionEndedError(error);
      throw error;
    }
    opts.onRefreshed(refreshed);
    return this.openKeys(refreshed, passphraseBytes);
  }

  private async openKeys(session: ProtonSession, passphraseBytes: Uint8Array): Promise<ResumeResult> {
    const { decryptedKeys, userId } = await fetchAndDecryptUserKey({
      api: this.api,
      uid: session.uid,
      accessToken: session.accessToken,
      mailboxPasswordBytes: passphraseBytes,
    });
    return { session, decryptedKeys, userId };
  }
```

- [ ] **Step 4: Time out Proton requests**

In `server/src/auth/proton-api.ts`. Login, unlock and logout hold the auth mutex (Task 7) while Proton answers, so a hung request must not hold it for minutes. `AbortSignal.timeout` rejects with a `TimeoutError`, which `isTransientProtonError` counts as transient: an unlock answers 503 `proton_unavailable`. The SRP and login tests stub `fetch` and ignore the signal; the integration tests' requests take far less than 30 seconds.

Before

```ts
export class ProtonApi {
```

add

```ts
/**
 * How long one Proton request may take. Login, unlock and logout hold the
 * auth mutex while they wait, so a hung request must not hold it for the
 * minutes a socket can stall. A timeout rejects with a TimeoutError.
 */
const REQUEST_TIMEOUT_MS = 30_000;
```

Replace

```ts
        ...extraHeaders,
      },
    };
```

with

```ts
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth tests/observability && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/srp.ts server/src/auth/proton-api.ts server/tests/auth/proton-auth.test.ts server/tests/auth/proton-api.test.ts
git commit -m "feat(auth): resume a stored Proton session with a passphrase, and time out Proton requests"
```

---

### Task 6: `startLiveSession`, header-mode login and logout, and the new status

**Files:**
- Create: `server/tests/helpers/auth-app.ts`, `server/tests/http/routes-auth-header.test.ts`
- Modify: `server/src/http/routes-auth.ts`, `server/src/http/server.ts`
- Test: `server/tests/http/routes-auth.test.ts`

- [ ] **Step 1: Write the test helper**

Create `server/tests/helpers/auth-app.ts`. Tasks 6 to 9 share it: an app with a fake `ProtonAuth` (`login`, `refresh`, `resume`), in header mode unless told otherwise, plus the stores on the same database, and fixtures for one enrolled passkey:

```ts
import { vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from './test-db.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { PasskeyStore } from '../../src/auth/passkey-store.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { AuthMode } from '../../src/http/middleware.js';
import { createPipeline, type Pipeline } from '../../src/documents/pipeline.js';
import { fakePrepare } from '../documents/harness.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import type { LoginResult, ProtonAuth, ProtonSession, ResumeResult } from '../../src/auth/srp.js';
import type { DB } from '../../src/db.js';

export const KEY = Buffer.alloc(32, 1).toString('base64');
export const PROXY_USER = 'owine';
export const PROXY_HEADERS: Record<string, string> = { 'Remote-User': PROXY_USER };
export const HEADER_MODE: AuthMode = { kind: 'header', user: PROXY_USER, secret: null };
export const SESSION: ProtonSession = { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' };
export const PASSPHRASE = 'mailbox-passphrase-Northwind';

/** A passkey as the tests enrol it: the PRF output is never stored, so the tests keep it. */
export const CRED = 'cred-AAAAAAAAAAAAAAAA';
export const CRED_2 = 'cred-BBBBBBBBBBBBBBBB';
export const PRF = new Uint8Array(32).fill(7);
export const PRF_B64 = Buffer.from(PRF).toString('base64url');
export const SALT = new Uint8Array(32).fill(3);
export const LABEL = 'Northwind phone';

/** Real, decrypted keys: DriveClient's constructor reads them. */
export async function makeKeys(): Promise<DecryptedUserKey> {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: 'p', format: 'object',
  });
  const key = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  return {
    primaryAddress: { email: 'e@x.test', addressId: 'a1' },
    primaryKey: key,
    addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key }], primaryKeyIndex: 0 }],
  };
}

export function loginResult(keys: DecryptedUserKey, over: Partial<LoginResult> = {}): LoginResult {
  return {
    session: { ...SESSION },
    mailboxSecret: new MailboxSecret(new TextEncoder().encode(PASSPHRASE)),
    decryptedKeys: keys,
    userId: 'user-1',
    keySaltFingerprint: 'fp-1',
    ...over,
  };
}

export function resumeResult(keys: DecryptedUserKey, over: Partial<ResumeResult> = {}): ResumeResult {
  return { session: { ...SESSION }, decryptedKeys: keys, userId: 'user-1', ...over };
}

export interface FakeAuth {
  login: Mock;
  refresh: Mock;
  resume: Mock;
}

export interface AuthApp {
  app: ReturnType<typeof createApp>;
  db: DB;
  auth: FakeAuth;
  store: SessionStore;
  passkeys: PasskeyStore;
  pipeline: Pipeline | undefined;
  cleanup: () => void;
}

/**
 * An app with a fake ProtonAuth, in header mode unless told otherwise. With
 * `pipeline`, a document pipeline that is not started (tests start it). With
 * `db`, a second app on an existing database: a server restart.
 */
export function authApp(opts: { mode?: AuthMode; pipeline?: boolean; db?: DB } = {}): AuthApp {
  const cleanups: (() => void)[] = [];
  let db = opts.db;
  if (!db) {
    const t = createTestDb();
    db = t.db;
    cleanups.push(t.cleanup);
  }
  let pipeline: Pipeline | undefined;
  if (opts.pipeline) {
    const dir = mkdtempSync(join(tmpdir(), 'auth-app-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    pipeline = createPipeline({
      db,
      dataDir: dir,
      encryptionKey: KEY,
      defaults: { model: 'm', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
      analyzerFor: () => ({ analyze: vi.fn() }),
      liveSession: () => undefined,
      prepare: fakePrepare(),
    });
  }
  const auth: FakeAuth = { login: vi.fn(), refresh: vi.fn(), resume: vi.fn() };
  const app = createApp({
    db,
    encryptionKey: KEY,
    protonAuth: auth as unknown as ProtonAuth,
    authMode: opts.mode ?? HEADER_MODE,
    pipeline,
  });
  return {
    app,
    db,
    auth,
    store: new SessionStore(db, KEY),
    passkeys: new PasskeyStore(db, new AtRestCipher(KEY, 'passkeys')),
    pipeline,
    cleanup: () => {
      pipeline?.stop();
      for (const c of cleanups) c();
    },
  };
}

export function post(app: AuthApp['app'], path: string, body?: unknown, headers: Record<string, string> = PROXY_HEADERS) {
  return app.request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function get(app: AuthApp['app'], path: string, headers: Record<string, string> = PROXY_HEADERS) {
  return app.request(path, { headers });
}

export function del(app: AuthApp['app'], path: string, headers: Record<string, string> = PROXY_HEADERS) {
  return app.request(path, { method: 'DELETE', headers });
}

/** Signs in to Proton through the route, so a live session exists. */
export async function signIn(ctx: AuthApp, keys: DecryptedUserKey, over: Partial<LoginResult> = {}, email = 'e@x.test') {
  ctx.auth.login.mockResolvedValueOnce(loginResult(keys, over));
  const res = await post(ctx.app, '/api/auth/login', { email, password: 'p' });
  if (res.status !== 200) throw new Error(`login answered ${res.status}`);
}

export function seedPasskey(passkeys: PasskeyStore, credentialId = CRED, prf: Uint8Array = PRF): void {
  passkeys.add({ credentialId, label: LABEL, salt: SALT, prf, passphrase: new TextEncoder().encode(PASSPHRASE) });
}
```

- [ ] **Step 2: Write the failing tests**

Create `server/tests/http/routes-auth-header.test.ts` (Task 7 appends to it):

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions, getLiveSession, onLiveSessionRegistered } from '../../src/auth/live-session.js';
import { SETTING, readSetting, writeSetting } from '../../src/auth/app-settings.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { SESSION, authApp, get, loginResult, makeKeys, post, seedPasskey, signIn, type AuthApp } from '../helpers/auth-app.js';

let keys: DecryptedUserKey;
let ctx: AuthApp | null = null;
const offs: (() => void)[] = [];

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});

function setup(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  ctx = authApp(opts);
  return ctx;
}

describe('POST /api/auth/login in header mode', () => {
  it('needs the proxy user, so nothing starts a Proton session around Authelia', async () => {
    const { app, auth } = setup();
    const res = await post(app, '/api/auth/login', { email: 'e@x.test', password: 'p' }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_authenticated' });
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('registers the live session under the proxy sid, issues no cookie, and wakes the listeners', async () => {
    const { app, auth } = setup();
    const registered = vi.fn();
    offs.push(onLiveSessionRegistered(registered));
    auth.login.mockResolvedValue(loginResult(keys));
    const res = await post(app, '/api/auth/login', { email: 'e@x.test', password: 'p' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(getLiveSession('proxy')).toMatchObject({ userId: 'user-1', keySaltFingerprint: 'fp-1' });
    await vi.waitFor(() => expect(registered).toHaveBeenCalledWith(expect.objectContaining({ sid: 'proxy' })));
  });
});

describe('GET /api/auth/status', () => {
  it('says none, locked or live, with the passkey count and unlock available', async () => {
    const c = setup();
    const status = async () => (await get(c.app, '/api/auth/status', { 'Remote-User': 'owine', 'Remote-Email': 'me@example.test' })).json();
    expect(await status()).toEqual({ email: 'me@example.test', proton: 'none', passkeys: 0, unlockAvailable: true });
    c.store.save(SESSION);
    seedPasskey(c.passkeys);
    expect(await status()).toEqual({ email: 'e@x.test', proton: 'locked', passkeys: 1, unlockAvailable: true });
    await signIn(c, keys);
    expect(await status()).toEqual({ email: 'e@x.test', proton: 'live', passkeys: 1, unlockAvailable: true });
  });

  it('answers 401 without the proxy user', async () => {
    const { app } = setup();
    expect((await get(app, '/api/auth/status', {})).status).toBe(401);
  });
});

describe('POST /api/auth/logout in header mode', () => {
  it('needs the proxy user', async () => {
    const c = setup();
    await signIn(c, keys);
    expect((await post(c.app, '/api/auth/logout', undefined, {})).status).toBe(401);
    expect(c.store.load()).not.toBeNull();
    expect(getLiveSession('proxy')).toBeDefined();
  });

  it('forgets the Proton session and every passkey, with no cookie', async () => {
    const c = setup();
    await signIn(c, keys);
    seedPasskey(c.passkeys);
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-1');
    const res = await post(c.app, '/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(c.store.load()).toBeNull();
    expect(c.passkeys.count()).toBe(0);
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBeNull();
    expect(getLiveSession('proxy')).toBeUndefined();
    expect(await (await get(c.app, '/api/auth/status')).json()).toMatchObject({ proton: 'none', passkeys: 0 });
  });
});
```

In `server/tests/http/routes-auth.test.ts` (cookie mode), import the store:

After

```ts
import type { DecryptedUserKey } from '../../src/auth/keys.js';
```

add

```ts
import { PasskeyStore } from '../../src/auth/passkey-store.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
```

return the database from `setup()`:

Replace

```ts
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth });
  return { app, fakeAuth };
}
```

with

```ts
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth });
  return { app, fakeAuth, db };
}
```

pin the cookie-mode status shape:

Replace

```ts
    const res = await app.request('/api/auth/status', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'e@x.test' });
  });
});
```

with

```ts
    const res = await app.request('/api/auth/status', { headers: { cookie } });
    expect(res.status).toBe(200);
    // Cookie mode only signs in sids that logged in during this process: always live, never passkeys.
    expect(await res.json()).toEqual({ email: 'e@x.test', proton: 'live', passkeys: 0, unlockAvailable: false });
  });
});
```

and a logout test:

Before

```ts
  it('still clears Drive caches when the logout request has no cookie', async () => {
```

add

```ts
  it('removes every passkey unlock', async () => {
    const { app, fakeAuth, db } = setup();
    (fakeAuth.login as any).mockResolvedValue(makeLoginSuccess());
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const passkeys = new PasskeyStore(db, new AtRestCipher(KEY, 'passkeys'));
    passkeys.add({ credentialId: 'cred-AAAAAAAAAAAAAAAA', label: 'x', salt: new Uint8Array(32), prf: new Uint8Array(32), passphrase: new Uint8Array([1]) });
    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(passkeys.count()).toBe(0);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-auth-header.test.ts tests/http/routes-auth.test.ts`

Expected: FAIL, 7 tests: header-mode login answers 500 instead of 401 without the user and sets a `docscanner_sid` cookie with it; status is `{ email }` only; logout answers 200 without the user and sends `docscanner_sid=; Max-Age=0`; cookie-mode logout leaves the passkey (`expected 1 to be +0`).

- [ ] **Step 4: Implement**

Replace the whole of `server/src/http/routes-auth.ts`. `startLiveSession` is the work that used to sit inside `/login`; Task 9's unlock uses it too. The status reads `proton` the same way in both modes, so cookie mode (which only signs in sids that logged in during this process) always answers `live`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { TwoFactorRequiredError, type ProtonAuth, type ProtonSession } from '../auth/srp.js';
import type { SessionStore } from '../auth/session-store.js';
import type { DecryptedUserKey } from '../auth/keys.js';
import type { MailboxSecret } from '../auth/secrets/mailbox-password.js';
import type { PasskeyStore } from '../auth/passkey-store.js';
import { SETTING, deleteSetting } from '../auth/app-settings.js';
import {
  PROXY_SID,
  forgetAllSessions,
  issueSession,
  revokeAllSessions,
  sessionMiddleware,
  type AuthContext,
  type AuthMode,
} from './middleware.js';
import { logger } from '../logger.js';
import { captureAuthFailure } from '../observability/report.js';
import { DriveClient } from '../drive/client.js';
import { getAnyLiveSession, getLiveSession, registerLiveSession } from '../auth/live-session.js';
import type { DB } from '../db.js';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

type Env = { Variables: { auth?: AuthContext } };

/** GET /status (passkey-unlock spec §1). Unlock answers with it too. */
export interface AuthStatus {
  email: string;
  /** `live`: keys in memory. `locked`: tokens stored, no keys. `none`: nothing stored. */
  proton: 'live' | 'locked' | 'none';
  passkeys: number;
  /** Header mode only: the PWA hides every passkey control otherwise. */
  unlockAvailable: boolean;
}

export interface AuthRoutesDeps {
  store: SessionStore;
  protonAuth: ProtonAuth;
  db: DB;
  encryptionKey: string;
  passkeys: PasskeyStore;
  authMode: AuthMode;
  appVersion?: string;
  secureCookie?: boolean;
}

export function authRoutes(deps: AuthRoutesDeps) {
  const header = deps.authMode.kind === 'header';
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store, deps.authMode));

  function status(email: string, sid: string): AuthStatus {
    const proton = getLiveSession(sid) ? 'live' : deps.store.storedEmail() !== null ? 'locked' : 'none';
    return { email, proton, passkeys: deps.passkeys.count(), unlockAvailable: header };
  }

  /**
   * Builds the Drive client and registers the live session. Registering
   * runs the onLiveSessionRegistered listeners, so the worker resumes what
   * waited for a login (pipeline.ts). Login and unlock both start here.
   */
  async function startLiveSession(s: {
    sid: string;
    session: ProtonSession;
    mailboxSecret: MailboxSecret;
    decryptedKeys: DecryptedUserKey;
    userId: string;
    keySaltFingerprint: string;
  }): Promise<void> {
    const driveClient = new DriveClient({
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
      user: s.decryptedKeys,
      session: s.session,
      protonAuth: deps.protonAuth,
      // The SDK's HTTP adapter refreshes the access token on a 401. Persist
      // the rotated tokens, or the next process restart resumes with a
      // refresh token Proton has already invalidated.
      onSessionRefreshed: (session) => {
        deps.store.save(session);
        logger.info({ email: session.email }, 'proton session refreshed');
      },
    });
    registerLiveSession({
      sid: s.sid,
      session: s.session,
      mailboxSecret: s.mailboxSecret,
      decryptedKeys: s.decryptedKeys,
      driveClient,
      userId: s.userId,
      keySaltFingerprint: s.keySaltFingerprint,
    });
  }

  r.post('/login', async (c) => {
    // Header mode: only the proxy's user may start a Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    const parseResult = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parseResult.success) return c.json({ error: 'invalid_input' }, 400);

    const { email, password, totp } = parseResult.data;
    const remoteUser = c.req.header('Remote-User');
    // ProtonAuth.login reports its own failures (and knows which are typos);
    // this only covers what fails after Proton has accepted the login.
    let loggedIn = false;
    try {
      const result = await deps.protonAuth.login(email, password, totp);
      loggedIn = true;
      deps.store.save(result.session);
      // Header mode keeps one live session, which each login replaces; no cookie.
      const sid = header ? PROXY_SID : issueSession(c, deps.secureCookie ?? true);
      await startLiveSession({
        sid,
        session: result.session,
        mailboxSecret: result.mailboxSecret,
        decryptedKeys: result.decryptedKeys,
        userId: result.userId,
        keySaltFingerprint: result.keySaltFingerprint,
      });
      logger.info({ email, remoteUser }, 'login succeeded');
      return c.json({ ok: true, email: result.session.email });
    } catch (e) {
      if (e instanceof TwoFactorRequiredError) return c.json({ error: 'totp_required' }, 422);
      if (loggedIn) captureAuthFailure(e, 'login', 'session');
      const status = (e as { status?: number }).status === 401 ? 401 : 500;
      logger.warn({ email, err: (e as Error).message }, 'login failed');
      return c.json({ error: 'auth_failed', reauth_required: true }, status as 401 | 500);
    }
  });

  r.post('/logout', async (c) => {
    // Header mode: only the proxy's user may forget the Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    // Drop the SDK's persisted caches before the live session goes away. They
    // are not account-scoped, so leaving them behind would serve one account's
    // entities to whoever logs in next.
    // Fall back to any live session so a stale or missing cookie still clears them.
    const driveClient = c.get('auth')?.liveSession?.driveClient ?? getAnyLiveSession()?.driveClient;
    if (driveClient) {
      try {
        await driveClient.clearCaches();
      } catch (err) {
        // Log the full error (pino's default err serializer keeps type + stack)
        // so a cache/DB failure on logout is diagnosable in production.
        logger.warn({ err }, 'failed to clear drive caches on logout');
      }
    }
    deps.store.clear();
    // "Sign out" means "forget my Proton access here": every wrap holds the passphrase.
    const passkeysRemoved = deps.passkeys.removeAll();
    deleteSetting(deps.db, SETTING.keySaltFingerprint);
    if (header) forgetAllSessions();
    else revokeAllSessions(c);
    logger.info({ passkeysRemoved }, 'logged out');
    return c.json({ ok: true });
  });

  r.get('/status', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'not_authenticated' }, 401);
    return c.json(status(auth.email, auth.sid));
  });

  return r;
}
```

In `server/src/http/server.ts`, make the store and pass it:

After

```ts
import { ProtonApi } from '../auth/proton-api.js';
```

add

```ts
import { PasskeyStore } from '../auth/passkey-store.js';
import { AtRestCipher } from '../crypto/at-rest.js';
```

After

```ts
  const authMode = deps.authMode ?? COOKIE_MODE;
```

add

```ts
  const passkeys = new PasskeyStore(deps.db, new AtRestCipher(deps.encryptionKey, 'passkeys'));
```

Replace

```ts
authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, authMode, appVersion
```

with

```ts
authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, passkeys, authMode, appVersion
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http tests/observability tests/auth && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS (the existing cookie-mode login tests still pass through `startLiveSession`); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/http/routes-auth.ts server/src/http/server.ts server/tests/helpers/auth-app.ts server/tests/http/routes-auth-header.test.ts server/tests/http/routes-auth.test.ts
git commit -m "feat(server): header-mode login and logout, and the Proton status"
```

---

### Task 7: The auth mutex and re-login semantics

**Files:**
- Create: `server/src/auth/mutex.ts`, `server/tests/auth/mutex.test.ts`
- Modify: `server/src/http/routes-auth.ts`, `server/src/http/server.ts`, `server/src/documents/pipeline.ts`, `server/src/drive/folder-cache-store.ts`
- Test: `server/tests/http/routes-auth-header.test.ts`, `server/tests/drive/folder-cache-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/auth/mutex.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/auth/mutex.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Mutex', () => {
  it('runs one call at a time, in arrival order', async () => {
    const m = new Mutex();
    const log: string[] = [];
    let release!: () => void;
    const first = m.run(async () => {
      log.push('first starts');
      await new Promise<void>((resolve) => { release = resolve; });
      log.push('first ends');
      return 'first';
    });
    const second = m.run(async () => {
      log.push('second');
      return 'second';
    });
    await tick();
    expect(log).toEqual(['first starts']);
    release();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(log).toEqual(['first starts', 'first ends', 'second']);
  });

  it('gives each call its own result, and a failure does not stop the next', async () => {
    const m = new Mutex();
    const failing = m.run(async () => {
      throw new Error('wrong password');
    });
    const next = m.run(async () => 'unlocked');
    await expect(failing).rejects.toThrow('wrong password');
    await expect(next).resolves.toBe('unlocked');
  });
});
```

In `server/tests/drive/folder-cache-store.test.ts`:

Before

```ts
  it('records a filing in the cached folder, so the next document sees the name', () => {
```

add

```ts
  it('forgets the tree on clear', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    s.save([{ linkId: 'L', path: '/Bills', files: [] }], new Date());
    s.clear();
    expect(s.load()).toBeNull();
  });
```

In `server/tests/http/routes-auth-header.test.ts`, add imports:

Replace

```ts
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { SESSION, authApp, get, loginResult, makeKeys, post, seedPasskey, signIn, type AuthApp } from '../helpers/auth-app.js';
```

with

```ts
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { DriveClient } from '../../src/drive/client.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { TREE } from '../documents/harness.js';
import { SESSION, authApp, get, loginResult, makeKeys, post, seedPasskey, signIn, type AuthApp } from '../helpers/auth-app.js';
```

and append:

```ts
describe('signing in again', () => {
  it('never logs out first: the stored session is replaced and the passkeys stay', async () => {
    const c = setup();
    const clear = vi.spyOn(SessionStore.prototype, 'clear');
    const clearCaches = vi.spyOn(DriveClient.prototype, 'clearCaches');
    await signIn(c, keys);
    seedPasskey(c.passkeys);
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-1');
    await signIn(c, keys, { session: { ...SESSION, accessToken: 'a2' } });
    expect(clear).not.toHaveBeenCalled();
    expect(clearCaches).not.toHaveBeenCalled();
    expect(c.store.load()?.accessToken).toBe('a2');
    expect(c.passkeys.count()).toBe(1);
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-1');
  });

  it('as a different Proton account, forgets the old session, then clears the caches, the folder cache and the passkeys', async () => {
    const c = setup({ pipeline: true });
    await signIn(c, keys, { userId: 'user-A' });
    c.pipeline!.folderCache.save(TREE, new Date());
    seedPasskey(c.passkeys);
    const seen: (string | undefined)[] = [];
    vi.spyOn(DriveClient.prototype, 'clearCaches').mockImplementation(async () => {
      seen.push(getLiveSession('proxy')?.userId);
    });
    await signIn(c, keys, { userId: 'user-B' });
    // Account A's session was gone before anything was cleared, and B's not yet registered.
    expect(seen).toEqual([undefined]);
    expect(getLiveSession('proxy')?.userId).toBe('user-B');
    expect(c.pipeline!.folderCache.load()).toBeNull();
    expect(c.passkeys.count()).toBe(0);
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-B');
  });

  it('leaves no live session, and the old account id, when switching accounts fails part-way', async () => {
    const c = setup({ pipeline: true });
    await signIn(c, keys, { userId: 'user-A' });
    vi.spyOn(DriveClient.prototype, 'clearCaches').mockRejectedValue(new Error('disk full'));
    const second = loginResult(keys, { userId: 'user-B', session: { ...SESSION, accessToken: 'b' } });
    c.auth.login.mockResolvedValueOnce(second);
    const res = await post(c.app, '/api/auth/login', { email: 'b@x.test', password: 'p' });
    expect(res.status).toBe(500);
    // Account A's keys went with its session; B's tokens are stored, locked.
    expect(getLiveSession('proxy')).toBeUndefined();
    expect(c.store.load()?.accessToken).toBe('b');
    // So the next login still sees a different account, and clears again.
    expect(readSetting(c.db, SETTING.protonUserId)).toBe('user-A');
    await expect(second.mailboxSecret.use(() => 1)).rejects.toThrow('already disposed');
  });

  it('treats an email that differs only in case as the same account', async () => {
    const c = setup({ pipeline: true });
    await signIn(c, keys);
    c.pipeline!.folderCache.save(TREE, new Date());
    seedPasskey(c.passkeys);
    const clearCaches = vi.spyOn(DriveClient.prototype, 'clearCaches');
    await signIn(c, keys, {}, 'E@X.TEST');
    expect(clearCaches).not.toHaveBeenCalled();
    expect(c.pipeline!.folderCache.load()).not.toBeNull();
    expect(c.passkeys.count()).toBe(1);
  });

  it('clears nothing on the first login after this ships (no stored user id)', async () => {
    const c = setup();
    seedPasskey(c.passkeys);
    await signIn(c, keys);
    expect(c.passkeys.count()).toBe(1);
  });

  it('removes the passkeys when the key salt changed, and leaves Settings a notice', async () => {
    const c = setup();
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-old');
    seedPasskey(c.passkeys);
    await signIn(c, keys);
    expect(c.passkeys.count()).toBe(0);
    expect(readSetting(c.db, SETTING.removedNotice)).toBe('password_changed');
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBeNull();
  });

  it('leaves no notice when a changed key salt had no passkeys to remove', async () => {
    const c = setup();
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-old');
    await signIn(c, keys);
    expect(readSetting(c.db, SETTING.removedNotice)).toBeNull();
  });

  it('keeps the passkeys when the key salt is unchanged', async () => {
    const c = setup();
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-1');
    seedPasskey(c.passkeys);
    await signIn(c, keys);
    expect(c.passkeys.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/auth/mutex.test.ts tests/drive/folder-cache-store.test.ts tests/http/routes-auth-header.test.ts`

Expected: FAIL: `Cannot find module '../../src/auth/mutex.js'`; `s.clear is not a function`; `expected null to be 'user-1'` (no user id is stored); `expected [] to deeply equal [ undefined ]` (nothing cleared); `expected 200 to be 500` (the failing cache clear is never reached); `expected 1 to be +0` (a changed key salt keeps the passkeys). The email-case, first-login, no-notice and unchanged-salt tests already pass: they guard against over-clearing.

- [ ] **Step 3: Implement the mutex and the folder-cache clear**

Create `server/src/auth/mutex.ts`:

```ts
/**
 * Runs async work one call at a time, in arrival order. Each call does its
 * own work when its turn comes and gets its own result: a call never
 * receives another's (passkey-unlock spec, Concurrency). Sharing results
 * could turn a wrong password into a success.
 */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => fn());
    // The next call waits for this one to settle, however it ends.
    this.#tail = result.catch(() => {});
    return result;
  }
}
```

In `server/src/drive/folder-cache-store.ts`:

Before

```ts
  save(tree: TreeFolder[], walkedAt: Date): void {
```

add

```ts
  /** Forgets the tree: another Proton account's folders must never be offered (passkey-unlock spec). */
  clear(): void {
    this.db.prepare('DELETE FROM folder_cache WHERE id = 1').run();
  }
```

In `server/src/documents/pipeline.ts`, the pipeline offers it to the auth routes:

Before

```ts
  /** Starts the worker's timers and subscribes it to logins. */
  start(): void;
```

add

```ts
  /**
   * What a login as a different Proton account must not inherit: the cached
   * folder tree. The auth routes call it (passkey-unlock spec, Decisions).
   */
  clearAccountData(): void;
```

Replace

```ts
    worker,
    start() {
```

with

```ts
    worker,
    clearAccountData() {
      folderCache.clear();
    },
    start() {
```

In `server/src/http/server.ts`, pass the callback (a no-op without a pipeline):

Replace

```ts
  app.route('/api/auth', authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, passkeys, authMode, appVersion: deps.appVersion, secureCookie: deps.secureCookie }));
```

with

```ts
  app.route('/api/auth', authRoutes({
    store,
    protonAuth,
    db: deps.db,
    encryptionKey: deps.encryptionKey,
    passkeys,
    authMode,
    clearAccountData: () => deps.pipeline?.clearAccountData(),
    appVersion: deps.appVersion,
    secureCookie: deps.secureCookie,
  }));
```

- [ ] **Step 4: Implement re-login in the auth routes**

In `server/src/http/routes-auth.ts`, the imports:

Replace

```ts
import { SETTING, deleteSetting } from '../auth/app-settings.js';
```

with

```ts
import { SETTING, deleteSetting, readSetting, writeSetting } from '../auth/app-settings.js';
import { Mutex } from '../auth/mutex.js';
```

the deps:

Replace

```ts
  passkeys: PasskeyStore;
  authMode: AuthMode;
  appVersion?: string;
```

with

```ts
  passkeys: PasskeyStore;
  authMode: AuthMode;
  /** Forgets what belongs to a previous Proton account outside the auth tables (the folder cache). */
  clearAccountData: () => void;
  appVersion?: string;
```

one mutex per app, shared by login, unlock (Task 9) and logout:

After

```ts
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store, deps.authMode));
```

add

```ts
  // Login, unlock and logout take turns: two Proton calls at once could each
  // refresh the one refresh token, and Proton would reject the second.
  const mutex = new Mutex();
```

`startLiveSession` now disposes the passphrase if anything fails (no session will own it), and clears the SDK caches on the new client, before registering it, when told to. Replace it:

Replace

```ts
  /**
   * Builds the Drive client and registers the live session. Registering
   * runs the onLiveSessionRegistered listeners, so the worker resumes what
   * waited for a login (pipeline.ts). Login and unlock both start here.
   */
  async function startLiveSession(s: {
    sid: string;
    session: ProtonSession;
    mailboxSecret: MailboxSecret;
    decryptedKeys: DecryptedUserKey;
    userId: string;
    keySaltFingerprint: string;
  }): Promise<void> {
    const driveClient = new DriveClient({
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
      user: s.decryptedKeys,
      session: s.session,
      protonAuth: deps.protonAuth,
      // The SDK's HTTP adapter refreshes the access token on a 401. Persist
      // the rotated tokens, or the next process restart resumes with a
      // refresh token Proton has already invalidated.
      onSessionRefreshed: (session) => {
        deps.store.save(session);
        logger.info({ email: session.email }, 'proton session refreshed');
      },
    });
    registerLiveSession({
      sid: s.sid,
      session: s.session,
      mailboxSecret: s.mailboxSecret,
      decryptedKeys: s.decryptedKeys,
      driveClient,
      userId: s.userId,
      keySaltFingerprint: s.keySaltFingerprint,
    });
  }
```

with

```ts
  /**
   * Builds the Drive client and registers the live session. Registering
   * runs the onLiveSessionRegistered listeners, so the worker resumes what
   * waited for a login (pipeline.ts). Login and unlock both start here. On a
   * failure the passphrase is disposed: no session will ever own it.
   */
  async function startLiveSession(s: {
    sid: string;
    session: ProtonSession;
    mailboxSecret: MailboxSecret;
    decryptedKeys: DecryptedUserKey;
    userId: string;
    keySaltFingerprint: string;
    /** Another Proton account: clear the entities and event-id caches before the session can use them. */
    clearDriveCaches?: boolean;
  }): Promise<void> {
    try {
      await registerNewSession(s);
    } catch (err) {
      s.mailboxSecret.dispose();
      throw err;
    }
  }

  async function registerNewSession(s: Parameters<typeof startLiveSession>[0]): Promise<void> {
    const driveClient = new DriveClient({
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
      user: s.decryptedKeys,
      session: s.session,
      protonAuth: deps.protonAuth,
      // The SDK's HTTP adapter refreshes the access token on a 401. Persist
      // the rotated tokens, or the next process restart resumes with a
      // refresh token Proton has already invalidated.
      onSessionRefreshed: (session) => {
        deps.store.save(session);
        logger.info({ email: session.email }, 'proton session refreshed');
      },
    });
    // They are not account-scoped; the new client clears the shared tables.
    if (s.clearDriveCaches) await driveClient.clearCaches();
    registerLiveSession({
      sid: s.sid,
      session: s.session,
      mailboxSecret: s.mailboxSecret,
      decryptedKeys: s.decryptedKeys,
      driveClient,
      userId: s.userId,
      keySaltFingerprint: s.keySaltFingerprint,
    });
  }
```

Replace the whole `/login` handler with the fingerprint check and the new handler. On a different account, the old live session is forgotten before the new tokens are stored, so a failure can never leave account A's keys beside account B's tokens. The user id is written last, so a login that fails after clearing leaves the old id, and the next login clears again:

Replace

```ts
  r.post('/login', async (c) => {
    // Header mode: only the proxy's user may start a Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    const parseResult = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parseResult.success) return c.json({ error: 'invalid_input' }, 400);

    const { email, password, totp } = parseResult.data;
    const remoteUser = c.req.header('Remote-User');
    // ProtonAuth.login reports its own failures (and knows which are typos);
    // this only covers what fails after Proton has accepted the login.
    let loggedIn = false;
    try {
      const result = await deps.protonAuth.login(email, password, totp);
      loggedIn = true;
      deps.store.save(result.session);
      // Header mode keeps one live session, which each login replaces; no cookie.
      const sid = header ? PROXY_SID : issueSession(c, deps.secureCookie ?? true);
      await startLiveSession({
        sid,
        session: result.session,
        mailboxSecret: result.mailboxSecret,
        decryptedKeys: result.decryptedKeys,
        userId: result.userId,
        keySaltFingerprint: result.keySaltFingerprint,
      });
      logger.info({ email, remoteUser }, 'login succeeded');
      return c.json({ ok: true, email: result.session.email });
    } catch (e) {
      if (e instanceof TwoFactorRequiredError) return c.json({ error: 'totp_required' }, 422);
      if (loggedIn) captureAuthFailure(e, 'login', 'session');
      const status = (e as { status?: number }).status === 401 ? 401 : 500;
      logger.warn({ email, err: (e as Error).message }, 'login failed');
      return c.json({ error: 'auth_failed', reauth_required: true }, status as 401 | 500);
    }
  });
```

with

```ts
  /**
   * A changed key salt means a changed password: every wrap holds the old
   * passphrase (spec §1). Says so to Settings only if a passkey was removed.
   */
  function dropStalePasskeys(fingerprint: string): void {
    const stored = readSetting(deps.db, SETTING.keySaltFingerprint);
    if (stored === null || stored === fingerprint) return;
    const removed = deps.passkeys.removeAll();
    deleteSetting(deps.db, SETTING.keySaltFingerprint);
    if (removed > 0) writeSetting(deps.db, SETTING.removedNotice, 'password_changed');
    logger.info({ removed }, 'proton key salt changed; passkey unlocks removed');
  }

  r.post('/login', async (c) => {
    // Header mode: only the proxy's user may start a Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    const parseResult = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parseResult.success) return c.json({ error: 'invalid_input' }, 400);

    const { email, password, totp } = parseResult.data;
    const remoteUser = c.req.header('Remote-User');
    return mutex.run(async (): Promise<Response> => {
      // ProtonAuth.login reports its own failures (and knows which are typos);
      // this only covers what fails after Proton has accepted the login.
      let loggedIn = false;
      try {
        const result = await deps.protonAuth.login(email, password, totp);
        loggedIn = true;
        // Never a logout first: it would remove the passkeys. Compared by
        // User.ID, since one account can be typed as different emails.
        const previousUserId = readSetting(deps.db, SETTING.protonUserId);
        const otherAccount = previousUserId !== null && previousUserId !== result.userId;
        if (otherAccount) {
          // First the old account's live session, before the new tokens are
          // stored: a failure below must never leave A's keys beside B's tokens.
          forgetAllSessions();
          deps.clearAccountData();
          deps.passkeys.removeAll();
          deleteSetting(deps.db, SETTING.keySaltFingerprint);
          deleteSetting(deps.db, SETTING.removedNotice);
          logger.info('a different proton account signed in; cleared the previous account data');
        } else {
          dropStalePasskeys(result.keySaltFingerprint);
        }
        deps.store.save(result.session);
        // Header mode keeps one live session, which each login replaces; no cookie.
        const sid = header ? PROXY_SID : issueSession(c, deps.secureCookie ?? true);
        await startLiveSession({
          sid,
          session: result.session,
          mailboxSecret: result.mailboxSecret,
          decryptedKeys: result.decryptedKeys,
          userId: result.userId,
          keySaltFingerprint: result.keySaltFingerprint,
          clearDriveCaches: otherAccount,
        });
        // Last: if anything above failed, the next login still sees the old account and clears again.
        writeSetting(deps.db, SETTING.protonUserId, result.userId);
        logger.info({ email, remoteUser }, 'login succeeded');
        return c.json({ ok: true, email: result.session.email });
      } catch (e) {
        if (e instanceof TwoFactorRequiredError) return c.json({ error: 'totp_required' }, 422);
        if (loggedIn) captureAuthFailure(e, 'login', 'session');
        const status = (e as { status?: number }).status === 401 ? 401 : 500;
        logger.warn({ email, err: (e as Error).message }, 'login failed');
        return c.json({ error: 'auth_failed', reauth_required: true }, status as 401 | 500);
      }
    });
  });
```

Replace the `/logout` handler, so it takes its turn too:

Replace

```ts
  r.post('/logout', async (c) => {
    // Header mode: only the proxy's user may forget the Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    // Drop the SDK's persisted caches before the live session goes away. They
    // are not account-scoped, so leaving them behind would serve one account's
    // entities to whoever logs in next.
    // Fall back to any live session so a stale or missing cookie still clears them.
    const driveClient = c.get('auth')?.liveSession?.driveClient ?? getAnyLiveSession()?.driveClient;
    if (driveClient) {
      try {
        await driveClient.clearCaches();
      } catch (err) {
        // Log the full error (pino's default err serializer keeps type + stack)
        // so a cache/DB failure on logout is diagnosable in production.
        logger.warn({ err }, 'failed to clear drive caches on logout');
      }
    }
    deps.store.clear();
    // "Sign out" means "forget my Proton access here": every wrap holds the passphrase.
    const passkeysRemoved = deps.passkeys.removeAll();
    deleteSetting(deps.db, SETTING.keySaltFingerprint);
    if (header) forgetAllSessions();
    else revokeAllSessions(c);
    logger.info({ passkeysRemoved }, 'logged out');
    return c.json({ ok: true });
  });
```

with

```ts
  r.post('/logout', async (c) => {
    // Header mode: only the proxy's user may forget the Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    // In turn: an unlock finishing after this would bring the session back.
    return mutex.run(async (): Promise<Response> => {
      // Drop the SDK's persisted caches before the live session goes away. They
      // are not account-scoped, so leaving them behind would serve one account's
      // entities to whoever logs in next.
      // Fall back to any live session so a stale or missing cookie still clears them.
      const driveClient = c.get('auth')?.liveSession?.driveClient ?? getAnyLiveSession()?.driveClient;
      if (driveClient) {
        try {
          await driveClient.clearCaches();
        } catch (err) {
          // Log the full error (pino's default err serializer keeps type + stack)
          // so a cache/DB failure on logout is diagnosable in production.
          logger.warn({ err }, 'failed to clear drive caches on logout');
        }
      }
      deps.store.clear();
      // "Sign out" means "forget my Proton access here": every wrap holds the passphrase.
      const passkeysRemoved = deps.passkeys.removeAll();
      deleteSetting(deps.db, SETTING.keySaltFingerprint);
      if (header) forgetAllSessions();
      else revokeAllSessions(c);
      logger.info({ passkeysRemoved }, 'logged out');
      return c.json({ ok: true });
    });
  });
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http tests/auth tests/drive/folder-cache-store.test.ts tests/observability && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/mutex.ts server/src/http/routes-auth.ts server/src/http/server.ts server/src/documents/pipeline.ts server/src/drive/folder-cache-store.ts server/tests/auth/mutex.test.ts server/tests/drive/folder-cache-store.test.ts server/tests/http/routes-auth-header.test.ts
git commit -m "feat(server): take turns on Proton sign-ins, and clear a previous account's data"
```

---

### Task 8: Passkey enrolment, listing and removal routes

**Files:**
- Create: `server/src/http/routes-passkeys.ts`, `server/tests/http/routes-passkeys.test.ts`
- Modify: `server/src/http/middleware.ts`, `server/src/http/server.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/http/routes-passkeys.test.ts`. The expired-salt test moves `Date.now` past the 5 minutes; the restart test builds a second app on the same database. A live session that knows no fingerprint (an unlock with none stored) must leave the recorded one alone:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids, COOKIE_MODE } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { DriveClient } from '../../src/drive/client.js';
import { SETTING, readSetting, writeSetting } from '../../src/auth/app-settings.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import {
  CRED,
  CRED_2,
  LABEL,
  PASSPHRASE,
  PRF,
  PRF_B64,
  SESSION,
  authApp,
  del,
  get,
  makeKeys,
  post,
  seedPasskey,
  signIn,
  type AuthApp,
} from '../helpers/auth-app.js';

let keys: DecryptedUserKey;
const apps: AuthApp[] = [];

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  for (const a of apps.splice(0)) a.cleanup();
  vi.restoreAllMocks();
});

function setup(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  const a = authApp(opts);
  apps.push(a);
  return a;
}

async function live(): Promise<AuthApp> {
  const c = setup();
  await signIn(c, keys);
  return c;
}

async function begin(c: AuthApp): Promise<{ salt: string; userHandle: string; excludeCredentials: string[] }> {
  const res = await post(c.app, '/api/passkeys/begin');
  expect(res.status).toBe(200);
  return res.json();
}

const add = (c: AuthApp, body: Record<string, unknown>) => post(c.app, '/api/passkeys', body);
const text = (r: unknown) => (r instanceof Uint8Array ? new TextDecoder().decode(r) : r);

describe('passkey enrolment', () => {
  it('begins with a fresh salt, a stable user handle and the passkeys to exclude', async () => {
    const c = await live();
    seedPasskey(c.passkeys);
    const first = await begin(c);
    const second = await begin(c);
    expect(Buffer.from(first.salt, 'base64url')).toHaveLength(32);
    expect(second.salt).not.toBe(first.salt);
    expect(Buffer.from(first.userHandle, 'base64url')).toHaveLength(16);
    expect(second.userHandle).toBe(first.userHandle);
    expect(first.excludeCredentials).toEqual([CRED]);
  });

  it('wraps the live passphrase for the passkey and records the key-salt fingerprint', async () => {
    const c = await live();
    const { salt } = await begin(c);
    const res = await add(c, { credentialId: CRED, salt, prf: PRF_B64, label: LABEL });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ credentialId: CRED, label: LABEL, lastUsedAt: null });
    expect(text(c.passkeys.unwrap(CRED, PRF))).toBe(PASSPHRASE);
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBe('fp-1');
  });

  it('keeps the recorded fingerprint when the live session knows none', async () => {
    const c = setup();
    // As after an unlock with no fingerprint recorded.
    registerLiveSession({
      sid: 'proxy',
      session: SESSION,
      mailboxSecret: new MailboxSecret(new TextEncoder().encode(PASSPHRASE)),
      decryptedKeys: keys,
      driveClient: {} as DriveClient,
      userId: 'user-1',
      keySaltFingerprint: null,
    });
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-stored');
    const { salt } = await begin(c);
    expect((await add(c, { credentialId: CRED, salt, prf: PRF_B64 })).status).toBe(201);
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBe('fp-stored');
  });

  it('needs live Proton keys', async () => {
    const c = setup();
    for (const res of [await post(c.app, '/api/passkeys/begin'), await add(c, { credentialId: CRED, salt: 'x', prf: PRF_B64 })]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'proton_not_live' });
    }
  });

  it('refuses an unknown, a used or an expired salt', async () => {
    const c = await live();
    const unknown = await add(c, { credentialId: CRED, salt: Buffer.alloc(32, 1).toString('base64url'), prf: PRF_B64 });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'invalid_enrolment' });

    const { salt } = await begin(c);
    expect((await add(c, { credentialId: CRED, salt, prf: PRF_B64 })).status).toBe(201);
    const reused = await add(c, { credentialId: CRED_2, salt, prf: PRF_B64 });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual({ error: 'invalid_enrolment' });

    const late = await begin(c);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    const expired = await add(c, { credentialId: CRED_2, salt: late.salt, prf: PRF_B64 });
    expect(await expired.json()).toEqual({ error: 'invalid_enrolment' });
  });

  it('loses a pending salt to a restart', async () => {
    const c = await live();
    const { salt } = await begin(c);
    // The same database, a new process: the live session survives only because tests share module state.
    const restarted = setup({ db: c.db });
    const res = await post(restarted.app, '/api/passkeys', { credentialId: CRED, salt, prf: PRF_B64 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_enrolment' });
  });

  it('refuses a PRF output that is not 32 bytes, and a malformed credential id', async () => {
    const c = await live();
    const { salt } = await begin(c);
    const short = await add(c, { credentialId: CRED, salt, prf: Buffer.alloc(16, 7).toString('base64url') });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: 'invalid_input' });
    for (const credentialId of ['short', 'has spaces in it, sixteen+', 'a/b/c/d/e/f/g/h/i/j', 'x'.repeat(257)]) {
      const res = await add(c, { credentialId, salt, prf: PRF_B64 });
      expect([credentialId, res.status]).toEqual([credentialId, 400]);
    }
    // Still pending: nothing above consumed it.
    expect((await add(c, { credentialId: CRED, salt, prf: PRF_B64 })).status).toBe(201);
  });

  it('trims and caps the label, and names an empty one "Passkey"', async () => {
    const c = await live();
    const long = await (await add(c, { credentialId: CRED, salt: (await begin(c)).salt, prf: PRF_B64, label: `  ${'é'.repeat(80)}  ` })).json();
    expect(long.label).toBe('é'.repeat(60));
    const empty = await (await add(c, { credentialId: CRED_2, salt: (await begin(c)).salt, prf: PRF_B64, label: '   ' })).json();
    expect(empty.label).toBe('Passkey');
  });
});

describe('listing and removing passkeys', () => {
  it('lists the passkeys, and says once that a password change removed them', async () => {
    const c = setup();
    seedPasskey(c.passkeys);
    const list = await (await get(c.app, '/api/passkeys')).json();
    expect(list).toEqual({ passkeys: [{ credentialId: CRED, label: LABEL, createdAt: expect.any(String), lastUsedAt: null }], notice: null });
    writeSetting(c.db, SETTING.removedNotice, 'password_changed');
    expect((await (await get(c.app, '/api/passkeys')).json()).notice).toBe('password_changed');
    expect((await (await get(c.app, '/api/passkeys')).json()).notice).toBeNull();
  });

  it('removes one passkey, then answers 404', async () => {
    const c = setup();
    seedPasskey(c.passkeys);
    expect((await del(c.app, `/api/passkeys/${CRED}`)).status).toBe(204);
    expect(c.passkeys.count()).toBe(0);
    expect((await del(c.app, `/api/passkeys/${CRED}`)).status).toBe(404);
    expect((await del(c.app, '/api/passkeys/bad')).status).toBe(404);
  });

  it('needs the proxy user', async () => {
    const c = setup();
    expect((await get(c.app, '/api/passkeys', {})).status).toBe(401);
    expect((await del(c.app, `/api/passkeys/${CRED}`, {})).status).toBe(401);
  });
});

describe('passkey routes in cookie mode', () => {
  it('do not exist', async () => {
    const c = setup({ mode: COOKIE_MODE });
    for (const res of [
      await post(c.app, '/api/passkeys/begin', undefined, {}),
      await post(c.app, '/api/passkeys', { credentialId: CRED, salt: 'x', prf: PRF_B64 }, {}),
      await get(c.app, '/api/passkeys', {}),
      await del(c.app, `/api/passkeys/${CRED}`, {}),
    ]) {
      expect(res.status).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-passkeys.test.ts`

Expected: FAIL, 11 tests: every route answers 404 (`expected 404 to be 200`, `expected 404 to be 409`, …). The cookie-mode test already passes, since nothing is mounted yet.

- [ ] **Step 3: Add the header-only guard**

In `server/src/http/middleware.ts`. Cookie mode answers 404 before the auth check, as the spec's Guards require:

Before

```ts
export function issueSession(c: Context<Env>, secureCookie: boolean = true): string {
```

add

```ts
/**
 * For routes that exist only in header mode (spec §1, Guards): passkeys
 * unlock after a restart, which only header mode can use. Cookie mode
 * answers 404; header mode without the proxy user, 401.
 */
export function headerOnly(mode: AuthMode): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (mode.kind !== 'header') return c.json({ error: 'not_found' }, 404);
    if (!c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    await next();
  };
}
```

- [ ] **Step 4: Implement the routes**

Create `server/src/http/routes-passkeys.ts`. `GET /` answers `{ passkeys, notice }` rather than a bare array, so Settings can say once why the passkeys went (see the deviations above):

```ts
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { SessionStore } from '../auth/session-store.js';
import { CREDENTIAL_ID, PRF_BYTES, decodeBase64url, shortId, type PasskeyStore } from '../auth/passkey-store.js';
import { SETTING, readSetting, takeSetting, writeSetting } from '../auth/app-settings.js';
import { logger } from '../logger.js';
import { headerOnly, sessionMiddleware, type AuthContext, type AuthMode } from './middleware.js';

type Env = { Variables: { auth?: AuthContext } };

/** How long a salt from /begin can be used. */
const PENDING_MS = 5 * 60 * 1000;
const MAX_LABEL_CHARS = 60;

const AddSchema = z
  .object({
    credentialId: z.string().regex(CREDENTIAL_ID),
    salt: z.string().min(1).max(100),
    prf: z.string().min(1).max(100),
    label: z.string().max(1000).optional(),
  })
  .strict();

/** The WebAuthn user handle: random, made once, so every passkey belongs to one user. */
function userHandle(db: DB): string {
  const existing = readSetting(db, SETTING.userHandle);
  if (existing !== null) return existing;
  const made = randomBytes(16).toString('base64url');
  writeSetting(db, SETTING.userHandle, made);
  return made;
}

/** Trimmed and capped in characters (not UTF-16 units); an empty label becomes "Passkey". */
function cleanLabel(label: string | undefined): string {
  return [...(label ?? '').trim()].slice(0, MAX_LABEL_CHARS).join('').trim() || 'Passkey';
}

/** Passkey enrolment, listing and removal (passkey-unlock spec §2). Header mode only. */
export function passkeyRoutes(deps: { db: DB; store: SessionStore; passkeys: PasskeyStore; authMode: AuthMode }) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store, deps.authMode), headerOnly(deps.authMode));
  // Salt (base64url) -> when it expires. In memory: a restart ends every enrolment under way.
  const pending = new Map<string, number>();
  const prune = (now: number) => {
    for (const [salt, expires] of pending) if (expires <= now) pending.delete(salt);
  };

  r.post('/begin', (c) => {
    // The server wraps the passphrase the live session holds.
    if (!c.get('auth')!.liveSession) return c.json({ error: 'proton_not_live' }, 409);
    const now = Date.now();
    prune(now);
    const salt = randomBytes(PRF_BYTES).toString('base64url');
    pending.set(salt, now + PENDING_MS);
    return c.json({
      salt,
      userHandle: userHandle(deps.db),
      excludeCredentials: deps.passkeys.saltsFor().map((p) => p.credentialId),
    });
  });

  r.post('/', async (c) => {
    const live = c.get('auth')!.liveSession;
    if (!live) return c.json({ error: 'proton_not_live' }, 409);
    const body = AddSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_input' }, 400);
    const { credentialId, salt, label } = body.data;
    prune(Date.now());
    // Unknown, expired, already used, or lost to a restart.
    if (!pending.has(salt)) return c.json({ error: 'invalid_enrolment' }, 400);
    const prf = decodeBase64url(body.data.prf);
    if (!prf || prf.length !== PRF_BYTES) return c.json({ error: 'invalid_input' }, 400);
    const entry = await live.mailboxSecret.use((passphrase) =>
      // The salt is one this server made, so it decodes.
      deps.passkeys.add({ credentialId, label: cleanLabel(label), salt: decodeBase64url(salt)!, prf, passphrase }),
    );
    pending.delete(salt);
    // What a later password login compares, to tell the password changed (spec §2).
    // An unlocked session with none known leaves the recorded one in place.
    if (live.keySaltFingerprint !== null) writeSetting(deps.db, SETTING.keySaltFingerprint, live.keySaltFingerprint);
    logger.info({ credential: shortId(credentialId) }, 'passkey added');
    return c.json(entry, 201);
  });

  r.get('/', (c) => {
    // Said once: Settings reads the list when it opens.
    const notice = takeSetting(deps.db, SETTING.removedNotice) === 'password_changed' ? 'password_changed' : null;
    return c.json({ passkeys: deps.passkeys.list(), notice });
  });

  r.delete('/:credentialId', (c) => {
    const credentialId = c.req.param('credentialId');
    if (!CREDENTIAL_ID.test(credentialId) || !deps.passkeys.remove(credentialId)) return c.json({ error: 'not_found' }, 404);
    logger.info({ credential: shortId(credentialId) }, 'passkey removed');
    return c.body(null, 204);
  });

  return r;
}
```

Mount it in `server/src/http/server.ts`:

After

```ts
import { authRoutes } from './routes-auth.js';
```

add

```ts
import { passkeyRoutes } from './routes-passkeys.js';
```

Before

```ts
  app.route('/api/drive', driveRoutes({ db: deps.db, store, authMode }));
```

add

```ts
  app.route('/api/passkeys', passkeyRoutes({ db: deps.db, store, passkeys, authMode }));
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http tests/auth && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/http/middleware.ts server/src/http/routes-passkeys.ts server/src/http/server.ts server/tests/http/routes-passkeys.test.ts
git commit -m "feat(server): passkey enrolment routes"
```

---

### Task 9: Unlock routes

**Files:**
- Create: `server/tests/http/routes-unlock.test.ts`, `server/tests/observability/unlock-route.test.ts`
- Modify: `server/src/http/routes-auth.ts`, `server/src/observability/report.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/http/routes-unlock.test.ts`. `locked()` is the state after a restart: tokens stored, a passkey enrolled, no live session. The last test enrols through the routes, drops the live sessions as a restart would, unlocks with the same PRF output, and checks that no log call carried a secret:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids, COOKIE_MODE } from '../../src/http/middleware.js';
import { _resetLiveSessions, getLiveSession } from '../../src/auth/live-session.js';
import { ProtonApiError } from '../../src/auth/proton-api.js';
import { SessionEndedError } from '../../src/auth/srp.js';
import { KeyDecryptError, type DecryptedUserKey } from '../../src/auth/keys.js';
import { logger } from '../../src/logger.js';
import { SETTING, deleteSetting, writeSetting } from '../../src/auth/app-settings.js';
import {
  CRED,
  CRED_2,
  LABEL,
  PASSPHRASE,
  PRF_B64,
  SESSION,
  authApp,
  makeKeys,
  post,
  resumeResult,
  seedPasskey,
  signIn,
  type AuthApp,
} from '../helpers/auth-app.js';

let keys: DecryptedUserKey;
const apps: AuthApp[] = [];

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  for (const a of apps.splice(0)) a.cleanup();
  vi.restoreAllMocks();
});

/** Locked: Proton tokens stored, a passkey enrolled (with its fingerprint), no live session (a restart). */
function locked(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  const a = authApp(opts);
  apps.push(a);
  a.store.save(SESSION);
  seedPasskey(a.passkeys);
  writeSetting(a.db, SETTING.keySaltFingerprint, 'fp-enrolled');
  return a;
}

const unlock = (c: AuthApp, body: Record<string, unknown> = { credentialId: CRED, prf: PRF_B64 }) => post(c.app, '/api/auth/unlock', body);
const LIVE_STATUS = { email: 'e@x.test', proton: 'live', passkeys: 1, unlockAvailable: true };

function deferredResume(c: AuthApp): () => void {
  let release!: () => void;
  c.auth.resume.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(resumeResult(keys));
      }),
  );
  return () => release();
}

describe('POST /api/auth/unlock/begin', () => {
  it('lists every passkey with its salt', async () => {
    const c = locked();
    seedPasskey(c.passkeys, CRED_2);
    const res = await post(c.app, '/api/auth/unlock/begin');
    expect(await res.json()).toEqual({
      credentials: [
        { credentialId: CRED, salt: Buffer.alloc(32, 3).toString('base64url') },
        { credentialId: CRED_2, salt: Buffer.alloc(32, 3).toString('base64url') },
      ],
    });
  });

  it('answers 409 with no passkeys', async () => {
    const c = authApp();
    apps.push(c);
    const res = await post(c.app, '/api/auth/unlock/begin');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_passkeys' });
  });
});

describe('POST /api/auth/unlock', () => {
  it('opens the keys with the unwrapped passphrase, starts the live session and records the use', async () => {
    const c = locked();
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    const res = await unlock(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIVE_STATUS);
    const [session, passphrase, opts] = c.auth.resume.mock.calls[0]!;
    expect(session).toEqual(SESSION);
    expect(new TextDecoder().decode(passphrase as Uint8Array)).toBe(PASSPHRASE);
    expect(opts).toEqual({ onRefreshed: expect.any(Function) });
    // The fingerprint recorded at enrolment: the passphrase that opened the keys proves the salt unchanged.
    expect(getLiveSession('proxy')).toMatchObject({ userId: 'user-1', keySaltFingerprint: 'fp-enrolled' });
    expect(c.passkeys.list()[0]?.lastUsedAt).not.toBeNull();
  });

  it('starts the session with no fingerprint when none is recorded', async () => {
    const c = locked();
    deleteSetting(c.db, SETTING.keySaltFingerprint);
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    expect((await unlock(c)).status).toBe(200);
    expect(getLiveSession('proxy')?.keySaltFingerprint).toBeNull();
  });

  it('answers with the status, without touching Proton, when already live', async () => {
    const c = locked();
    await signIn(c, keys, { keySaltFingerprint: 'fp-enrolled' });
    const res = await unlock(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIVE_STATUS);
    expect(c.auth.resume).not.toHaveBeenCalled();
  });

  it('needs stored Proton tokens', async () => {
    const c = locked();
    c.store.clear();
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proton_login_required' });
  });

  it('answers 404 for a passkey it does not know, and 401 for a wrong PRF output', async () => {
    const c = locked();
    const unknown = await unlock(c, { credentialId: CRED_2, prf: PRF_B64 });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_passkey' });
    const wrong = await unlock(c, { credentialId: CRED, prf: Buffer.alloc(32, 8).toString('base64url') });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unlock_failed' });
    expect(c.auth.resume).not.toHaveBeenCalled();
  });

  it('refuses a malformed request', async () => {
    const c = locked();
    for (const body of [{ credentialId: 'short', prf: PRF_B64 }, { credentialId: CRED, prf: Buffer.alloc(16).toString('base64url') }, {}]) {
      expect((await unlock(c, body)).status).toBe(400);
    }
  });

  it('answers passkey_unreadable and removes only that passkey when its wrap will not open', async () => {
    const c = locked();
    seedPasskey(c.passkeys, CRED_2);
    c.db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(new Uint8Array(60), CRED);
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'passkey_unreadable' });
    expect(c.passkeys.list().map((p) => p.credentialId)).toEqual([CRED_2]);
  });

  it('saves refreshed tokens and starts the live session with them', async () => {
    const c = locked();
    const refreshed = { ...SESSION, accessToken: 'a2', refreshToken: 'r2' };
    c.auth.resume.mockImplementation(async (_s: unknown, _p: unknown, opts: { onRefreshed: (s: typeof SESSION) => void }) => {
      opts.onRefreshed(refreshed);
      return resumeResult(keys, { session: refreshed });
    });
    expect((await unlock(c)).status).toBe(200);
    expect(c.store.load()).toEqual(refreshed);
    expect(getLiveSession('proxy')?.session).toEqual(refreshed);
  });

  it('keeps refreshed tokens saved when the retry then fails, and answers 503', async () => {
    const c = locked();
    const refreshed = { ...SESSION, accessToken: 'a2', refreshToken: 'r2' };
    c.auth.resume.mockImplementation(async (_s: unknown, _p: unknown, opts: { onRefreshed: (s: typeof SESSION) => void }) => {
      opts.onRefreshed(refreshed);
      throw new ProtonApiError('HTTP 503', 503);
    });
    const res = await unlock(c);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'proton_unavailable' });
    expect(c.store.load()).toEqual(refreshed);
  });

  it('clears the stored session but keeps the passkeys when Proton ended the session', async () => {
    const c = locked();
    c.auth.resume.mockRejectedValue(new SessionEndedError(new ProtonApiError('Invalid refresh token', 400)));
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proton_login_required' });
    expect(c.store.load()).toBeNull();
    expect(c.passkeys.count()).toBe(1);
  });

  for (const [label, error] of [
    ['a network error', new TypeError('fetch failed')],
    ['a 5xx', new ProtonApiError('HTTP 502', 502)],
    ['rate limiting', new ProtonApiError('Too many requests', 429)],
  ] as const) {
    it(`answers 503 and changes nothing on ${label}`, async () => {
      const c = locked();
      c.auth.resume.mockRejectedValue(error);
      const res = await unlock(c);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'proton_unavailable' });
      expect(c.store.load()).toEqual(SESSION);
      expect(c.passkeys.count()).toBe(1);
      expect(getLiveSession('proxy')).toBeUndefined();
    });
  }

  it('removes every passkey when the passphrase no longer opens the user key', async () => {
    const c = locked();
    seedPasskey(c.passkeys, CRED_2);
    c.auth.resume.mockRejectedValue(new KeyDecryptError('Failed to decrypt user key k1', 'user_key'));
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'passkeys_stale' });
    expect(c.passkeys.count()).toBe(0);
    expect(c.store.load()).toEqual(SESSION);
  });

  for (const reason of ['no_keys', 'no_addresses', 'address_key'] as const) {
    it(`removes nothing on a ${reason} key failure`, async () => {
      const c = locked();
      c.auth.resume.mockRejectedValue(new KeyDecryptError('x', reason));
      expect((await unlock(c)).status).toBe(500);
      expect(c.passkeys.count()).toBe(1);
    });
  }

  it('resumes documents awaiting login through the live-session listener', async () => {
    const c = locked({ pipeline: true });
    const pipeline = c.pipeline!;
    vi.spyOn(pipeline.worker, 'start').mockImplementation(() => {});
    vi.spyOn(pipeline.worker, 'wake').mockResolvedValue();
    pipeline.start();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'aw', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'awaiting_login');
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    expect((await unlock(c)).status).toBe(200);
    await vi.waitFor(() => expect(pipeline.repo.get(doc.id)?.state).toBe('filing'));
  });

  it('runs two concurrent unlocks one after the other: the second finds the session live', async () => {
    const c = locked();
    const release = deferredResume(c);
    const first = unlock(c);
    const second = unlock(c);
    await vi.waitFor(() => expect(c.auth.resume).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await b.json()).toEqual(LIVE_STATUS);
    expect(c.auth.resume).toHaveBeenCalledTimes(1);
  });

  it('gives a login queued behind an unlock its own result: a wrong password still fails', async () => {
    const c = locked();
    const release = deferredResume(c);
    c.auth.login.mockRejectedValue(Object.assign(new Error('bad'), { status: 401 }));
    const unlocking = unlock(c);
    await vi.waitFor(() => expect(c.auth.resume).toHaveBeenCalled());
    const login = post(c.app, '/api/auth/login', { email: 'e@x.test', password: 'wrong' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(c.auth.login).not.toHaveBeenCalled();
    release();
    expect((await unlocking).status).toBe(200);
    const res = await login;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'auth_failed' });
  });

  it('needs the proxy user', async () => {
    const c = locked();
    expect((await post(c.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 }, {})).status).toBe(401);
    expect((await post(c.app, '/api/auth/unlock/begin', undefined, {})).status).toBe(401);
  });

  it('does not exist in cookie mode', async () => {
    const c = locked({ mode: COOKIE_MODE });
    expect((await post(c.app, '/api/auth/unlock/begin', undefined, {})).status).toBe(404);
    expect((await post(c.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 }, {})).status).toBe(404);
  });
});

describe('enrolling, then unlocking after a restart', () => {
  it('gets the same passphrase back, and logs no secret', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level));
    const c = authApp();
    apps.push(c);
    await signIn(c, keys);
    const { salt } = (await (await post(c.app, '/api/passkeys/begin')).json()) as { salt: string };
    expect((await post(c.app, '/api/passkeys', { credentialId: CRED, salt, prf: PRF_B64, label: LABEL })).status).toBe(201);
    // A wrong attempt too, so its log line is checked as well.
    await unlock(c, { credentialId: CRED, prf: Buffer.alloc(32, 8).toString('base64url') });

    // The restart: no live session; the stored tokens and the passkey remain.
    _resetLiveSessions();
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    expect((await unlock(c)).status).toBe(200);
    expect(new TextDecoder().decode(c.auth.resume.mock.calls[0]![1] as Uint8Array)).toBe(PASSPHRASE);

    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    for (const secret of [PRF_B64, Buffer.alloc(32, 8).toString('base64url'), LABEL, PASSPHRASE, salt, CRED]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain(CRED.slice(0, 8));
  });
});
```

Create `server/tests/observability/unlock-route.test.ts`. A `TypeError` that isn't undici's network failure is a bug: it must reach the error report and answer 500, not hide as a 503:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';
import { CRED, PRF_B64, SESSION, authApp, post, seedPasskey, type AuthApp } from '../helpers/auth-app.js';

const { events } = initRecordingSentry();

let ctx: AuthApp | null = null;
beforeEach(() => {
  events.length = 0;
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  vi.restoreAllMocks();
});

describe('POST /api/auth/unlock failure reporting', () => {
  it('reports a TypeError that is not a network failure, and answers 500', async () => {
    ctx = authApp();
    ctx.store.save(SESSION);
    seedPasskey(ctx.passkeys);
    ctx.auth.resume.mockRejectedValue(new TypeError('x'));
    const res = await post(ctx.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 });
    await flushEvents();
    expect(res.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({ 'auth.operation': 'unlock', 'auth.stage': 'keys' });
  });

  it('does not report a network failure, which answers 503', async () => {
    ctx = authApp();
    ctx.store.save(SESSION);
    seedPasskey(ctx.passkeys);
    ctx.auth.resume.mockRejectedValue(new TypeError('fetch failed'));
    const res = await post(ctx.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 });
    await flushEvents();
    expect(res.status).toBe(503);
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && NODE_OPTIONS=--import=tsx pnpm exec vitest run tests/http/routes-unlock.test.ts tests/observability/unlock-route.test.ts`

Expected: FAIL: neither route exists yet, so the unlock tests get 404 (the two concurrency tests fail when `vi.waitFor` gives up waiting for `resume`), and the reporting tests `expected 404 to be 500` / `to be 503`. The cookie-mode test already passes.

- [ ] **Step 3: Implement**

In `server/src/observability/report.ts`, an unlock failure is reported like a login one:

Replace

```ts
export function captureAuthFailure(error: unknown, operation: 'login', stage: string): void {
```

with

```ts
export function captureAuthFailure(error: unknown, operation: 'login' | 'unlock', stage: string): void {
```

In `server/src/http/routes-auth.ts`, replace the first five imports:

Replace

```ts
import { TwoFactorRequiredError, type ProtonAuth, type ProtonSession } from '../auth/srp.js';
import type { SessionStore } from '../auth/session-store.js';
import type { DecryptedUserKey } from '../auth/keys.js';
import type { MailboxSecret } from '../auth/secrets/mailbox-password.js';
import type { PasskeyStore } from '../auth/passkey-store.js';
```

with

```ts
import {
  SessionEndedError,
  TwoFactorRequiredError,
  isTransientProtonError,
  type ProtonAuth,
  type ProtonSession,
  type ResumeResult,
} from '../auth/srp.js';
import type { SessionStore } from '../auth/session-store.js';
import { KeyDecryptError, type DecryptedUserKey } from '../auth/keys.js';
import { MailboxSecret } from '../auth/secrets/mailbox-password.js';
import { CREDENTIAL_ID, PRF_BYTES, decodeBase64url, shortId, type PasskeyStore } from '../auth/passkey-store.js';
```

Replace

```ts
  PROXY_SID,
  forgetAllSessions,
  issueSession,
```

with

```ts
  PROXY_SID,
  forgetAllSessions,
  headerOnly,
  issueSession,
```

After

```ts
import { captureAuthFailure } from '../observability/report.js';
```

add

```ts
import { errorName } from '../observability/error-name.js';
```

An unlock carries over the fingerprint recorded at enrolment, which may be missing:

Replace

```ts
    userId: string;
    keySaltFingerprint: string;
    /** Another Proton account
```

with

```ts
    userId: string;
    keySaltFingerprint: string | null;
    /** Another Proton account
```

Add the body schema above `type Env`:

Before

```ts
type Env = { Variables: { auth?: AuthContext } };
```

add

```ts
const UnlockSchema = z
  .object({
    credentialId: z.string().regex(CREDENTIAL_ID),
    prf: z.string().min(1).max(100),
  })
  .strict();
```

and the two routes. The passphrase bytes are zeroed on every failure; on success the new `MailboxSecret` owns them. The session's fingerprint is the stored one: the passphrase that opened the keys proves the KeySalt unchanged since enrolment:

After

```ts
  r.get('/status', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'not_authenticated' }, 401);
    return c.json(status(auth.email, auth.sid));
  });
```

add

```ts
  // Spec §2, Unlock: the salts for one passkey prompt. Header mode only.
  r.post('/unlock/begin', headerOnly(deps.authMode), (c) => {
    const credentials = deps.passkeys
      .saltsFor()
      .map((p) => ({ credentialId: p.credentialId, salt: Buffer.from(p.salt).toString('base64url') }));
    if (credentials.length === 0) return c.json({ error: 'no_passkeys' }, 409);
    return c.json({ credentials });
  });

  // Spec §2, Unlock: a PRF output opens the passphrase, which opens the keys.
  r.post('/unlock', headerOnly(deps.authMode), async (c) => {
    const auth = c.get('auth')!;
    const body = UnlockSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_input' }, 400);
    const prf = decodeBase64url(body.data.prf);
    if (!prf || prf.length !== PRF_BYTES) return c.json({ error: 'invalid_input' }, 400);
    const { credentialId } = body.data;
    const credential = shortId(credentialId);
    return mutex.run(async (): Promise<Response> => {
      // Checked in turn: an unlock queued behind another finds the work done.
      if (getLiveSession(PROXY_SID)) return c.json(status(auth.email, PROXY_SID));
      const stored = deps.store.load();
      if (!stored) return c.json({ error: 'proton_login_required' }, 409);
      const passphrase = deps.passkeys.unwrap(credentialId, prf);
      if (passphrase === 'unknown') return c.json({ error: 'unknown_passkey' }, 404);
      if (passphrase === 'wrong_secret') {
        logger.warn({ credential }, 'passkey unlock refused');
        return c.json({ error: 'unlock_failed' }, 401);
      }
      // The store has removed the row and logged it.
      if (passphrase === 'unreadable') return c.json({ error: 'passkey_unreadable' }, 409);

      let resumed: ResumeResult;
      try {
        resumed = await deps.protonAuth.resume(stored, passphrase, {
          // At once, before the retry: Proton has already invalidated the old refresh token.
          onRefreshed: (session) => {
            deps.store.save(session);
            logger.info({ email: session.email }, 'proton session refreshed');
          },
        });
      } catch (err) {
        passphrase.fill(0);
        if (err instanceof SessionEndedError) {
          // Proton ended the session. The passkeys still hold the right passphrase.
          deps.store.clear();
          logger.info({ credential }, 'passkey unlock: proton session ended');
          return c.json({ error: 'proton_login_required' }, 409);
        }
        if (isTransientProtonError(err)) {
          logger.warn({ credential, errName: errorName(err) }, 'passkey unlock: proton unavailable');
          return c.json({ error: 'proton_unavailable' }, 503);
        }
        if (err instanceof KeyDecryptError && err.reason === 'user_key') {
          // The password changed since enrolment: every wrap holds the old passphrase.
          const removed = deps.passkeys.removeAll();
          deleteSetting(deps.db, SETTING.keySaltFingerprint);
          logger.info({ credential, removed }, 'passkey unlock: passphrase no longer opens the user key; passkeys removed');
          return c.json({ error: 'passkeys_stale' }, 409);
        }
        captureAuthFailure(err, 'unlock', 'keys');
        logger.error({ credential, errName: errorName(err) }, 'passkey unlock failed');
        return c.json({ error: 'internal' }, 500);
      }
      // From here the MailboxSecret owns the bytes; logout or the next login disposes it.
      await startLiveSession({
        sid: PROXY_SID,
        session: resumed.session,
        mailboxSecret: new MailboxSecret(passphrase),
        decryptedKeys: resumed.decryptedKeys,
        userId: resumed.userId,
        // Recorded at enrolment and unchanged: this passphrase still opened the keys.
        keySaltFingerprint: readSetting(deps.db, SETTING.keySaltFingerprint),
      });
      deps.passkeys.touch(credentialId);
      logger.info({ credential }, 'unlocked with a passkey');
      return c.json(status(auth.email, PROXY_SID));
    });
  });
```

- [ ] **Step 4: Run the whole server suite and the typecheck**

Run: `pnpm --filter @doc-scanner/server test && pnpm --filter @doc-scanner/server run typecheck`

Expected: PASS (62 files, 754 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes-auth.ts server/src/observability/report.ts server/tests/http/routes-unlock.test.ts server/tests/observability/unlock-route.test.ts
git commit -m "feat(server): unlock the Proton keys with a passkey"
```

---

### Task 10: PWA API client and types

**Files:**
- Create: `pwa/tests/api.test.ts`
- Modify: `pwa/src/api.ts`

- [ ] **Step 1: Write the failing tests**

Create `pwa/tests/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(body: unknown, status = 200) {
  // A fresh Response per call: a body can only be read once. A 204 has none.
  const fetch = vi.fn().mockImplementation(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const call = (fetch: ReturnType<typeof stubFetch>) => {
  const [url, init] = fetch.mock.calls[0]!;
  return { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
};

describe('api passkeys and unlock', () => {
  it('reads the status with the Proton state', async () => {
    const status = { email: 'user@example.test', proton: 'locked', passkeys: 1, unlockAvailable: true };
    stubFetch(status);
    await expect(api.status()).resolves.toEqual(status);
  });

  it('begins and adds a passkey', async () => {
    let fetch = stubFetch({ salt: 's', userHandle: 'h', excludeCredentials: [] });
    await api.passkeys.begin();
    expect(call(fetch)).toEqual({ url: '/api/passkeys/begin', method: 'POST', body: undefined });
    fetch = stubFetch({ credentialId: 'id', label: 'Phone', createdAt: 't', lastUsedAt: null }, 201);
    await api.passkeys.add({ credentialId: 'id', salt: 's', prf: 'p', label: 'Phone' });
    expect(call(fetch)).toEqual({ url: '/api/passkeys', method: 'POST', body: { credentialId: 'id', salt: 's', prf: 'p', label: 'Phone' } });
  });

  it('lists passkeys and removes one by its escaped id', async () => {
    let fetch = stubFetch({ passkeys: [], notice: null });
    await expect(api.passkeys.list()).resolves.toEqual({ passkeys: [], notice: null });
    expect(call(fetch)).toMatchObject({ url: '/api/passkeys', method: 'GET' });
    fetch = stubFetch(null, 204);
    await api.passkeys.remove('a-b_c');
    expect(call(fetch)).toMatchObject({ url: '/api/passkeys/a-b_c', method: 'DELETE' });
  });

  it('begins an unlock, then sends the PRF output', async () => {
    let fetch = stubFetch({ credentials: [{ credentialId: 'id', salt: 's' }] });
    await expect(api.unlock.begin()).resolves.toEqual({ credentials: [{ credentialId: 'id', salt: 's' }] });
    expect(call(fetch)).toMatchObject({ url: '/api/auth/unlock/begin', method: 'POST' });
    fetch = stubFetch({ email: 'user@example.test', proton: 'live', passkeys: 1, unlockAvailable: true });
    await api.unlock({ credentialId: 'id', prf: 'p' });
    expect(call(fetch)).toEqual({ url: '/api/auth/unlock', method: 'POST', body: { credentialId: 'id', prf: 'p' } });
  });

  it('surfaces an unlock error code', async () => {
    stubFetch({ error: 'unlock_failed' }, 401);
    await expect(api.unlock({ credentialId: 'id', prf: 'p' })).rejects.toMatchObject({ status: 401, code: 'unlock_failed' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/api.test.ts`

Expected: FAIL, 4 tests: `Cannot read properties of undefined (reading 'begin')` / `(reading 'list')` and `api.unlock is not a function`.

- [ ] **Step 3: Implement**

In `pwa/src/api.ts`, replace `StatusResponse` with the new types:

Replace

```ts
export interface StatusResponse { email: string }
```

with

```ts
/** `live`: Proton keys in memory. `locked`: tokens stored, keys not (a restart). `none`: nothing stored. */
export type ProtonState = 'live' | 'locked' | 'none';

export interface StatusResponse {
  email: string;
  proton: ProtonState;
  /** How many passkeys can unlock. */
  passkeys: number;
  /** Header mode: passkey unlock exists. False in cookie mode, which hides every passkey control. */
  unlockAvailable: boolean;
}

export interface PasskeyEntry { credentialId: string; label: string; createdAt: string; lastUsedAt: string | null }
/** `notice`: a login removed the passkeys because the Proton password changed (said once). */
export interface PasskeyList { passkeys: PasskeyEntry[]; notice: 'password_changed' | null }
/** All base64url. */
export interface PasskeyBegin { salt: string; userHandle: string; excludeCredentials: string[] }
export interface PasskeyAddRequest { credentialId: string; salt: string; prf: string; label: string }
export interface UnlockCredential { credentialId: string; salt: string }
export interface UnlockRequest { credentialId: string; prf: string }
```

and the `api` object. `api.unlock` is both the call and the holder of `begin`, as the spec names them:

Replace

```ts
export const api = {
  login: (body: LoginRequest) => request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  status: () => request<StatusResponse>('/api/auth/status'),
};
```

with

```ts
/** `api.unlock(body)` sends the PRF output; `api.unlock.begin()` fetches the salts first. */
const unlock = Object.assign(
  (body: UnlockRequest) => request<StatusResponse>('/api/auth/unlock', { method: 'POST', body: JSON.stringify(body) }),
  { begin: () => request<{ credentials: UnlockCredential[] }>('/api/auth/unlock/begin', { method: 'POST' }) },
);

export const api = {
  login: (body: LoginRequest) => request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  status: () => request<StatusResponse>('/api/auth/status'),
  passkeys: {
    begin: () => request<PasskeyBegin>('/api/passkeys/begin', { method: 'POST' }),
    add: (body: PasskeyAddRequest) => request<PasskeyEntry>('/api/passkeys', { method: 'POST', body: JSON.stringify(body) }),
    list: () => request<PasskeyList>('/api/passkeys'),
    remove: (credentialId: string) =>
      request<Record<string, never>>(`/api/passkeys/${encodeURIComponent(credentialId)}`, { method: 'DELETE' }),
  },
  unlock,
};
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd pwa && pnpm exec vitest run tests/api.test.ts && cd .. && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (5 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/api.ts pwa/tests/api.test.ts
git commit -m "feat(pwa): passkey and unlock API client"
```

---

### Task 11: `pwa/src/auth/passkeys.ts`: the WebAuthn PRF helper

**Files:**
- Create: `pwa/src/auth/passkeys.ts`, `pwa/tests/auth/fake-webauthn.ts`, `pwa/tests/auth/passkeys.test.ts`

- [ ] **Step 1: Write the test fakes**

`lib.dom` in TypeScript 7.0.2 already types the PRF extension (`AuthenticationExtensionsPRFInputs`, `evalByCredential`, `getClientExtensionResults().prf.results.first`) and `PublicKeyCredential.signalUnknownCredential`, so no extra typings are needed. happy-dom has a `navigator.credentials` getter that does nothing; the fake shadows it with an own property. Create `pwa/tests/auth/fake-webauthn.ts`:

```ts
import { vi } from 'vitest';

/** A credential as navigator.credentials returns it: only what passkeys.ts reads. `prf: null` gives no PRF result. */
export function fakeCredential(id: string, prf: Uint8Array | null): PublicKeyCredential {
  const results: AuthenticationExtensionsClientOutputs = prf ? { prf: { results: { first: new Uint8Array(prf) } } } : { prf: {} };
  return { id, type: 'public-key', getClientExtensionResults: () => results } as unknown as PublicKeyCredential;
}

export interface FakeCredentials {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

/** Puts fakes on navigator.credentials. Undo with removeCredentials(). */
export function installCredentials(): FakeCredentials {
  const fake: FakeCredentials = { create: vi.fn(), get: vi.fn() };
  Object.defineProperty(navigator, 'credentials', { value: fake, configurable: true });
  return fake;
}

export function removeCredentials(): void {
  Reflect.deleteProperty(navigator, 'credentials');
}

/** WebAuthn fails with DOMExceptions named for the cause. */
export const domError = (name: string) => new DOMException(`${name} from the authenticator`, name);
```

- [ ] **Step 2: Write the failing tests**

Create `pwa/tests/auth/passkeys.test.ts`. Credential ids are real base64url (made with `toBase64url`), because the helper decodes them:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrolPasskey, forgetCredential, fromBase64url, toBase64url, unlockWithPasskey } from '../../src/auth/passkeys.js';
import { domError, fakeCredential, installCredentials, removeCredentials } from './fake-webauthn.js';

afterEach(() => {
  removeCredentials();
  vi.unstubAllGlobals();
});

const ID = toBase64url(new Uint8Array(16).fill(1));
const ID_2 = toBase64url(new Uint8Array(16).fill(2));
const OLD = toBase64url(new Uint8Array(16).fill(5));
const PRF = new Uint8Array(32).fill(7);
const SALT = toBase64url(new Uint8Array(32).fill(3));
const SALT_2 = toBase64url(new Uint8Array(32).fill(4));
const BEGIN = { salt: SALT, userHandle: toBase64url(new Uint8Array(16).fill(9)), excludeCredentials: [OLD] };

const bytes = (b: BufferSource) => Array.from(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

describe('base64url', () => {
  it('round-trips bytes with no padding, + or /', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const text = toBase64url(all);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(fromBase64url(text))).toEqual(Array.from(all));
    expect(toBase64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('enrolPasskey', () => {
  it('creates a discoverable, user-verified passkey and reads its PRF output for the salt', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'ok', credentialId: ID, prf: toBase64url(PRF) });
    const options = c.create.mock.calls[0]![0].publicKey;
    expect(options.rp).toEqual({ name: 'Doc Scanner' });
    expect(options.user.name).toBe('user@example.test');
    expect(options.user.displayName).toBe('user@example.test');
    expect(bytes(options.user.id)).toEqual(Array.from(new Uint8Array(16).fill(9)));
    expect(options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
    expect(bytes(options.extensions.prf.eval.first)).toEqual(Array.from(new Uint8Array(32).fill(3)));
    expect(options.excludeCredentials.map((d: PublicKeyCredentialDescriptor) => toBase64url(d.id))).toEqual([OLD]);
    expect(c.get).not.toHaveBeenCalled();
  });

  it('asks again with an assertion when creation gave no PRF result', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'ok', credentialId: ID, prf: toBase64url(PRF) });
    const options = c.get.mock.calls[0]![0].publicKey;
    expect(options.allowCredentials.map((d: PublicKeyCredentialDescriptor) => toBase64url(d.id))).toEqual([ID]);
    expect(options.userVerification).toBe('required');
    expect(bytes(options.extensions.prf.eval.first)).toEqual(Array.from(new Uint8Array(32).fill(3)));
  });

  it('offers Finish setup when the follow-up prompt is refused without a tap, and finishes on it', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockRejectedValueOnce(domError('NotAllowedError')).mockResolvedValueOnce(fakeCredential(ID, PRF));
    const first = await enrolPasskey(BEGIN, 'user@example.test');
    expect(first).toMatchObject({ kind: 'finish_setup', credentialId: ID });
    if (first.kind !== 'finish_setup') throw new Error('expected finish_setup');
    expect(await first.finish()).toEqual({ kind: 'ok', credentialId: ID, prf: toBase64url(PRF) });
  });

  it('says a passkey with no PRF support cannot unlock', async () => {
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockResolvedValue(fakeCredential(ID, null));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'prf_unsupported', credentialId: ID });
  });

  it('maps a cancelled prompt, an already-added passkey, and passes other failures on', async () => {
    const c = installCredentials();
    c.create.mockRejectedValueOnce(domError('NotAllowedError'));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'cancelled' });
    c.create.mockRejectedValueOnce(domError('InvalidStateError'));
    expect(await enrolPasskey(BEGIN, 'user@example.test')).toEqual({ kind: 'already_added' });
    c.create.mockRejectedValueOnce(domError('SecurityError'));
    await expect(enrolPasskey(BEGIN, 'user@example.test')).rejects.toMatchObject({ name: 'SecurityError' });
  });
});

describe('unlockWithPasskey', () => {
  it('asks once, with a salt for each passkey keyed by its id, and returns the one used', async () => {
    const c = installCredentials();
    c.get.mockResolvedValue(fakeCredential(ID_2, PRF));
    const result = await unlockWithPasskey([
      { credentialId: ID, salt: SALT },
      { credentialId: ID_2, salt: SALT_2 },
    ]);
    expect(result).toEqual({ kind: 'ok', credentialId: ID_2, prf: toBase64url(PRF) });
    const options = c.get.mock.calls[0]![0].publicKey;
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials.map((d: PublicKeyCredentialDescriptor) => toBase64url(d.id))).toEqual([ID, ID_2]);
    expect(Object.keys(options.extensions.prf.evalByCredential)).toEqual([ID, ID_2]);
    expect(bytes(options.extensions.prf.evalByCredential[ID_2].first)).toEqual(Array.from(new Uint8Array(32).fill(4)));
  });

  it('maps a cancelled prompt, and a credential with no PRF result', async () => {
    const c = installCredentials();
    c.get.mockRejectedValueOnce(domError('NotAllowedError'));
    expect(await unlockWithPasskey([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'cancelled' });
    c.get.mockResolvedValueOnce(fakeCredential(ID, null));
    expect(await unlockWithPasskey([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'no_prf' });
  });
});

describe('forgetCredential', () => {
  it('signals an unknown credential where the browser can', async () => {
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await forgetCredential(ID)).toBe(true);
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('says so where it cannot', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(await forgetCredential(ID)).toBe(false);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential: vi.fn().mockRejectedValue(new Error('no')) });
    expect(await forgetCredential(ID)).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/auth/passkeys.test.ts`

Expected: FAIL: `Failed to resolve import "../../src/auth/passkeys.js"`.

- [ ] **Step 4: Implement**

Create `pwa/src/auth/passkeys.ts`. WebAuthn requires a `challenge`; with no signature checked anywhere, a random one is enough:

```ts
import type { PasskeyBegin, UnlockCredential } from '../api.js';

/**
 * The browser side of passkey unlock (passkey-unlock spec §3). Everything
 * WebAuthn lives here; components never touch navigator.credentials. All
 * values that cross to the server are base64url. Nothing is verified here or
 * on the server: the PRF output is the secret, and the server's GCM tag is
 * the check (spec, Decisions).
 */

export type EnrolResult =
  | { kind: 'ok'; credentialId: string; prf: string }
  | { kind: 'cancelled' }
  /** The authenticator already holds one of the excluded passkeys. */
  | { kind: 'already_added' }
  /** Created, but it gives no PRF output, so it can't unlock. */
  | { kind: 'prf_unsupported'; credentialId: string }
  /** Safari refused the follow-up prompt without a new tap: run `finish` from a button. */
  | { kind: 'finish_setup'; credentialId: string; finish: () => Promise<EnrolResult> };

export type UnlockResult = { kind: 'ok'; credentialId: string; prf: string } | { kind: 'cancelled' } | { kind: 'no_prf' };

const RP_NAME = 'Doc Scanner';
// ES256 and RS256: what platform authenticators and password managers offer.
const ALGORITHMS: PublicKeyCredentialParameters[] = [
  { type: 'public-key', alg: -7 },
  { type: 'public-key', alg: -257 },
];

export function toBase64url(data: BufferSource): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Required by WebAuthn; unused here, since no signature is checked. */
const challenge = () => crypto.getRandomValues(new Uint8Array(32));

const descriptor = (credentialId: string): PublicKeyCredentialDescriptor => ({ type: 'public-key', id: fromBase64url(credentialId) });

function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string' ? e.name : undefined;
}

function asPublicKey(c: Credential | null): PublicKeyCredential | null {
  return c !== null && c.type === 'public-key' && 'getClientExtensionResults' in c ? (c as PublicKeyCredential) : null;
}

function prfOf(c: PublicKeyCredential): string | null {
  const first = c.getClientExtensionResults().prf?.results?.first;
  return first ? toBase64url(first) : null;
}

/**
 * Creates a discoverable, user-verified passkey and reads its PRF output for
 * the server's salt. An authenticator that gives no PRF result at creation is
 * asked again with an assertion (spec §2, Enrolment).
 */
export async function enrolPasskey(begin: PasskeyBegin, email: string): Promise<EnrolResult> {
  const salt = fromBase64url(begin.salt);
  let created: PublicKeyCredential | null;
  try {
    created = asPublicKey(
      await navigator.credentials.create({
        publicKey: {
          rp: { name: RP_NAME },
          user: { id: fromBase64url(begin.userHandle), name: email, displayName: email },
          challenge: challenge(),
          pubKeyCredParams: ALGORITHMS,
          excludeCredentials: begin.excludeCredentials.map(descriptor),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: { eval: { first: salt } } },
        },
      }),
    );
  } catch (e) {
    if (errorName(e) === 'NotAllowedError') return { kind: 'cancelled' };
    if (errorName(e) === 'InvalidStateError') return { kind: 'already_added' };
    throw e;
  }
  if (!created) return { kind: 'cancelled' };
  const prf = prfOf(created);
  if (prf) return { kind: 'ok', credentialId: created.id, prf };
  return readPrf(created.id, salt);
}

/** The follow-up assertion at enrolment, for a PRF result creation didn't give. */
async function readPrf(credentialId: string, salt: Uint8Array<ArrayBuffer>): Promise<EnrolResult> {
  let got: PublicKeyCredential | null;
  try {
    got = asPublicKey(
      await navigator.credentials.get({
        publicKey: {
          challenge: challenge(),
          allowCredentials: [descriptor(credentialId)],
          userVerification: 'required',
          extensions: { prf: { eval: { first: salt } } },
        },
      }),
    );
  } catch (e) {
    // Safari may refuse a second prompt without a fresh tap; a tap on Finish setup asks again.
    if (errorName(e) === 'NotAllowedError') return { kind: 'finish_setup', credentialId, finish: () => readPrf(credentialId, salt) };
    throw e;
  }
  const prf = got ? prfOf(got) : null;
  return prf ? { kind: 'ok', credentialId, prf } : { kind: 'prf_unsupported', credentialId };
}

/** One prompt for any enrolled passkey; each gets its own salt, keyed by its id (spec §2, Unlock). */
export async function unlockWithPasskey(credentials: UnlockCredential[]): Promise<UnlockResult> {
  const evalByCredential: Record<string, AuthenticationExtensionsPRFValues> = {};
  for (const c of credentials) evalByCredential[c.credentialId] = { first: fromBase64url(c.salt) };
  let got: PublicKeyCredential | null;
  try {
    got = asPublicKey(
      await navigator.credentials.get({
        publicKey: {
          challenge: challenge(),
          allowCredentials: credentials.map((c) => descriptor(c.credentialId)),
          userVerification: 'required',
          extensions: { prf: { evalByCredential } },
        },
      }),
    );
  } catch (e) {
    if (errorName(e) === 'NotAllowedError') return { kind: 'cancelled' };
    throw e;
  }
  if (!got) return { kind: 'cancelled' };
  const prf = prfOf(got);
  return prf ? { kind: 'ok', credentialId: got.id, prf } : { kind: 'no_prf' };
}

/**
 * Asks the password manager to hide a passkey the server never stored. True
 * when the browser took the signal; otherwise the user is told it can be
 * deleted there.
 */
export async function forgetCredential(credentialId: string): Promise<boolean> {
  const pkc = (globalThis as unknown as { PublicKeyCredential?: { signalUnknownCredential?: (o: UnknownCredentialOptions) => Promise<void> } })
    .PublicKeyCredential;
  if (typeof pkc?.signalUnknownCredential !== 'function') return false;
  try {
    await pkc.signalUnknownCredential({ rpId: location.hostname, credentialId });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd pwa && pnpm exec vitest run tests/auth/passkeys.test.ts && cd .. && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (10 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add pwa/src/auth/passkeys.ts pwa/tests/auth/fake-webauthn.ts pwa/tests/auth/passkeys.test.ts
git commit -m "feat(pwa): WebAuthn PRF helper for passkeys"
```

---

### Task 12: `pwa/src/auth/flows.ts`: unlock and enrolment flows

**Files:**
- Create: `pwa/src/auth/flows.ts`, `pwa/tests/auth/flows.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `pwa/tests/auth/flows.test.ts`. It runs the real `api` and `passkeys.ts` against a stubbed `fetch` and the fake credentials. A passkey that was created but will never be stored (no PRF, refused by the server, or abandoned at Finish setup) is signalled as unknown, so the password manager can hide it; one whose add got no answer is kept, since the server may have stored it:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrol, unlock } from '../../src/auth/flows.js';
import { toBase64url } from '../../src/auth/passkeys.js';
import { domError, fakeCredential, installCredentials, removeCredentials } from './fake-webauthn.js';

afterEach(() => {
  removeCredentials();
  vi.unstubAllGlobals();
});

const ID = toBase64url(new Uint8Array(16).fill(1));
const PRF = new Uint8Array(32).fill(7);
const SALT = toBase64url(new Uint8Array(32).fill(3));
const BEGIN = { salt: SALT, userHandle: toBase64url(new Uint8Array(16).fill(9)), excludeCredentials: [] };
const STATUS = { email: 'user@example.test', proton: 'live', passkeys: 1, unlockAvailable: true };
const ENTRY = { credentialId: ID, label: 'Phone', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null };

/** A fresh Response per call (a body reads once), routed by method and path. */
function server(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? 'GET'} ${String(input)}`];
    return handler ? handler() : new Response('{"error":"not_found"}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const bodyOf = (fetch: ReturnType<typeof server>, path: string) =>
  JSON.parse(String(fetch.mock.calls.find(([url]) => url === path)![1]!.body));

describe('unlock', () => {
  it('fetches the salts, asks for the passkey, and sends its PRF output', async () => {
    const fetch = server({
      'POST /api/auth/unlock/begin': json({ credentials: [{ credentialId: ID, salt: SALT }] }),
      'POST /api/auth/unlock': json(STATUS),
    });
    installCredentials().get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await unlock()).toEqual({ kind: 'unlocked', status: STATUS });
    expect(bodyOf(fetch, '/api/auth/unlock')).toEqual({ credentialId: ID, prf: toBase64url(PRF) });
  });

  it('uses salts fetched before the tap', async () => {
    const fetch = server({ 'POST /api/auth/unlock': json(STATUS) });
    installCredentials().get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toMatchObject({ kind: 'unlocked' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/unlock']);
  });

  it('sends nothing when the prompt is cancelled', async () => {
    const fetch = server({});
    installCredentials().get.mockRejectedValue(domError('NotAllowedError'));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes the server's refusal on as its code", async () => {
    server({ 'POST /api/auth/unlock': json({ error: 'passkeys_stale' }, 409) });
    installCredentials().get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'failed', code: 'passkeys_stale' });
  });

  it('fails as unlock_failed when the passkey gives no PRF output', async () => {
    server({});
    installCredentials().get.mockResolvedValue(fakeCredential(ID, null));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'failed', code: 'unlock_failed' });
  });
});

describe('enrol', () => {
  it('begins, creates the passkey, and stores it with its label', async () => {
    const fetch = server({ 'POST /api/passkeys/begin': json(BEGIN), 'POST /api/passkeys': json(ENTRY, 201) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrol('Phone', 'user@example.test')).toEqual({ kind: 'added', passkey: ENTRY });
    expect(bodyOf(fetch, '/api/passkeys')).toEqual({ credentialId: ID, salt: SALT, prf: toBase64url(PRF), label: 'Phone' });
  });

  it('uses a begin fetched before the tap', async () => {
    const fetch = server({ 'POST /api/passkeys': json(ENTRY, 201) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toMatchObject({ kind: 'added' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/passkeys']);
  });

  it('stores nothing for a passkey without PRF, and asks the password manager to hide it', async () => {
    const fetch = server({});
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockResolvedValue(fakeCredential(ID, null));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'prf_unsupported', forgotten: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('says setup expired when the server lost the salt', async () => {
    server({ 'POST /api/passkeys': json({ error: 'invalid_enrolment' }, 400) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'expired', forgotten: false });
  });

  it('finishes setup from a later tap', async () => {
    server({ 'POST /api/passkeys': json(ENTRY, 201) });
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockRejectedValueOnce(domError('NotAllowedError')).mockResolvedValueOnce(fakeCredential(ID, PRF));
    const first = await enrol('Phone', 'user@example.test', BEGIN);
    if (first.kind !== 'finish_setup') throw new Error(`expected finish_setup, got ${first.kind}`);
    expect(await first.finish()).toEqual({ kind: 'added', passkey: ENTRY });
  });

  it('asks the password manager to hide a passkey abandoned at Finish setup', async () => {
    server({});
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockRejectedValue(domError('NotAllowedError'));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    const first = await enrol('Phone', 'user@example.test', BEGIN);
    if (first.kind !== 'finish_setup') throw new Error(`expected finish_setup, got ${first.kind}`);
    expect(await first.abandon()).toBe(true);
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('asks the password manager to hide a passkey the server refused', async () => {
    server({ 'POST /api/passkeys': json({ error: 'proton_not_live' }, 409) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'failed', code: 'proton_not_live', forgotten: true });
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('keeps a passkey whose add never got an answer: the server may have stored it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'failed', code: 'error' });
    expect(signalUnknownCredential).not.toHaveBeenCalled();
  });

  it('maps a cancelled prompt and an already-added passkey, and fails on a server error', async () => {
    server({ 'POST /api/passkeys/begin': json({ error: 'proton_not_live' }, 409) });
    const c = installCredentials();
    c.create.mockRejectedValueOnce(domError('NotAllowedError'));
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'cancelled' });
    c.create.mockRejectedValueOnce(domError('InvalidStateError'));
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'already_added' });
    expect(await enrol('Phone', 'user@example.test')).toEqual({ kind: 'failed', code: 'proton_not_live' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/auth/flows.test.ts`

Expected: FAIL: `Failed to resolve import "../../src/auth/flows.js"`.

- [ ] **Step 3: Implement**

Create `pwa/src/auth/flows.ts`. The two clients are what the banner and Settings take as props, so their tests can inject fakes:

```ts
import { api, ApiError, type PasskeyBegin, type PasskeyEntry, type PasskeyList, type StatusResponse, type UnlockCredential } from '../api.js';
import { enrolPasskey, forgetCredential, unlockWithPasskey, type EnrolResult } from './passkeys.js';

/**
 * Unlock and enrolment as the screens use them: the WebAuthn prompt
 * (passkeys.ts) joined to the server calls, with every outcome typed.
 *
 * Both take what they need from the server up front when they can (the
 * `prepared` and `begin` arguments). WebKit may require the passkey prompt to
 * start straight from the tap, so the screens fetch first, before the tap.
 */

export type UnlockOutcome =
  | { kind: 'unlocked'; status: StatusResponse }
  | { kind: 'cancelled' }
  /** `code`: the server's error, `request_failed` for an answer without one, `error` for anything else. */
  | { kind: 'failed'; code: string };

export type EnrolOutcome =
  | { kind: 'added'; passkey: PasskeyEntry }
  | { kind: 'cancelled' }
  | { kind: 'already_added' }
  /** `forgotten`: the password manager was asked to hide the passkey that can't unlock. */
  | { kind: 'prf_unsupported'; forgotten: boolean }
  /** The server lost the salt (5 minutes, or a restart); the passkey exists but was never stored. */
  | { kind: 'expired'; forgotten: boolean }
  /** `abandon`: the user walked away, so ask the password manager to hide the half-made passkey. */
  | { kind: 'finish_setup'; finish: () => Promise<EnrolOutcome>; abandon: () => Promise<boolean> }
  /** `forgotten`: set when the server refused a created passkey, as for `prf_unsupported`. */
  | { kind: 'failed'; code: string; forgotten?: boolean };

const codeOf = (e: unknown): string => (e instanceof ApiError ? (e.code ?? 'request_failed') : 'error');
const failed = (e: unknown): EnrolOutcome => ({ kind: 'failed', code: codeOf(e) });

/** One tap: the passkey prompt, then the server unwraps and resumes Proton (spec §2, Unlock). */
export async function unlock(prepared: UnlockCredential[] | null = null): Promise<UnlockOutcome> {
  try {
    const credentials = prepared ?? (await api.unlock.begin()).credentials;
    const result = await unlockWithPasskey(credentials);
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'no_prf') return { kind: 'failed', code: 'unlock_failed' };
    return { kind: 'unlocked', status: await api.unlock({ credentialId: result.credentialId, prf: result.prf }) };
  } catch (e) {
    return { kind: 'failed', code: codeOf(e) };
  }
}

/** Spec §2, Enrolment: begin (unless given), the passkey prompt, then the server wraps the passphrase. */
export async function enrol(label: string, email: string, begin?: PasskeyBegin): Promise<EnrolOutcome> {
  try {
    const started = begin ?? (await api.passkeys.begin());
    return await settle(await enrolPasskey(started, email), started.salt, label);
  } catch (e) {
    return failed(e);
  }
}

async function settle(result: EnrolResult, salt: string, label: string): Promise<EnrolOutcome> {
  switch (result.kind) {
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'already_added':
      return { kind: 'already_added' };
    case 'prf_unsupported':
      // Created, but it can't unlock: nothing goes to the server.
      return { kind: 'prf_unsupported', forgotten: await forgetCredential(result.credentialId) };
    case 'finish_setup': {
      const { finish, credentialId } = result;
      return {
        kind: 'finish_setup',
        finish: async () => {
          try {
            return await settle(await finish(), salt, label);
          } catch (e) {
            return failed(e);
          }
        },
        abandon: () => forgetCredential(credentialId),
      };
    }
    case 'ok':
      try {
        return { kind: 'added', passkey: await api.passkeys.add({ credentialId: result.credentialId, salt, prf: result.prf, label }) };
      } catch (e) {
        // A request that got no answer may have been stored: keep that passkey.
        if (!(e instanceof ApiError)) throw e;
        // The server refused it, so it will never unlock: ask the password manager to hide it.
        const forgotten = await forgetCredential(result.credentialId);
        if (e.code === 'invalid_enrolment') return { kind: 'expired', forgotten };
        return { kind: 'failed', code: codeOf(e), forgotten };
      }
  }
}

/** What the unlock banner calls; injectable for tests. */
export interface UnlockClient {
  /** Fetched before the tap: the salts for the prompt. */
  prepare: () => Promise<UnlockCredential[]>;
  unlock: (prepared: UnlockCredential[] | null) => Promise<UnlockOutcome>;
}

export const unlockClient: UnlockClient = {
  prepare: async () => (await api.unlock.begin()).credentials,
  unlock,
};

/** What Settings → Passkeys calls; injectable for tests. */
export interface PasskeysClient {
  list: () => Promise<PasskeyList>;
  remove: (credentialId: string) => Promise<unknown>;
  /** Fetched when Add passkey is tapped, before the prompt's own tap. */
  begin: () => Promise<PasskeyBegin>;
  enrol: (label: string, email: string, begin?: PasskeyBegin) => Promise<EnrolOutcome>;
}

export const passkeysClient: PasskeysClient = {
  list: () => api.passkeys.list(),
  remove: (credentialId) => api.passkeys.remove(credentialId),
  begin: () => api.passkeys.begin(),
  enrol,
};
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd pwa && pnpm exec vitest run tests/auth && cd .. && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (24 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/auth/flows.ts pwa/tests/auth/flows.test.ts
git commit -m "feat(pwa): unlock and enrolment flows"
```

---

### Task 13: The locked banner

**Files:**
- Create: `pwa/src/ui/inbox/LockedBanner.tsx`, `pwa/tests/ui/LockedBanner.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `pwa/tests/ui/LockedBanner.test.tsx`. After any failed unlock the banner drops the salts it fetched and fetches them again, so the next tap uses fresh ones; after a refusal that changed the server's state (`proton_login_required`, `passkeys_stale`, `passkey_unreadable`) it calls `onStatusChanged`, so the app reads its status again:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { LockedBanner } from '../../src/ui/inbox/LockedBanner.js';
import type { UnlockClient, UnlockOutcome } from '../../src/auth/flows.js';
import type { StatusResponse } from '../../src/api.js';

const LIVE: StatusResponse = { email: 'user@example.test', proton: 'live', passkeys: 1, unlockAvailable: true };
const CREDENTIALS = [{ credentialId: 'AQEBAQEBAQEBAQEBAQEBAQ', salt: 'AwMD' }];
const RETRY = 'Couldn’t unlock. Try again.';

function setup(outcome: UnlockOutcome, passkeys = 1) {
  const client: UnlockClient = {
    prepare: vi.fn().mockResolvedValue(CREDENTIALS),
    unlock: vi.fn().mockResolvedValue(outcome),
  };
  const onUnlocked = vi.fn();
  const onSignIn = vi.fn();
  const onStatusChanged = vi.fn();
  render(<LockedBanner passkeys={passkeys} onUnlocked={onUnlocked} onSignIn={onSignIn} onStatusChanged={onStatusChanged} client={client} />);
  return { client, onUnlocked, onSignIn, onStatusChanged };
}

/** Lets the salts fetched on mount arrive. */
async function prepared(client: UnlockClient) {
  await act(async () => {
    await vi.mocked(client.prepare).mock.results[0]!.value;
  });
}

describe('LockedBanner', () => {
  it('waits for a tap, then unlocks with the salts fetched before it', async () => {
    const { client, onUnlocked } = setup({ kind: 'unlocked', status: LIVE });
    expect(screen.getByText(/filing is paused until you unlock/i)).toBeInTheDocument();
    await prepared(client);
    expect(client.unlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(LIVE));
    expect(client.unlock).toHaveBeenCalledWith(CREDENTIALS);
  });

  it('fetches the salts again after a failed unlock, so the next tap uses fresh ones', async () => {
    const fresh = [{ credentialId: 'AgICAgICAgICAgICAgICAg', salt: 'BAQE' }];
    const { client, onUnlocked } = setup({ kind: 'failed', code: 'unlock_failed' });
    await prepared(client);
    vi.mocked(client.prepare).mockResolvedValue(fresh);
    vi.mocked(client.unlock).mockResolvedValueOnce({ kind: 'failed', code: 'unlock_failed' }).mockResolvedValueOnce({ kind: 'unlocked', status: LIVE });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText(RETRY)).toBeInTheDocument();
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.mocked(client.prepare).mock.results[1]!.value;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(LIVE));
    expect(client.unlock).toHaveBeenLastCalledWith(fresh);
  });

  it('offers only a Proton sign-in with no passkeys', () => {
    const { client, onSignIn } = setup({ kind: 'cancelled' }, 0);
    expect(screen.getByText('Filing is paused. Sign in to Proton to resume.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Proton' }));
    expect(onSignIn).toHaveBeenCalled();
    expect(client.prepare).not.toHaveBeenCalled();
  });

  for (const [label, outcome] of [
    ['a cancelled prompt', { kind: 'cancelled' }],
    ['a wrong secret', { kind: 'failed', code: 'unlock_failed' }],
    ['a network failure', { kind: 'failed', code: 'error' }],
  ] as const) {
    it(`asks to try again after ${label}, keeping the button`, async () => {
      const { onStatusChanged } = setup(outcome);
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      expect(await screen.findByText(RETRY)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
      expect(onStatusChanged).not.toHaveBeenCalled();
    });
  }

  it('says Proton is unreachable, keeping the button', async () => {
    setup({ kind: 'failed', code: 'proton_unavailable' });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Proton isn’t reachable right now. Try again in a moment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  for (const [code, text] of [
    ['proton_login_required', 'Filing is paused. Sign in to Proton to resume.'],
    ['passkeys_stale', 'Your Proton password changed. Sign in again, then add your passkey again in Settings.'],
    ['passkey_unreadable', 'That passkey can no longer unlock. Sign in to Proton, then remove it and add it again in Settings.'],
  ] as const) {
    it(`sends the user to sign in after ${code}, and tells the app its status changed`, async () => {
      const { onSignIn, onStatusChanged } = setup({ kind: 'failed', code });
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(onStatusChanged).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Proton' }));
      expect(onSignIn).toHaveBeenCalled();
    });
  }

  it('ignores an outcome that arrives after it is gone', async () => {
    let finish!: (o: UnlockOutcome) => void;
    const client: UnlockClient = {
      prepare: vi.fn().mockResolvedValue(CREDENTIALS),
      unlock: vi.fn(() => new Promise<UnlockOutcome>((resolve) => { finish = resolve; })),
    };
    const onUnlocked = vi.fn();
    const { unmount } = render(<LockedBanner passkeys={1} onUnlocked={onUnlocked} onSignIn={vi.fn()} client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    unmount();
    await act(async () => finish({ kind: 'unlocked', status: LIVE }));
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/LockedBanner.test.tsx`

Expected: FAIL: `Failed to resolve import "../../src/ui/inbox/LockedBanner.js"`.

- [ ] **Step 3: Implement**

Create `pwa/src/ui/inbox/LockedBanner.tsx`. The mounted guard is a layout effect (Preact 11 runs `useEffect` cleanups after paint):

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { StatusResponse, UnlockCredential } from '../../api.js';
import { unlockClient, type UnlockClient } from '../../auth/flows.js';

export interface LockedBannerProps {
  /** Passkeys that can unlock; with none, the banner only offers a Proton sign-in. */
  passkeys: number;
  onUnlocked: (status: StatusResponse) => void;
  /** Opens the sign-in-to-Proton screen. */
  onSignIn: () => void;
  /** The server changed the Proton state or the passkeys (a refusal that cleared something). */
  onStatusChanged?: () => void;
  client?: UnlockClient;
}

type Problem = 'retry' | 'unavailable' | 'login_required' | 'stale' | 'unreadable';

function problemOf(code: string): Problem {
  switch (code) {
    case 'proton_login_required':
    case 'no_passkeys':
      return 'login_required';
    case 'passkeys_stale':
      return 'stale';
    case 'passkey_unreadable':
      return 'unreadable';
    case 'proton_unavailable':
      return 'unavailable';
    default:
      return 'retry';
  }
}

/** Refusals after which the server's state differs: the app reads its status again. */
const STATUS_CHANGING = new Set(['proton_login_required', 'passkeys_stale', 'passkey_unreadable']);

const SIGN_IN_TEXT = {
  login_required: 'Filing is paused. Sign in to Proton to resume.',
  stale: 'Your Proton password changed. Sign in again, then add your passkey again in Settings.',
  unreadable: 'That passkey can no longer unlock. Sign in to Proton, then remove it and add it again in Settings.',
} as const;

/**
 * Shown while Proton is locked: tokens stored, keys gone with a restart
 * (passkey-unlock spec §3). Unlock waits for a tap, since iOS needs a user
 * gesture for the passkey prompt; the salts are fetched before it.
 */
export function LockedBanner({ passkeys, onUnlocked, onSignIn, onStatusChanged = () => {}, client = unlockClient }: LockedBannerProps) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const prepared = useRef<UnlockCredential[] | null>(null);
  // Only the latest fetch may fill `prepared`.
  const generation = useRef(0);
  const mounted = useRef(true);
  // A layout effect: Preact 11 runs useEffect cleanups after paint, too late for this guard.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function prefetch() {
    const mine = ++generation.current;
    prepared.current = null;
    client
      .prepare()
      .then((credentials) => {
        if (generation.current === mine) prepared.current = credentials;
      })
      // The tap fetches them itself then.
      .catch(() => {});
  }

  useEffect(() => {
    if (passkeys === 0) return;
    prefetch();
  }, [client, passkeys]);

  async function tap() {
    setBusy(true);
    setProblem(null);
    const outcome = await client.unlock(prepared.current);
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.kind === 'unlocked') {
      onUnlocked(outcome.status);
      return;
    }
    // A passkey may have been removed, or another added elsewhere: the next tap gets fresh salts.
    prefetch();
    setProblem(outcome.kind === 'cancelled' ? 'retry' : problemOf(outcome.code));
    if (outcome.kind === 'failed' && STATUS_CHANGING.has(outcome.code)) onStatusChanged();
  }

  const signInOnly =
    problem === 'login_required' || problem === 'stale' || problem === 'unreadable' ? problem : passkeys === 0 ? 'login_required' : null;
  if (signInOnly) {
    return (
      <div class="warn">
        {SIGN_IN_TEXT[signInOnly]}{' '}
        <button class="btn btn-secondary btn-small" onClick={onSignIn}>
          Sign in to Proton
        </button>
      </div>
    );
  }
  return (
    <div class="warn">
      Filing is paused until you unlock.{' '}
      <button class="btn btn-small" disabled={busy} onClick={() => void tap()}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {problem === 'retry' && <p class="error-text">Couldn’t unlock. Try again.</p>}
      {problem === 'unavailable' && <p class="error-text">Proton isn’t reachable right now. Try again in a moment.</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd pwa && pnpm exec vitest run tests/ui/LockedBanner.test.tsx && cd .. && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (11 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/ui/inbox/LockedBanner.tsx pwa/tests/ui/LockedBanner.test.tsx
git commit -m "feat(pwa): the locked banner"
```

---

### Task 14: The unlock banner and the passkey nudge in the inbox

**Files:**
- Modify: `pwa/src/ui/inbox/InboxScreen.tsx`, `pwa/src/theme/theme.css`
- Test: `pwa/tests/ui/InboxScreen.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `pwa/tests/ui/InboxScreen.test.tsx`, add `beforeEach` to the vitest import:

Replace

```tsx
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
```

with

```tsx
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
```

Replace

```tsx
import { InboxScreen } from '../../src/ui/inbox/InboxScreen.js';
```

with

```tsx
import { InboxScreen, type InboxScreenProps } from '../../src/ui/inbox/InboxScreen.js';
import type { UnlockClient } from '../../src/auth/flows.js';
```

give `setup` a fourth parameter for the new props:

Replace

```tsx
function setup(docs: DocumentView[], over: Partial<DocumentsApi> = {}, send?: Send) {
```

with

```tsx
function setup(docs: DocumentView[], over: Partial<DocumentsApi> = {}, send?: Send, extra: Partial<InboxScreenProps> = {}) {
```

Replace

```tsx
  const { unmount } = render(<InboxScreen sync={sync} documents={api} now={() => NOW} uploads={uploads} scans={scans} {...props} />);
```

with

```tsx
  const { unmount } = render(<InboxScreen sync={sync} documents={api} now={() => NOW} uploads={uploads} scans={scans} {...props} {...extra} />);
```

and append:

```tsx
describe('InboxScreen while Proton is locked', () => {
  const LIVE = { email: 'user@example.test', proton: 'live' as const, passkeys: 1, unlockAvailable: true };
  const unlockClient = (): UnlockClient => ({
    prepare: vi.fn().mockResolvedValue([]),
    unlock: vi.fn().mockResolvedValue({ kind: 'unlocked', status: LIVE }),
  });

  it('shows the unlock banner instead of the sign-in banner', async () => {
    setup([makeDoc({ state: 'awaiting_login' })], {}, undefined, { proton: 'locked', passkeys: 1, unlockClient: unlockClient() });
    expect(screen.getByText(/filing is paused until you unlock/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting to be filed/i)).toBeNull();
    await waitFor(() => expect(screen.getByText('Waiting for sign-in')).toBeInTheDocument());
  });

  it('unlocks from the banner and hands over the new status', async () => {
    const onUnlocked = vi.fn();
    setup([], {}, undefined, { proton: 'locked', passkeys: 1, onUnlocked, unlockClient: unlockClient() });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(LIVE));
  });

  it('tells the app when an unlock refusal changed the server state', async () => {
    const onStatusChanged = vi.fn();
    const client: UnlockClient = {
      prepare: vi.fn().mockResolvedValue([]),
      unlock: vi.fn().mockResolvedValue({ kind: 'failed', code: 'passkeys_stale' }),
    };
    setup([], {}, undefined, { proton: 'locked', passkeys: 1, onStatusChanged, unlockClient: client });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onStatusChanged).toHaveBeenCalled());
  });

  it('opens the Proton sign-in when no passkey can unlock', async () => {
    const onSignInToProton = vi.fn();
    setup([], {}, undefined, { proton: 'locked', passkeys: 0, onSignInToProton });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Proton' }));
    expect(onSignInToProton).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
  });
});

describe('InboxScreen passkey nudge', () => {
  beforeEach(() => localStorage.clear());
  const TEXT = 'Add a passkey so a server restart doesn’t need your Proton password.';

  it('suggests adding a passkey, and goes to add one', async () => {
    const onAddPasskey = vi.fn();
    setup([], {}, undefined, { showPasskeyNudge: true, onAddPasskey });
    expect(screen.getByText(TEXT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    expect(onAddPasskey).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
  });

  it('stays dismissed on this device', async () => {
    const { unmount } = setup([], {}, undefined, { showPasskeyNudge: true });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(TEXT)).toBeNull();
    unmount();
    setup([], {}, undefined, { showPasskeyNudge: true });
    expect(screen.queryByText(TEXT)).toBeNull();
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
  });

  it('is not shown unless asked for', async () => {
    setup([]);
    expect(screen.queryByText(TEXT)).toBeNull();
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/InboxScreen.test.tsx`

Expected: FAIL, 6 tests: no element with the text `/filing is paused until you unlock/i`, no button named "Unlock", "Sign in to Proton" or "Add passkey". (The existing tests still pass; the new props are optional.)

- [ ] **Step 3: Implement**

In `pwa/src/ui/inbox/InboxScreen.tsx`, the imports:

Replace

```tsx
import { ApiError } from '../../api.js';
```

with

```tsx
import { ApiError, type ProtonState, type StatusResponse } from '../../api.js';
import type { UnlockClient } from '../../auth/flows.js';
```

After

```tsx
import { DeviceScanRow, UploadRow } from './UploadRows.js';
```

add

```tsx
import { LockedBanner } from './LockedBanner.js';

/** The passkey nudge, once dismissed, stays dismissed on this device. */
const NUDGE_DISMISSED_KEY = 'docscanner.passkeyNudgeDismissed';

function nudgeDismissed(): boolean {
  try {
    return localStorage.getItem(NUDGE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}
```

the props, all optional so cookie mode and the existing tests keep today's inbox:

Replace

```tsx
  /** Must be stable. Task 6 lists its finished scans; the inbox shares App's open. */
  scans: ScansStore;
}
```

with

```tsx
  /** Must be stable. Task 6 lists its finished scans; the inbox shares App's open. */
  scans: ScansStore;
  /** From GET /api/auth/status. `locked` shows the unlock banner (passkey-unlock spec §3). */
  proton?: ProtonState;
  passkeys?: number;
  onUnlocked?: (status: StatusResponse) => void;
  /** An unlock refusal changed the server's state (spec §3): the app reads its status again. */
  onStatusChanged?: () => void;
  /** Opens the sign-in-to-Proton screen; defaults to onSignInAgain. */
  onSignInToProton?: () => void;
  /** After a Proton login in header mode with no passkey yet. */
  showPasskeyNudge?: boolean;
  /** Defaults to onSettings, where passkeys are added. */
  onAddPasskey?: () => void;
  unlockClient?: UnlockClient;
}
```

Replace

```tsx
  uploads,
  scans,
}: InboxScreenProps) {
```

with

```tsx
  uploads,
  scans,
  proton = 'live',
  passkeys = 0,
  onUnlocked = () => {},
  onStatusChanged = () => {},
  onSignInToProton = onSignInAgain,
  showPasskeyNudge = false,
  onAddPasskey = onSettings,
  unlockClient,
}: InboxScreenProps) {
```

the nudge's state:

After

```tsx
  const [addError, setAddError] = useState<string | null>(null);
```

add

```tsx
  const [nudgeHidden, setNudgeHidden] = useState(nudgeDismissed);
  const dismissNudge = () => {
    try {
      localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
    } catch {
      // Storage refused (private browsing): dismissed until the next visit.
    }
    setNudgeHidden(true);
  };
```

and, in the status region, the locked banner replaces the sign-in banner while it shows; the nudge follows the region:

Replace

```tsx
        {g.awaitingLogin > 0 && (
          <div class="warn">
            {g.awaitingLogin === 1 ? '1 document is' : `${g.awaitingLogin} documents are`} waiting to be filed. Sign in again to
            give the server access to Drive.{' '}
            <button class="btn btn-secondary btn-small" onClick={onSignInAgain}>
              Sign in again
            </button>
          </div>
        )}
      </div>
```

with

```tsx
        {proton === 'locked' ? (
          // Replaces the sign-in banner below: nothing can be filed until the keys are back.
          <LockedBanner
            passkeys={passkeys}
            onUnlocked={onUnlocked}
            onStatusChanged={onStatusChanged}
            onSignIn={onSignInToProton}
            {...(unlockClient ? { client: unlockClient } : {})}
          />
        ) : (
          // Live, yet documents wait: the session's tokens died inside it.
          g.awaitingLogin > 0 && (
            <div class="warn">
              {g.awaitingLogin === 1 ? '1 document is' : `${g.awaitingLogin} documents are`} waiting to be filed. Sign in again to
              give the server access to Drive.{' '}
              <button class="btn btn-secondary btn-small" onClick={onSignInAgain}>
                Sign in again
              </button>
            </div>
          )
        )}
      </div>

      {showPasskeyNudge && !nudgeHidden && (
        <div class="card nudge" role="note">
          <p>Add a passkey so a server restart doesn’t need your Proton password.</p>
          <div class="actions">
            <button class="btn btn-small" onClick={onAddPasskey}>
              Add passkey
            </button>
            <button class="btn btn-secondary btn-small" onClick={dismissNudge}>
              Dismiss
            </button>
          </div>
        </div>
      )}
```

Append to `pwa/src/theme/theme.css`:

```css
.nudge { margin-top: 12px; }
.nudge p { margin: 0 0 8px; }
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd pwa && pnpm exec vitest run tests/ui/InboxScreen.test.tsx && cd .. && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (51 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/ui/inbox/InboxScreen.tsx pwa/src/theme/theme.css pwa/tests/ui/InboxScreen.test.tsx
git commit -m "feat(pwa): unlock banner and passkey nudge in the inbox"
```

---

### Task 15: App routing on the Proton state, the sign-in-to-Proton route, and `signInAgain`

**Files:**
- Modify: `pwa/src/ui/App.tsx`, `pwa/src/ui/LoginScreen.tsx`
- Test: `pwa/tests/ui/App.test.tsx`, `pwa/tests/ui/login.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `pwa/tests/ui/login.test.tsx`:

Before

```tsx
  it('moves focus to the 2FA code field when it appears', async () => {
```

add

```tsx
  it('offers Cancel only over a signed-in app', () => {
    const { unmount } = render(<LoginScreen onLoggedIn={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    unmount();
    const onCancel = vi.fn();
    render(<LoginScreen onLoggedIn={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
```

In `pwa/tests/ui/App.test.tsx`, import the WebAuthn fakes:

After

```tsx
import { FakeXhr } from '../uploads/fake-xhr.js';
```

add

```tsx
import { toBase64url } from '../../src/auth/passkeys.js';
import { fakeCredential, installCredentials, removeCredentials } from '../auth/fake-webauthn.js';
```

and add these tests at the end of the `session flows` describe, which already has `server()`, `json()` and `SETTINGS`. The existing tests keep their `{ email }`-only status: with no `unlockAvailable`, the app behaves as in cookie mode.

Replace

```tsx
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }));
        expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
      });
    }
  });
```

with

```tsx
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }));
        expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
      });
    }

    const status = (proton: 'live' | 'locked' | 'none', passkeys: number) => json({ email: 'user@example.test', proton, passkeys, unlockAvailable: true });
    const inbox = {
      'GET /api/documents': json({ documents: [], cursor: 0 }),
      'GET /api/folders': json({ error: 'folders_not_loaded' }, 503),
      'GET /api/settings': json(SETTINGS),
      'GET /api/passkeys': json({ passkeys: [], notice: null }),
    };
    const calledLogout = (fetch: ReturnType<typeof server>) => fetch.mock.calls.some(([url]) => url === '/api/auth/logout');

    it('shows the login screen when no Proton session is stored', async () => {
      server({ 'GET /api/auth/status': status('none', 0), ...inbox });
      render(<App />);
      expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
    });

    it('opens the inbox while locked and unlocks it with a tap', async () => {
      const id = toBase64url(new Uint8Array(16).fill(1));
      const prf = new Uint8Array(32).fill(7);
      const fetch = server({
        'GET /api/auth/status': status('locked', 1),
        ...inbox,
        'POST /api/auth/unlock/begin': json({ credentials: [{ credentialId: id, salt: toBase64url(new Uint8Array(32).fill(3)) }] }),
        'POST /api/auth/unlock': status('live', 1),
      });
      installCredentials().get.mockResolvedValue(fakeCredential(id, prf));
      try {
        render(<App />);
        expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
        await waitFor(() => expect(screen.queryByText(/filing is paused/i)).toBeNull());
        const sent = fetch.mock.calls.find(([url]) => url === '/api/auth/unlock')!;
        expect(JSON.parse(String(sent[1]!.body))).toEqual({ credentialId: id, prf: toBase64url(prf) });
      } finally {
        removeCredentials();
      }
    });

    it('reads the status again after an unlock refusal that changed it', async () => {
      const id = toBase64url(new Uint8Array(16).fill(1));
      const routes: Record<string, () => Response> = {
        'GET /api/auth/status': status('locked', 1),
        ...inbox,
        'POST /api/auth/unlock/begin': json({ credentials: [{ credentialId: id, salt: toBase64url(new Uint8Array(32).fill(3)) }] }),
        'POST /api/auth/unlock': json({ error: 'passkeys_stale' }, 409),
      };
      const fetch = server(routes);
      installCredentials().get.mockResolvedValue(fakeCredential(id, new Uint8Array(32).fill(7)));
      const statusReads = () => fetch.mock.calls.filter(([url]) => url === '/api/auth/status').length;
      try {
        render(<App />);
        const unlockButton = await screen.findByRole('button', { name: 'Unlock' });
        // The server removed the passkeys while refusing.
        routes['GET /api/auth/status'] = status('locked', 0);
        fireEvent.click(unlockButton);
        expect(
          await screen.findByText('Your Proton password changed. Sign in again, then add your passkey again in Settings.'),
        ).toBeInTheDocument();
        await waitFor(() => expect(statusReads()).toBe(2));
      } finally {
        removeCredentials();
      }
    });

    it('signs in to Proton over the inbox from the locked banner, and Cancel goes back', async () => {
      const fetch = server({ 'GET /api/auth/status': status('locked', 0), ...inbox });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Proton' }));
      expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
      expect(calledLogout(fetch)).toBe(false);
    });

    it('in header mode, "Sign in again" never logs out, and suggests a passkey after the login', async () => {
      localStorage.clear();
      const fetch = server({
        'GET /api/auth/status': status('live', 0),
        ...inbox,
        'GET /api/documents': json({ documents: [makeDoc({ state: 'awaiting_login' })], cursor: 1 }),
        'POST /api/auth/login': json({ ok: true, email: 'user@example.test' }),
      });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }));
      fireEvent.input(await screen.findByLabelText('Email'), { target: { value: 'user@example.test' } });
      fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
      fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
      expect(await screen.findByText('Add a passkey so a server restart doesn’t need your Proton password.')).toBeInTheDocument();
      expect(calledLogout(fetch)).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
      expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/App.test.tsx tests/ui/login.test.tsx`

Expected: FAIL, 6 tests: no Cancel button; with `proton: 'none'` the inbox shows instead of the login screen; no "Unlock" or "Sign in to Proton" button (so the status is never read again after a refusal); and the nudge never appears, because "Sign in again" still logs out.

- [ ] **Step 3: Implement `LoginScreen` Cancel**

Replace

```tsx
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
```

with

```tsx
export interface LoginScreenProps {
  onLoggedIn: (email: string) => void;
  /** Shown over a signed-in app (sign in to Proton): back to the inbox without signing in. */
  onCancel?: () => void;
}

export function LoginScreen({ onLoggedIn, onCancel }: LoginScreenProps) {
```

Replace

```tsx
        <button class="btn btn-block" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
```

with

```tsx
        <button class="btn btn-block" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {onCancel && (
          <button class="btn btn-secondary btn-block" type="button" onClick={onCancel} style={{ marginTop: 8 }}>
            Cancel
          </button>
        )}
      </form>
```

- [ ] **Step 4: Implement the routing in `App`**

In `pwa/src/ui/App.tsx`, the import and the route:

Replace

```tsx
import { api, ApiError } from '../api.js';
```

with

```tsx
import { api, ApiError, type StatusResponse } from '../api.js';
```

Replace

```tsx
type Route =
  | { kind: 'inbox' }
  | { kind: 'settings' }
  | { kind: 'scanner'; resumeScanId?: string };
```

with

```tsx
type Route =
  | { kind: 'inbox' }
  | { kind: 'settings' }
  | { kind: 'scanner'; resumeScanId?: string }
  /** LoginScreen over the signed-in app, with Cancel back to the inbox (passkey-unlock spec §3). */
  | { kind: 'proton-login' };
```

App keeps the whole status instead of the email:

Replace

```tsx
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
```

with

```tsx
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  // A Proton login in this tab: the passkey nudge follows only that.
  const [justSignedIn, setJustSignedIn] = useState(false);
```

Replace

```tsx
    () => new DocumentSync({ list: documentsApi.list, onUnauthorized: () => { setEmail(null); setRoute({ kind: 'inbox' }); } }),
```

with

```tsx
    () => new DocumentSync({ list: documentsApi.list, onUnauthorized: () => { setStatus(null); setRoute({ kind: 'inbox' }); } }),
```

Replace

```tsx
        onUnauthorized: () => {
          setEmail(null);
          setRoute({ kind: 'inbox' });
        },
```

with

```tsx
        onUnauthorized: () => {
          setStatus(null);
          setRoute({ kind: 'inbox' });
        },
```

`email` stays as the effects' dependency, now derived. It is null with `proton: 'none'`, so nothing polls or uploads behind the login screen, as when signed out:

Replace

```tsx
  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
```

with

```tsx
  // Signed in with a Proton session stored or live. With none, the login
  // screen shows and nothing polls or uploads, as when signed out.
  const email = status && status.proton !== 'none' ? status.email : null;

  useEffect(() => {
    api.status().then(setStatus)
```

`refreshStatus`, `loggedIn`, and `signInAgain`'s header-mode branch:

Replace

```tsx
  function signedOut() {
    setEmail(null);
    setRoute({ kind: 'inbox' });
  }

  async function signInAgain() {
```

with

```tsx
  /** Reads the status again: a 401 signs out; any other failure keeps what is shown. */
  async function refreshStatus(): Promise<void> {
    try {
      setStatus(await api.status());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setStatus(null);
      else console.error('could not refresh the sign-in status', (e as Error)?.name);
    }
  }

  function signedOut() {
    setStatus(null);
    setRoute({ kind: 'inbox' });
  }

  function loggedIn(signedInEmail: string) {
    // Live at once; the refresh brings the passkey count and the mode.
    setStatus((s) => ({ email: signedInEmail, proton: 'live', passkeys: s?.passkeys ?? 0, unlockAvailable: s?.unlockAvailable ?? false }));
    setRoute({ kind: 'inbox' });
    setJustSignedIn(true);
    void refreshStatus();
  }

  async function signInAgain() {
    // Header mode: sign in to Proton over the app. A logout would remove the passkeys too.
    if (status?.unlockAvailable) {
      setRoute({ kind: 'proton-login' });
      return;
    }
```

The routes:

Replace

```tsx
  if (!loaded) return <main class="auth-screen">Loading…</main>;
  if (!email) return <LoginScreen onLoggedIn={setEmail} />;
```

with

```tsx
  if (!loaded) return <main class="auth-screen">Loading…</main>;
  if (!status || status.proton === 'none') return <LoginScreen onLoggedIn={loggedIn} />;
  if (route.kind === 'proton-login') return <LoginScreen onLoggedIn={loggedIn} onCancel={() => setRoute({ kind: 'inbox' })} />;
```

Replace

```tsx
        onSettings={() => setRoute({ kind: 'settings' })}
        onSignInAgain={() => void signInAgain()}
      />;
    case 'settings':
      return <SettingsScreen email={email} onBack={() => setRoute({ kind: 'inbox' })} onLoggedOut={signedOut} />;
```

with

```tsx
        onSettings={() => setRoute({ kind: 'settings' })}
        onSignInAgain={() => void signInAgain()}
        proton={status.proton}
        passkeys={status.passkeys}
        onUnlocked={setStatus}
        onStatusChanged={() => void refreshStatus()}
        onSignInToProton={() => setRoute({ kind: 'proton-login' })}
        showPasskeyNudge={justSignedIn && status.unlockAvailable && status.passkeys === 0}
        onAddPasskey={() => setRoute({ kind: 'settings' })}
      />;
    case 'settings':
      return <SettingsScreen email={status.email} onBack={() => setRoute({ kind: 'inbox' })} onLoggedOut={signedOut} />;
```

- [ ] **Step 5: Run the PWA suite and the typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (37 files, 380 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add pwa/src/ui/App.tsx pwa/src/ui/LoginScreen.tsx pwa/tests/ui/App.test.tsx pwa/tests/ui/login.test.tsx
git commit -m "feat(pwa): route on the Proton state, and sign in to Proton over the app"
```

---

### Task 16: Settings → Passkeys

**Files:**
- Create: `pwa/src/ui/PasskeysSection.tsx`, `pwa/tests/ui/PasskeysSection.test.tsx`
- Modify: `pwa/src/ui/SettingsScreen.tsx`, `pwa/src/ui/App.tsx`
- Test: `pwa/tests/ui/SettingsScreen.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `pwa/tests/ui/PasskeysSection.test.tsx`. `unfinished()` builds a setup that waits for its second tap:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { PasskeysSection, type PasskeysSectionProps } from '../../src/ui/PasskeysSection.js';
import type { EnrolOutcome, PasskeysClient } from '../../src/auth/flows.js';
import { ApiError, type PasskeyBegin, type PasskeyEntry } from '../../src/api.js';

const BEGIN: PasskeyBegin = { salt: 'c2FsdA', userHandle: 'dXNlcg', excludeCredentials: [] };
const PHONE: PasskeyEntry = { credentialId: 'AQEBAQEBAQEBAQEBAQEBAQ', label: 'Phone', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null };
const LAPTOP: PasskeyEntry = { credentialId: 'AgICAgICAgICAgICAgICAg', label: 'Laptop', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null };
const PRF_TEXT = 'This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password.';

function setup(over: Partial<PasskeysClient> = {}, props: Partial<PasskeysSectionProps> = {}) {
  const client: PasskeysClient = {
    list: vi.fn().mockResolvedValue({ passkeys: [PHONE], notice: null }),
    remove: vi.fn().mockResolvedValue({}),
    begin: vi.fn().mockResolvedValue(BEGIN),
    enrol: vi.fn().mockResolvedValue({ kind: 'added', passkey: LAPTOP }),
    ...over,
  };
  const onChanged = vi.fn();
  const { unmount } = render(<PasskeysSection email="user@example.test" live onChanged={onChanged} client={client} {...props} />);
  return { client, onChanged, unmount };
}

/** Opens the name form and waits until the begin fetched for it has arrived. */
async function startAdding(name = 'Laptop') {
  fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
  const field = screen.getByRole('textbox', { name: 'Name' });
  expect(field).toHaveValue('Passkey');
  fireEvent.input(field, { target: { value: name } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
}

describe('PasskeysSection', () => {
  it('lists each passkey with when it was added and last used', async () => {
    setup({ list: vi.fn().mockResolvedValue({ passkeys: [PHONE, { ...LAPTOP, lastUsedAt: '2026-10-13T11:00:00.000Z' }], notice: null }) });
    const list = await screen.findByRole('list', { name: 'Passkeys' });
    expect(within(list).getByText('Phone')).toBeInTheDocument();
    expect(within(list).getByText(/never used/i)).toBeInTheDocument();
    expect(within(list).getByText(/last used/i)).toBeInTheDocument();
  });

  it('says once that a password change removed the passkeys', async () => {
    setup({ list: vi.fn().mockResolvedValue({ passkeys: [], notice: 'password_changed' }) });
    expect(await screen.findByText('Your passkeys were removed because your Proton password changed. Add one again.')).toBeInTheDocument();
    expect(screen.getByText('No passkeys yet.')).toBeInTheDocument();
  });

  it('adds a named passkey with the begin fetched on Add passkey', async () => {
    const { client, onChanged } = setup();
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(client.enrol).toHaveBeenCalledWith('Laptop', 'user@example.test', BEGIN);
    expect(screen.getByText('Passkey added.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  for (const [label, outcome, text] of [
    ['no PRF support', { kind: 'prf_unsupported', forgotten: true }, PRF_TEXT],
    ['an already added passkey', { kind: 'already_added' }, 'This passkey is already added.'],
    ['an expired setup', { kind: 'expired', forgotten: true }, 'Setup expired. Try again.'],
  ] as const) {
    it(`explains ${label}`, async () => {
      const { onChanged } = setup({ enrol: vi.fn().mockResolvedValue(outcome) });
      await startAdding();
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(onChanged).not.toHaveBeenCalled();
    });
  }

  it('says where to delete a passkey the browser could not hide', async () => {
    setup({ enrol: vi.fn().mockResolvedValue({ kind: 'prf_unsupported', forgotten: false }) });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/you can delete it there/i)).toBeInTheDocument();
  });

  /** An enrolment that needs a second tap; `finish` and `abandon` are its two ways out. */
  function unfinished(finished: EnrolOutcome = { kind: 'added', passkey: LAPTOP }) {
    const finish = vi.fn<() => Promise<EnrolOutcome>>().mockResolvedValue(finished);
    const abandon = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const outcome: EnrolOutcome = { kind: 'finish_setup', finish, abandon };
    return { finish, abandon, enrol: vi.fn().mockResolvedValue(outcome) };
  }

  it('finishes setup from its own button when the follow-up prompt needed a tap', async () => {
    const { finish, abandon, enrol } = unfinished();
    setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(finish).toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
  });

  it('offers nothing but Finish setup or Cancel setup while a setup waits for its tap', async () => {
    setup({ enrol: unfinished().enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Finish setup' });
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull();
  });

  it('hides the half-made passkey when the setup is cancelled', async () => {
    const { abandon, enrol } = unfinished();
    setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel setup' }));
    expect(await screen.findByText('Setup cancelled.')).toBeInTheDocument();
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeInTheDocument();
  });

  it('hides the half-made passkey when Settings closes before the setup finished', async () => {
    const { abandon, enrol } = unfinished();
    const { unmount } = setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Finish setup' });
    unmount();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it('says where to delete a passkey the server refused when the browser could not hide it', async () => {
    setup({ enrol: vi.fn().mockResolvedValue({ kind: 'failed', code: 'internal', forgotten: false }) });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/could not add the passkey\. try again\. the passkey was still saved/i)).toBeInTheDocument();
  });

  it('removes a passkey, and treats one already gone as removed', async () => {
    const { client, onChanged } = setup({
      list: vi.fn().mockResolvedValue({ passkeys: [PHONE, LAPTOP], notice: null }),
      remove: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError('not_found', 404, 'not_found')),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
    await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
    expect(client.remove).toHaveBeenCalledWith(PHONE.credentialId);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Laptop' }));
    await waitFor(() => expect(screen.queryByText('Laptop')).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('offers no Add passkey without live Proton keys', async () => {
    setup({}, { live: false });
    expect(await screen.findByText('Phone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull();
  });
});
```

In `pwa/tests/ui/SettingsScreen.test.tsx`:

Before

```tsx
  it('goes back', async () => {
```

add

```tsx
  it('hides passkeys, and the sign-out note about them, without unlock', async () => {
    setup();
    await screen.findByRole('checkbox', { name: /file automatically/i });
    expect(screen.queryByRole('heading', { name: 'Passkeys' })).toBeNull();
    expect(screen.queryByText(/also removes your passkey unlocks/i)).toBeNull();
  });

  it('shows Settings → Passkeys in header mode', async () => {
    const passkeysClient = {
      list: vi.fn().mockResolvedValue({ passkeys: [], notice: null }),
      remove: vi.fn(),
      begin: vi.fn(),
      enrol: vi.fn(),
    };
    render(
      <SettingsScreen
        email="user@example.test"
        documents={{ settings: vi.fn().mockResolvedValue(SETTINGS), folders: vi.fn().mockResolvedValue({ walkedAt: '2026-10-10T12:00:00.000Z', folders: FOLDERS }) } as unknown as DocumentsApi}
        onBack={vi.fn()}
        onLoggedOut={vi.fn()}
        unlockAvailable
        proton="live"
        passkeysClient={passkeysClient}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Passkeys' })).toBeInTheDocument();
    expect(await screen.findByText('No passkeys yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeInTheDocument();
    expect(screen.getByText('Signing out also removes your passkey unlocks.')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd pwa && pnpm exec vitest run tests/ui/PasskeysSection.test.tsx tests/ui/SettingsScreen.test.tsx`

Expected: FAIL: `Failed to resolve import "../../src/ui/PasskeysSection.js"`, and no "Passkeys" heading in Settings with `unlockAvailable`.

- [ ] **Step 3: Implement the section**

Create `pwa/src/ui/PasskeysSection.tsx`. Add passkey fetches `begin` at once, so the Continue tap starts the passkey prompt with no request before it. While a setup waits for its Finish setup tap, only Finish setup and Cancel setup show; cancelling, or leaving Settings, abandons it (the password manager is asked to hide the passkey):

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError, type PasskeyBegin, type PasskeyEntry } from '../api.js';
import { passkeysClient, type EnrolOutcome, type PasskeysClient } from '../auth/flows.js';

export interface PasskeysSectionProps {
  email: string;
  /** Adding needs live Proton keys: the server wraps the passphrase it holds. */
  live: boolean;
  /** A passkey was added or removed: the app's status count is stale. */
  onChanged: () => void;
  client?: PasskeysClient;
}

const PRF_UNSUPPORTED = 'This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password.';
const DELETE_HINT = ' The passkey was still saved in your password manager; you can delete it there.';
const REMOVED_NOTICE = 'Your passkeys were removed because your Proton password changed. Add one again.';
const ADDED = 'Passkey added.';

const day = (iso: string) => new Date(iso).toLocaleDateString();

function messageFor(outcome: Exclude<EnrolOutcome, { kind: 'added' } | { kind: 'finish_setup' }>): string {
  // A passkey the server refused, which the browser couldn't hide.
  const hint = outcome.kind === 'failed' && outcome.forgotten === false ? DELETE_HINT : '';
  switch (outcome.kind) {
    case 'cancelled':
      return 'Setup cancelled.';
    case 'already_added':
      return 'This passkey is already added.';
    case 'prf_unsupported':
      return PRF_UNSUPPORTED + (outcome.forgotten ? '' : DELETE_HINT);
    case 'expired':
      return 'Setup expired. Try again.' + (outcome.forgotten ? '' : DELETE_HINT);
    case 'failed':
      return (outcome.code === 'proton_not_live' ? 'Sign in to Proton first, then add a passkey.' : 'Could not add the passkey. Try again.') + hint;
  }
}

/** Settings → Passkeys (passkey-unlock spec §3). Rendered only when unlock is available. */
export function PasskeysSection({ email, live, onChanged, client = passkeysClient }: PasskeysSectionProps) {
  const [passkeys, setPasskeys] = useState<PasskeyEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState('Passkey');
  // Fetched when Add passkey is tapped, so Continue starts the prompt straight away.
  const [begin, setBegin] = useState<PasskeyBegin | 'loading' | null>(null);
  const [busy, setBusy] = useState(false);
  // A created passkey waiting for its Finish setup tap.
  const [finish, setFinish] = useState<{ run: () => Promise<EnrolOutcome>; abandon: () => Promise<boolean> } | null>(null);
  // The same abandon, for the unmount cleanup, which sees no later state.
  const pendingAbandon = useRef<(() => Promise<boolean>) | null>(null);
  const mounted = useRef(true);
  // A layout effect: Preact 11 runs useEffect cleanups after paint, too late for this guard.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving Settings mid-setup: hide the passkey that will never unlock.
      void pendingAbandon.current?.();
    };
  }, []);

  useEffect(() => {
    client
      .list()
      .then((r) => {
        if (!mounted.current) return;
        setPasskeys(r.passkeys);
        if (r.notice === 'password_changed') setNotice(REMOVED_NOTICE);
      })
      .catch(() => mounted.current && setMessage('Could not load passkeys.'));
  }, [client]);

  function fetchBegin() {
    setBegin('loading');
    client
      .begin()
      .then((b) => mounted.current && setBegin(b))
      // Continue fetches it itself then.
      .catch(() => mounted.current && setBegin(null));
  }

  function startAdding() {
    setLabel('Passkey');
    setMessage(null);
    setNaming(true);
    fetchBegin();
  }

  async function run(step: () => Promise<EnrolOutcome>) {
    setBusy(true);
    setMessage(null);
    const outcome = await step();
    if (!mounted.current) return;
    setBusy(false);
    setFinish(null);
    pendingAbandon.current = null;
    if (outcome.kind === 'added') {
      setPasskeys((list) => [...(list ?? []), outcome.passkey]);
      setNaming(false);
      setBegin(null);
      setNotice(null);
      setMessage(ADDED);
      onChanged();
    } else if (outcome.kind === 'finish_setup') {
      setFinish({ run: outcome.finish, abandon: outcome.abandon });
      pendingAbandon.current = outcome.abandon;
      setNaming(false);
      setMessage('One more step: tap Finish setup to turn on unlocking.');
    } else {
      setMessage(messageFor(outcome));
      // The server forgot that salt: the next try needs a new one.
      if (outcome.kind === 'expired') fetchBegin();
    }
  }

  async function cancelSetup() {
    if (!finish) return;
    setFinish(null);
    pendingAbandon.current = null;
    const forgotten = await finish.abandon();
    if (mounted.current) setMessage('Setup cancelled.' + (forgotten ? '' : DELETE_HINT));
  }

  async function remove(credentialId: string) {
    setMessage(null);
    try {
      await client.remove(credentialId);
    } catch (e) {
      // Already gone is what was asked for.
      if (!(e instanceof ApiError && e.status === 404)) {
        if (mounted.current) setMessage('Could not remove the passkey.');
        return;
      }
    }
    if (!mounted.current) return;
    setPasskeys((list) => (list ?? []).filter((p) => p.credentialId !== credentialId));
    onChanged();
  }

  return (
    <>
      <h2>Passkeys</h2>
      <div class="card">
        <p class="muted">A passkey unlocks filing after a server restart, without your Proton password.</p>
        {notice && <p class="warn">{notice}</p>}
        {passkeys !== null && passkeys.length === 0 && <p class="muted">No passkeys yet.</p>}
        {passkeys !== null && passkeys.length > 0 && (
          <ul class="doc-list" role="list" aria-label="Passkeys">
            {passkeys.map((p) => (
              <li key={p.credentialId} class="doc-row">
                <span class="doc-main">
                  <span class="doc-name">{p.label}</span>
                  <br />
                  <span class="muted">
                    Added {day(p.createdAt)} · {p.lastUsedAt ? `Last used ${day(p.lastUsedAt)}` : 'Never used'}
                  </span>
                </span>
                <button class="btn btn-secondary btn-small" aria-label={`Remove ${p.label}`} onClick={() => void remove(p.credentialId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {live &&
          !finish &&
          (naming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => client.enrol(label, email, begin === null || begin === 'loading' ? undefined : begin));
              }}
            >
              <label class="field">
                <span class="field-label">Name</span>
                <input value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
              </label>
              <div class="actions">
                <button class="btn" type="submit" disabled={busy || begin === 'loading'}>
                  {busy ? 'Waiting for the passkey…' : 'Continue'}
                </button>
                <button class="btn btn-secondary" type="button" disabled={busy} onClick={() => setNaming(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button class="btn btn-secondary" onClick={startAdding}>
              Add passkey
            </button>
          ))}
        {finish && (
          <div class="actions">
            <button class="btn" disabled={busy} onClick={() => void run(finish.run)}>
              Finish setup
            </button>
            <button class="btn btn-secondary" disabled={busy} onClick={() => void cancelSetup()}>
              Cancel setup
            </button>
          </div>
        )}
        <p role="status" class={message === ADDED ? 'muted' : 'error-text'}>
          {message}
        </p>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Show it in Settings**

In `pwa/src/ui/SettingsScreen.tsx`:

Replace

```tsx
import { api, ApiError } from '../api.js';
```

with

```tsx
import { api, ApiError, type ProtonState } from '../api.js';
import type { PasskeysClient } from '../auth/flows.js';
```

After

```tsx
import { FolderPicker } from './inbox/FolderPicker.js';
```

add

```tsx
import { PasskeysSection } from './PasskeysSection.js';
```

Replace

```tsx
  onBack: () => void;
  onLoggedOut: () => void;
}
```

with

```tsx
  onBack: () => void;
  onLoggedOut: () => void;
  /** Header mode: passkeys can unlock, so Settings shows them (passkey-unlock spec §3). */
  unlockAvailable?: boolean;
  proton?: ProtonState;
  /** A passkey was added or removed. */
  onPasskeysChanged?: () => void;
  passkeysClient?: PasskeysClient;
}
```

Replace

```tsx
export function SettingsScreen({ email, documents = documentsApi, onBack, onLoggedOut }: SettingsScreenProps) {
```

with

```tsx
export function SettingsScreen({
  email,
  documents = documentsApi,
  onBack,
  onLoggedOut,
  unlockAvailable = false,
  proton = 'live',
  onPasskeysChanged = () => {},
  passkeysClient,
}: SettingsScreenProps) {
```

Above Account, and a note under Sign out:

Replace

```tsx
      <h2>Account</h2>
      <div class="card">
        <p>
          Signed in as <strong>{email}</strong>
        </p>
        <button class="btn btn-secondary" onClick={() => void logout()}>
          Sign out
        </button>
```

with

```tsx
      {unlockAvailable && (
        <PasskeysSection
          email={email}
          live={proton === 'live'}
          onChanged={onPasskeysChanged}
          {...(passkeysClient ? { client: passkeysClient } : {})}
        />
      )}

      <h2>Account</h2>
      <div class="card">
        <p>
          Signed in as <strong>{email}</strong>
        </p>
        <button class="btn btn-secondary" onClick={() => void logout()}>
          Sign out
        </button>
        {unlockAvailable && <p class="muted">Signing out also removes your passkey unlocks.</p>}
```

In `pwa/src/ui/App.tsx`, pass the status on, and refresh it when a passkey is added or removed:

Replace

```tsx
      return <SettingsScreen email={status.email} onBack={() => setRoute({ kind: 'inbox' })} onLoggedOut={signedOut} />;
```

with

```tsx
      return (
        <SettingsScreen
          email={status.email}
          unlockAvailable={status.unlockAvailable}
          proton={status.proton}
          onPasskeysChanged={() => void refreshStatus()}
          onBack={() => setRoute({ kind: 'inbox' })}
          onLoggedOut={signedOut}
        />
      );
```

- [ ] **Step 5: Run the PWA suite and the typecheck**

Run: `pnpm --filter @doc-scanner/pwa test && pnpm --filter @doc-scanner/pwa run typecheck`

Expected: PASS (38 files, 396 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add pwa/src/ui/PasskeysSection.tsx pwa/src/ui/SettingsScreen.tsx pwa/src/ui/App.tsx pwa/tests/ui/PasskeysSection.test.tsx pwa/tests/ui/SettingsScreen.test.tsx
git commit -m "feat(pwa): Settings → Passkeys"
```

---

### Task 17: Deployment config, docs and full verification

**Files:**
- Modify: `compose.yml`, `.env.example`, `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`, `docs/superpowers/specs/2026-10-13-passkey-unlock-design.md`

- [ ] **Step 1: `compose.yml`**

After

```yaml
      INSECURE_COOKIES: ${INSECURE_COOKIES:-false}
```

add

```yaml
      # Header mode (docs/superpowers/specs/2026-10-13-passkey-unlock-design.md):
      # the Authelia username. Set, the proxy's Remote-User signs requests in, so
      # a restart no longer signs you out and a passkey can unlock filing. The
      # proxy must overwrite or strip any client-sent Remote-User on every route
      # to the app, Authelia bypass rules included. Empty: the app's own sign-in.
      AUTH_PROXY_USER: ${AUTH_PROXY_USER:-}
      # Needed while `ports` publishes the app (even on 127.0.0.1): anything that
      # reaches the port could send a forged Remote-User. At least 32 characters;
      # the proxy sends it as X-Doc-Scanner-Proxy-Secret on every request. Not
      # needed when the port is unpublished and only the proxy shares a network.
      AUTH_PROXY_SECRET: ${AUTH_PROXY_SECRET:-}
```

- [ ] **Step 2: `.env.example`**

After

```
INSECURE_COOKIES=false
```

add

```

# Header mode: the Authelia username. Leave empty for the app's own sign-in
# (development). compose.yml says when AUTH_PROXY_SECRET is needed.
AUTH_PROXY_USER=
# At least 32 characters; the proxy sends it as X-Doc-Scanner-Proxy-Secret.
AUTH_PROXY_SECRET=
```

- [ ] **Step 3: `README.md`**

In the environment table:

After

```markdown
| `INSECURE_COOKIES`       | Default `false`. Set `true` **only** for local `http://` development: it drops the `Secure` flag from the session cookie. Deployments must use HTTPS. |
```

add

```markdown
| `AUTH_PROXY_USER`        | Optional. Your Authelia username. It turns on header mode: the proxy's `Remote-User` signs requests in, so a restart doesn't sign you out, and a passkey can unlock filing. Unset, the app uses its own sign-in cookie. |
| `AUTH_PROXY_SECRET`      | Optional, at least 32 characters, and only with `AUTH_PROXY_USER`. Needed when the port is published (as `compose.yml` does on `127.0.0.1`); the proxy sends it as `X-Doc-Scanner-Proxy-Secret`. |
```

and after the production paragraph (the one starting "For production, put a reverse proxy in front"), add a paragraph:

```markdown
With Authelia in front, set `AUTH_PROXY_USER` to your Authelia username (header mode). A restart then keeps you signed in, and filing pauses until you tap **Unlock** with a passkey (add one in Settings → Passkeys: an iCloud Keychain passkey on iOS 18.4 or later, or 1Password) or sign in to Proton again. Header mode trusts `Remote-User`, so: keep the container port unpublished, with the proxy on a shared Docker network; or, if the port is published (including the `127.0.0.1:3000` in `compose.yml`), set `AUTH_PROXY_SECRET` and have the proxy send it as `X-Doc-Scanner-Proxy-Secret` on every request. Either way, the proxy must overwrite or strip any client-supplied `Remote-User` on every route to the app, including Authelia `bypass` rules.
```

- [ ] **Step 4: `CLAUDE.md`**

In **Required environment**:

Replace

```markdown
Others: `DB_PATH`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `INSECURE_COOKIES`. Analyzer settings:
```

with

```markdown
Others: `DB_PATH`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `INSECURE_COOKIES`. Header mode: `AUTH_PROXY_USER` (the Authelia username; set, the proxy's `Remote-User` signs requests in) and `AUTH_PROXY_SECRET` (at least 32 characters, only with `AUTH_PROXY_USER`; the proxy sends it as `X-Doc-Scanner-Proxy-Secret`, needed when the port is published). Analyzer settings:
```

In the **Auth (`auth/`)** bullet:

After

```markdown
lives in-process for the cookie's lifetime (`live-session.ts`).
```

add

```markdown
**Header mode** (`AUTH_PROXY_USER`; spec `2026-10-13-passkey-unlock-design.md`): the middleware signs a request in when Authelia's `Remote-User` matches (and `AUTH_PROXY_SECRET`, if set), keeps one live session under `PROXY_SID`, and refuses cross-site `POST`/`PUT`/`PATCH`/`DELETE` by `Sec-Fetch-Site`; cookie mode (unset) is the development default. After a restart, Proton is `locked` (tokens stored, keys gone) until a **passkey unlock**: `PasskeyStore` (`passkey-store.ts`) wraps the mailbox passphrase under HKDF of the passkey's WebAuthn PRF output, then the `passkeys` at-rest cipher, and `ProtonAuth.resume` opens the keys with the stored tokens (the session keeps the fingerprint recorded at enrolment). Login, unlock and logout share a mutex, and every `ProtonApi` request times out after 30 s so none can hold it. A login never logs out first; a different Proton `User.ID` clears the SDK caches, the folder cache and the passkeys; a changed key salt removes the passkeys, and so does logout. Never log a PRF output, the passphrase, a salt or a passkey label; credential ids only by their first 8 characters.
```

In the PWA paragraph:

Replace

```markdown
and `ui/SettingsScreen.tsx` (filing settings, folder refresh, theme, sign-out);
```

with

```markdown
and `ui/SettingsScreen.tsx` (filing settings, folder refresh, Passkeys, theme, sign-out); `auth/` (`passkeys.ts` wraps WebAuthn and the PRF extension, `flows.ts` joins it to the API for unlock and enrolment);
```

- [ ] **Step 5: The parent spec's Trust boundary**

In `docs/superpowers/specs/2026-10-09-ai-document-filing-design.md`:

Replace

```markdown
- Decrypted Proton user and address keys live **only in memory**, for the lifetime of a login. A server restart forces re-login (`middleware.ts`). This spec does not change that: persisting the key passphrase would mean that a stolen database plus `SESSION_ENCRYPTION_KEY` decrypts the whole Drive, where today it yields only API tokens.
```

with

```markdown
- Decrypted Proton user and address keys live **only in memory**, for the lifetime of a login, and a server restart drops them. In header mode ([passkey-unlock spec](2026-10-13-passkey-unlock-design.md)) the app stays signed in through Authelia, and a passkey unlock (one Face ID tap) opens them again; otherwise a restart forces a full Proton login. The key passphrase is never stored in a form the database and `SESSION_ENCRYPTION_KEY` alone can open: a passkey wrap also needs the passkey's PRF output. So a stolen database plus the key still yields API tokens, not the Drive.
```

- [ ] **Step 6: The spec**

In `docs/superpowers/specs/2026-10-13-passkey-unlock-design.md`, record the plan and its deviations:

Replace

```markdown
**Status:** Approved design; not yet planned
```

with

```markdown
**Status:** Approved design; planned in [`2026-10-13-passkey-unlock.md`](../plans/2026-10-13-passkey-unlock.md)
```

Replace

```markdown
4. `GET /api/passkeys` returns `[{ credentialId, label, createdAt, lastUsedAt }]`.
```

with

```markdown
4. `GET /api/passkeys` returns `{ passkeys: [{ credentialId, label, createdAt, lastUsedAt }], notice }`. `notice` is `'password_changed'` on the first read after a login removed the passkeys for a changed password (the read clears it), else `null`: that is how Settings says why, once.
```

Replace

```markdown
and `ProtonAuth.login` and `ProtonAuth.resume` both return `keySaltFingerprint` (SHA-256 of the primary user key's `KeySalt`; `resume` calls `getKeySalts` too, since it has no password step). `LiveSession` keeps `userId` and `keySaltFingerprint`, so enrolment can write the fingerprint whichever way the session started.
```

with

```markdown
and `ProtonAuth.login` returns `keySaltFingerprint` (SHA-256 of the primary user key's `KeySalt`). `ProtonAuth.resume` doesn't fetch the salts: a successful unlock proves the passphrase, and so the KeySalt, unchanged since enrolment, and while any passkey exists the stored `passkeys.key_salt_fingerprint` is current. So the unlock carries the stored value into the session. `LiveSession` keeps `userId` and `keySaltFingerprint` (null if none is stored), and enrolment writes the fingerprint when the session knows it.
```

Replace

```markdown
**`ProtonAuth.resume(session, passphraseBytes, { onRefreshed }) → { session, decryptedKeys, userId, keySaltFingerprint }`**
```

with

```markdown
**`ProtonAuth.resume(session, passphraseBytes, { onRefreshed }) → { session, decryptedKeys, userId }`**
```

Replace

```markdown
        - A network error, 429 or 5xx (from `getUser` or `refresh`): change nothing, 503 `proton_unavailable` (retryable).
```

with

```markdown
        - A network error, 429 or 5xx (from `getUser` or `refresh`): change nothing, 503 `proton_unavailable` (retryable). A network error is undici's `TypeError('fetch failed')` (or a `TypeError` with a `cause`), or a timeout: every Proton request gives up after 30 seconds, so a hung call can't hold the mutex. Any other `TypeError` is a bug, reported, and answers 500.
```

Replace

```markdown
A passkey that was created but never stored on the server (no PRF, an expired or restarted enrolment) is left in the password manager;
```

with

```markdown
A passkey that was created but never stored on the server (no PRF, an expired or restarted enrolment, any other refusal by the server, or a setup abandoned at **Finish setup**) is left in the password manager;
```

After

```markdown
- **With passkeys:** "Filing is paused until you unlock." with an **Unlock** button. The button is tapped, never auto-triggered, because iOS needs a user gesture. On success the status is refreshed.
```

add

```markdown
  - The banner fetches `unlock/begin` when it appears, and again after any failed unlock; Settings fetches `passkeys/begin` when **Add passkey** is tapped. So each passkey prompt starts straight from a tap, with no request in between.
  - After `proton_login_required`, `passkeys_stale` or `passkey_unreadable`, the app reads `GET /api/auth/status` again, so its Proton state and passkey count match the server's.
```

- [ ] **Step 7: Full verification**

Run from the repo root:

```bash
pnpm test && pnpm -r run typecheck && pnpm build
```

Expected: all PASS. Report the actual output. If anything fails, fix it before committing; don't paper over it.

- [ ] **Step 8: Commit**

```bash
git add compose.yml .env.example README.md CLAUDE.md docs/superpowers/specs/2026-10-09-ai-document-filing-design.md docs/superpowers/specs/2026-10-13-passkey-unlock-design.md
git commit -m "docs: header mode and passkey unlock"
```

---

### Task 18: Manual check (with the user)

This needs production, Authelia and a real iPhone, so it is the user's step, assisted:

1. **Deploy** with header mode on:
   - Set `AUTH_PROXY_USER` to the Authelia username.
   - With the port published on `127.0.0.1:3000` (as `compose.yml` does), set `AUTH_PROXY_SECRET` (`openssl rand -base64 48`), and configure the proxy to send it as `X-Doc-Scanner-Proxy-Secret` on every forwarded request.
   - Make sure the proxy overwrites or strips any client-supplied `Remote-User` on every route to the app, including Authelia `bypass` rules.
   - From the host, check that the port refuses a forged user: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Remote-User: <user>' http://127.0.0.1:3000/api/auth/status` must print `401`.
2. Open the PWA. The deploy restarted the server, so it shows the login screen or "Filing is paused. Sign in to Proton to resume." Sign in with password and 2FA; the inbox then suggests adding a passkey.
3. In Settings → Passkeys, **Add passkey** with an iCloud Keychain passkey (iOS 18.4 or later). It is listed, "Never used".
4. Restart the container (`docker compose restart app`).
5. Open the PWA: the inbox shows "Filing is paused until you unlock." Tap **Unlock**. Face ID alone resumes filing; the banner goes, and a document waiting in `awaiting_login` files. Change nothing else.
6. Optionally, add a 1Password passkey too, restart, and unlock with it.
7. Check the server log: the unlock lines carry `credential` (8 characters) and outcomes only, never a label, salt or PRF value.

---

## Self-review

**Spec coverage:**

| Spec | Task |
|---|---|
| Decisions: header mode, trusting the header, `Sec-Fetch-Site` | 1, 2 |
| §1 Config | 1 |
| §1 Middleware | 2 |
| §1 Login: header auth, `PROXY_SID`, no cookie, `startLiveSession` | 6 |
| §1 Login: mutex, no logout, different `User.ID`, key-salt fingerprint | 7 |
| §1 Where the values come from (`userId`, `keySaltFingerprint`, `LiveSession`) | 4, 5 |
| §1 Status | 6 |
| §1 Logout | 6, 7 |
| §1 Guards (404 in cookie mode) | 8, 9 |
| §1 What needs keys, resuming work | 9 (listener test) |
| §2 Data, `PasskeyStore`, `AtRestPurpose` | 3 |
| §2 Enrolment (server) | 8 |
| §2 Unlock, `ProtonAuth.resume`, error mapping, `KeyDecryptError.reason` | 4, 5, 9 |
| Additions: request timeout; dispose on failure and the account-switch order; refetch after a failed unlock; status refresh after a refusal; signalling abandoned or refused passkeys | 5; 7; 13; 13–15; 12, 16 |
| §2 Logging | 3, 8, 9 (the no-secret log test) |
| §3 `App`, sign-in-to-Proton route, `signInAgain` | 15 |
| §3 Locked banner | 13, 14 |
| §3 Nudge | 14, 15 |
| §3 Settings → Passkeys | 16 |
| §3 `passkeys.ts`, API client | 10, 11, 12 |
| §4 Security summary | 2 (header, secret, cross-site), 3 (two layers), 9 (GCM tag as the check) |
| Testing section | each task; Manual: 18 |
| Deployment, Docs | 17 |

**Type consistency:**

- `AuthMode` (`middleware.ts`) is what `createApp`, every router, `headerOnly` and `authModeFrom` take; `PROXY_SID` is `'proxy'` everywhere.
- `LiveSession.userId`/`keySaltFingerprint` are set by `startLiveSession`: from `LoginResult` on a login, and from `ResumeResult.userId` plus the stored `passkeys.key_salt_fingerprint` (`string | null`) on an unlock.
- `PasskeyStore.unwrap` returns `Uint8Array | 'unknown' | 'wrong_secret' | 'unreadable'`; the unlock route narrows on the three strings, then owns the bytes.
- Server `AuthStatus` and PWA `StatusResponse` have the same four fields; `ProtonState` is `'live' | 'locked' | 'none'` on both sides.
- `GET /api/passkeys` answers `PasskeyList` (`{ passkeys, notice }`) on both sides.
- `UnlockClient` (`prepare`, `unlock`) and `PasskeysClient` (`list`, `remove`, `begin`, `enrol`) are what `LockedBanner`, `InboxScreen`, `PasskeysSection` and `SettingsScreen` take as optional props.
- `EnrolOutcome`'s `finish_setup` carries `finish` and `abandon`, and its `failed` an optional `forgotten`; `PasskeysSection` uses all three.
- `onStatusChanged` runs from `LockedBanner` through `InboxScreen` to `App.refreshStatus`.
