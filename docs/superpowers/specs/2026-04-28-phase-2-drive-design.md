# Phase 2 — Drive Integration Design Spec

**Date:** 2026-04-28
**Status:** Draft for review
**Phase:** 2 of 5 (Skeleton + Auth → **Drive Integration** → Scanner pipeline → Classification + confirmation → Outbox + offline)
**Owner:** ow@mroliverwine.com (single-user personal project)
**Reference:** [Project design spec](2026-04-27-doc-scanner-design.md)

## Goal

Integrate the Proton Drive SDK to support the minimum demoable scope:

1. List the user's "My Files" root folder on Proton Drive.
2. Upload a single hardcoded synthetic file via a test endpoint.
3. Receive a Drive UID + Drive web URL back.

End state: hit `POST /api/drive/test-upload`, see a file appear in Proton Drive's web UI within seconds.

## Non-Goals

- Download, delete, rename, move, or sharing operations on existing files (deferred to later phases).
- Photos, devices, public links — entire SDK feature areas not exercised.
- Multi-file or chunked upload UX (Phase 3+).
- PWA-side Drive integration (Phase 4 hooks Drive into the classification + confirmation flow).
- Production-grade key recovery / mailbox-password persistence across restarts (intentionally deferred — see "Trust boundary").

## Constraints & Context

- **`@protontech/drive-sdk`** is on npm (`0.14.10` at draft time, MIT). Lean dependencies: `@noble/hashes`, `bcryptjs ^2.4.3`, `ttag`. Note SDK's `bcryptjs` upper bound includes `^2.4.3` — Phase 1 installed `bcryptjs 3.0.3`. The version range may need realignment; deferred to implementation.
- **SDK constructor requires 6 caller-provided pieces**: HTTP client, entities cache, crypto cache, account, OpenPGP module, SRP module. Most Phase 2 work is adapter code.
- **Real OpenPGP is required** — Phase 1's stubbed `crypto-impl.ts` is insufficient. We add the `openpgp` npm package and back the existing `CryptoProxy` shim with real implementations.
- **Mailbox password derivation** uses the vendored `@proton/srp/lib/keys.ts:computeKeyPassword` (already vendored in Phase 1).
- **Proton ToS** still applies: `x-pm-appversion: external-drive-docscanner@<semver>`, official endpoints only, event-based sync (no recursive traversal).
- **Authelia layer at the reverse proxy** continues to gate all access (Phase 1 setup unchanged).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Phase 2 scope | Narrow: list root + upload one synthetic file via test endpoint |
| OpenPGP backend | SDK's `OpenPGPCryptoWithCryptoProxy` wired through our `CryptoProxy` shim, backed by real `openpgp` npm package |
| Mailbox password handling | Memory only — derived at login, held in `MailboxSecret` typed wrapper, never persisted; server restart forces re-login (matches Phase 1 `liveSids` volatility) |
| Encryption scope for new storage | Entities cache: AES-GCM at rest with `SESSION_ENCRYPTION_KEY`. Crypto cache: memory only. Event cursor: plaintext (opaque, non-secret). Mailbox password + decrypted keys: memory only with type-level non-persistence guards |
| Folder cache lifecycle | Lazy + event-driven invalidation (sufficient for narrow scope; satisfies ToS via SDK's event subscription) |

## Architecture

**Login** (extends Phase 1):

1. SRP exchange completes (Phase 1, unchanged) → `{ uid, accessToken, refreshToken }`.
2. **NEW**: while plaintext password still in scope, call `auth/keys.ts:fetchAndDecryptUserKey()`:
   - GET `/users` → user info incl. `keySalt`
   - GET `/core/v4/keys/all` → armored encrypted private key
   - Vendored `computeKeyPassword(password, keySalt)` → mailbox password bytes
   - `openpgp.decryptKey({ privateKey, passphrase: mailboxPasswordBytes })` → decrypted `PrivateKey`
3. Construct in-memory `LiveSession` record: `{ sid, sessionRow, mailboxSecret: MailboxSecret, decryptedKeys, driveClient }`. Indexed by `sid` in a `Map`.
4. Plaintext password drops out of scope. Cookie issued (Phase 1 behavior).

**Drive operations:**

1. One `ProtonDriveClient` per active `LiveSession`, holding the in-memory keys and the SDK's `OpenPGPCryptoWithCryptoProxy` (routed through our `CryptoProxy` shim, now backed by `openpgp.js`).
2. Test endpoint `POST /api/drive/test-upload` (auth-required via existing Phase 1 session middleware): triggers `client.getMyFilesRootFolder()` then a hardcoded one-shot upload. Returns `{ nodeUid, driveUrl }`. Logs to `audit_log` (event=`drive_test_upload`).

**On server restart:**

`LiveSession` map is empty. Browser cookie still exists, but Phase 1's volatile `liveSids` already forces re-login. Mailbox password + keys re-derived during the re-login. UX is identical to Phase 1.

## Trust Boundary

| Material | Where it lives | Encrypted? |
|---|---|---|
| `sessions.encrypted_blob` (UID + tokens, Phase 1) | SQLite | AES-GCM at rest |
| Entities cache (folder tree metadata) | SQLite (new) | AES-GCM at rest, same key |
| Crypto cache (decrypted node keys) | `Map<string, CachedCryptoMaterial>` in process | Never persisted |
| `event_cursors.cursor` (Proton sync cursor) | SQLite (new) | Plaintext (opaque ID) |
| `MailboxSecret` (mailbox password bytes) | Process memory, in `MailboxSecret` instance | Never persisted, never logged, never serialized |
| Decrypted PrivateKey | Process memory in `LiveSession.decryptedKeys` | Never persisted |
| User's plaintext Proton password | Stack scope during login only; drops immediately after key derivation | Never persisted, never logged, never returned |

**Threat model unchanged from Phase 1**: an attacker with `SESSION_ENCRYPTION_KEY` + DB can call Proton APIs (via tokens) but cannot decrypt Drive blobs (no mailbox password on disk). Adding entities cache to the encrypted-at-rest set adds metadata (folder names) but not material more sensitive than the tokens already protect.

## Components

### New `auth/` extensions

- **`auth/secrets/mailbox-password.ts`** — `MailboxSecret` class with explicit `.use<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T>` and `.dispose(): void` (zeroes buffer). Public surface deliberately minimal. Has `toJSON() => '[REDACTED]'` and `[Symbol.for('nodejs.util.inspect.custom')] => '[REDACTED]'`. No public getter.
- **`auth/keys.ts`** — `fetchAndDecryptUserKey(api, accessToken, plaintextPassword) → { primaryAddress, primaryKey, addresses }`. Stateless; called once at login. Internally uses vendored `computeKeyPassword` + `openpgp.decryptKey`.
- **`auth/srp.ts`** (modify) — `login()` returns `{ session, mailboxSecret, decryptedKeys }`. Caller registers these in the `LiveSession` map keyed by sid.
- **`auth/crypto-impl.ts`** (modify) — replace stubs with `openpgp.js`-backed implementations:
  - `verifyCleartextMessage` → real signature verification (no longer parses-and-trusts)
  - `importPublicKey` → `openpgp.readKey`
  - `exportPublicKey` → `openpgp.write`
  - `computeHash` → unchanged (Node `crypto`)

### New `drive/` module group

- **`drive/client.ts`** — `class DriveClient` facade. Holds `ProtonDriveClient` instance. Exposes `listRoot()` and `uploadFile(name, bytes, mimeType)`. Constructed once per `LiveSession`.
- **`drive/account.ts`** — `class DriveAccount implements ProtonDriveAccount`. Holds the decrypted PrivateKey + addresses. Implements `getOwnPrimaryAddress`, `getOwnAddresses`, `getOwnAddress`, `getPublicKeys`, `hasProtonAccount`. Sharing-related calls return defaults / no-ops in Phase 2.
- **`drive/http-client.ts`** — `class DriveHttpClient implements ProtonDriveHTTPClient`. Wraps `fetch` with `x-pm-appversion`, `User-Agent`, `Authorization: Bearer <accessToken>`, `x-pm-uid`. 401 surfaces to caller (test endpoint route handler maps to `reauth_required`).
- **`drive/srp-module.ts`** — `class DriveSrpModule implements SRPModule`. Wraps `ProtonAuth.refresh()` for SDK-initiated re-auth.
- **`drive/entities-cache.ts`** — `class EntitiesCache implements ProtonDriveCache<string>`. SQLite-backed, AES-GCM-encrypted blobs keyed by string.
- **`drive/crypto-cache.ts`** — `class CryptoCache implements ProtonDriveCache<CachedCryptoMaterial>`. `Map<string, CachedCryptoMaterial>` in memory. **Separate class from `EntitiesCache`** — type-level guarantee that someone can't accidentally back the crypto cache with SQLite.
- **`drive/event-id-store.ts`** — `class EventIdStore implements LatestEventIdProvider`. Single-row SQLite, plaintext.
- **`drive/crypto-module.ts`** — Constructs SDK's `OpenPGPCryptoWithCryptoProxy` and wires our `CryptoProxy` (now real-backed). One instance per session.

### HTTP route

- **`http/routes-drive.ts`** — `POST /api/drive/test-upload`. Body: `{ name?: string }`. Generates synthetic `'doc-scanner test ' + new Date().toISOString()` payload (or uses `name` to override the default filename). Calls `liveSession.driveClient.uploadFile(name, bytes, 'text/plain')`. Returns `{ nodeUid, driveUrl }`. Logs to `audit_log`.

### Storage

- **Migration `002_drive_caches.sql`**:
  - `entities_cache (key TEXT PRIMARY KEY, encrypted_blob BLOB NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`
  - `event_cursors (id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`

### Dependencies (npm)

- **`openpgp`** (new) — exact-pinned latest stable. The OpenPGP backend.
- **`@protontech/drive-sdk`** (new) — exact-pinned latest. The SDK.
- **`bcryptjs`** — already at `3.0.3` (Phase 1). SDK manifest declares `^2.4.3`. Verify compatibility at install time; if incompatible, downgrade to a 2.x patch and document. Renovate handles future bumps once we know which range works.

## Data Flow

### Journey A: Login (extends Phase 1 Journey A)

1. PWA POST `/api/auth/login` with `{ email, password, totp? }`.
2. Server runs SRP exchange (Phase 1 unchanged through proof submission).
3. **NEW**: Server calls `fetchAndDecryptUserKey(api, accessToken, password)`:
   - Fetches `/users` and `/core/v4/keys/all`.
   - Derives mailbox password via vendored `computeKeyPassword`.
   - Decrypts armored private key with `openpgp.decryptKey`.
4. Server registers `LiveSession` in in-memory `Map<sid, LiveSession>`.
5. Plaintext password drops out of scope.
6. Cookie issued (HttpOnly, SameSite=Strict, Secure).

### Journey B: Test upload

1. PWA (or curl) POSTs `/api/drive/test-upload` with cookie.
2. Session middleware → `LiveSession`.
3. Route handler calls `liveSession.driveClient.uploadFile('test.txt', synthBytes, 'text/plain')`.
4. SDK pulls account → adapter returns decrypted PrivateKey from memory.
5. SDK encrypts payload locally, calls `DriveHttpClient.fetch(...)` for chunk upload.
6. SDK populates entities + crypto caches transparently.
7. Returns `{ nodeUid }`. Server constructs `driveUrl` (Drive web format), writes audit log entry.
8. Response: `{ nodeUid, driveUrl }`.

### Journey C: Token refresh mid-flight

1. SDK call returns 401 from Proton API.
2. SDK invokes `DriveSrpModule.refresh()`.
3. Adapter calls our existing `ProtonAuth.refresh(session)` → new tokens.
4. SDK retries the original call with fresh tokens.
5. If refresh fails (refresh token invalid/expired), bubbles up to route handler → 401 with `reauth_required` flag → PWA bounces to login.

## Error Handling & Edge Cases

### Login failures (new in Phase 2)
- `/users` or `/keys` 4xx → abort login, return 500 to PWA with `key_fetch_failed`. Don't issue cookie. Don't persist tokens.
- OpenPGP key decryption fails (mailbox password wrong) → should be impossible if SRP succeeded with the same password. If it does, abort same as above with `key_decrypt_failed`. Log OpenPGP error message (no key material) for debugging.
- `openpgp` init or wasm load failure → server fails fast at boot.

### Drive operation failures
- Test upload 401 mid-flight → SDK calls `SRPModule.refresh()`. If refresh fails, route returns 401 with `reauth_required`.
- OpenPGP runtime error during upload → 500 with verbatim error. The synthetic payload is deterministic, so this indicates a real bug.
- SDK constructor fails (caches misconfigured) → fail fast at server boot if always-fail; otherwise fail at first session login.

### Mailbox-secret leakage prevention
- `MailboxSecret` overrides `toJSON` and `[Symbol.for('nodejs.util.inspect.custom')]` to return `'[REDACTED]'`.
- Pino logger configured with a `serializers` entry that maps any object containing a `mailboxSecret` field to `'[REDACTED]'` defensively.
- A unit test asserts logging an object with a `MailboxSecret` field does not produce the underlying bytes.

### Rate limiting / Proton API politeness (continued)
- Existing User-Agent + Accept-Language + x-pm-appversion (Phase 1 fix) carries through.
- Upload concurrency capped at 1 (light volume; far under any rate ceiling).

### Data integrity
- Each successful test upload writes one row to `audit_log` with `event=drive_test_upload`, `detail` JSON of `{ filename, nodeUid, driveUrl }`, `remote_user` from forward-auth header.

### Explicitly NOT handled
- Crypto cache eviction or memory bound — for narrow scope, the working set is tiny.
- Cross-session sharing of `ProtonDriveClient` instances — each `LiveSession` gets its own (single-user app, so just one anyway).
- File conflict resolution (uploading "test.txt" twice will produce SDK's auto-suffix or error; whichever, we report it back unmodified).

## Testing

### Unit (Vitest, mocked)

- `auth/secrets/mailbox-password.ts`:
  - `use()` provides bytes correctly
  - `dispose()` zeroes the buffer
  - `toJSON()` returns `'[REDACTED]'`
  - `inspect.custom` returns `'[REDACTED]'`
  - Logging an object containing it does not expose the underlying bytes
- `auth/keys.ts`:
  - Fixture `/users` + `/keys` responses + fixture armored key + known mailbox password → decryption succeeds
  - Wrong password → throws `key_decrypt_failed`-shaped error
- `auth/crypto-impl.ts` (rewritten):
  - Real `verifyCleartextMessage` against fixture: known-good signed cleartext + Proton's modulus key → returns valid status
  - Real `verifyCleartextMessage` with tampered signature → returns invalid status
  - `computeHash` parity with Node `crypto` for SHA-256, SHA-512, MD5 vectors
- `drive/account.ts`:
  - Mocked private keys → `getOwnPrimaryAddress`, `getOwnAddresses`, `getOwnAddress(byEmail)`, `getOwnAddress(byId)` return expected shapes
- `drive/http-client.ts`:
  - Mocked fetch → assert `Authorization`, `x-pm-uid`, `x-pm-appversion`, `User-Agent` headers all present
  - 401 response → triggers caller's refresh hook (assertion via spy)
- `drive/entities-cache.ts`:
  - Round-trip: write key=foo blob=bar, read back → bar
  - Wrong encryption key → throws on read
- `drive/crypto-cache.ts`:
  - Basic Map semantics; no persistence (assert no DB writes happen)
- `drive/event-id-store.ts`:
  - Round-trip cursor; single-row contract enforced

### Integration (gated `INTEGRATION=1`, real Proton test account)

- `tests/drive/login-with-keys.integration.test.ts` — logs in, asserts `LiveSession` has decrypted keys + non-empty mailbox secret. Disposes after.
- `tests/drive/list-root.integration.test.ts` — fresh login, calls `client.getMyFilesRootFolder()`, asserts UID + name. Verifies entities cache populated.
- `tests/drive/upload.integration.test.ts` — fresh login, uploads `'doc-scanner test ' + ts` synthetic payload, asserts node UID returned. **Cleanup**: deletes the file after assertion (uses SDK's delete, even though we don't expose it via PWA in this phase).

### Manual smoke (Phase 2 close)

- Boot stack (Docker for API, Vite for PWA — Phase 1 setup).
- Log into PWA as test account.
- `curl -X POST http://localhost:3000/api/drive/test-upload -H "Cookie: docscanner_sid=..." -d '{"name":"smoke-test.txt"}'`.
- Verify file appears in https://drive.proton.me web UI.
- Delete it manually after smoke.

### Deliberately not tested

- The Drive SDK itself (trust their tests).
- Multi-file or chunked upload performance.
- Sharing, photos, public links — out of scope.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `openpgp` API changes between minor versions break key decryption | Medium | Pin exact, run integration test against real Proton on every Renovate bump (CI gate). |
| SDK's `bcryptjs ^2.4.3` constraint conflicts with Phase 1's `bcryptjs 3.0.3` | Medium | Verify compatibility at install; downgrade if needed. Document in vendor README. |
| Vendored SRP code drifts further from upstream after re-vendoring crypto bits | Low | Same pinned-SHA + re-vendor-procedure pattern as Phase 1 (already documented). |
| `liveSession` map memory growth (single-user app, but still) | Low | One entry max in normal operation. Cookie issuance creates one; logout disposes. |
| Mailbox password leak via unanticipated logging path | Medium | `toJSON`/`inspect.custom` poison-pills + Pino serializers + unit test asserting log output is clean. |
| Real OpenPGP swap breaks Phase 1's SRP integration test | Low | Re-run Phase 1 integration test as part of Phase 2 verification before declaring done. |

## Definition of Done

- All unit tests pass (`npm test` from repo root): Phase 1's 21 + new ones.
- Integration tests pass with `INTEGRATION=1` against real Proton test account: Phase 1's SRP login + new login-with-keys + list-root + upload (with cleanup).
- Phase 1 manual smoke (login + status persistence) still works.
- Phase 2 manual smoke succeeds end-to-end.
- `audit_log` records the test-upload event correctly.
- Vendor README in `server/src/vendor/proton-srp/README.md` is unchanged (no new vendoring; we only added npm `openpgp` + SDK).

## Open Questions

- Whether `bcryptjs ^2.4.3` (SDK) and `3.0.3` (Phase 1) are compatible — verify at install.
- Whether the SDK's `OpenPGPCryptoWithCryptoProxy` requires CryptoProxy to be set globally (singleton) or accepts per-instance wiring — TBD by SDK source inspection during implementation.
- Path to Phase 5's persistent `liveSids` change: when that lands, decide whether to also persist mailbox password (encrypted) or keep "Drive-needing operations require re-login" UX — out of scope for Phase 2.
