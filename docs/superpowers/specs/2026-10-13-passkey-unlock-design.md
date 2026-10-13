# Passkey Unlock and Proxy Sign-in: Design Spec

**Date:** 2026-10-13
**Status:** Approved design; not yet planned
**Parent spec:** [`2026-10-09-ai-document-filing-design.md`](2026-10-09-ai-document-filing-design.md) (Trust boundary)
**Branch:** `feat/passkey-unlock`

## Why this exists

Every server restart forces a full Proton login (password and 2FA). Deploys happen often, since every merged Renovate PR publishes a new image.

There are two causes:
1. **The app's own sign-in lives in memory.** The `liveSids` set in `http/middleware.ts` is cleared on restart, and the cookie has no `Max-Age`.
2. **The decrypted Proton keys live only in memory, by design.** The stored Proton tokens survive a restart, but the key passphrase (the "mailbox password") is never persisted, so nothing can decrypt the keys again without the user.

The app already sits behind Authelia's forward-auth, and the server reads `Remote-User` (for logs only). This spec:
- lets **Authelia decide who the user is**, so a restart doesn't sign the user out, and
- lets a **passkey unlock the Proton keys**: one Face ID tap instead of a password and 2FA.

It keeps the parent spec's trust boundary: a stolen database plus `SESSION_ENCRYPTION_KEY` still yields API tokens, not the Drive.

### Non-goals

- Signing in to the app with a passkey. The passkey only unlocks Proton keys; Authelia remains the sign-in. Unlock exists only in header mode.
- Unattended filing across restarts. After a restart, documents wait in `awaiting_login` until the user unlocks. That is the deliberate cost of not persisting the passphrase (option A, sealing it with the env key, was considered and rejected).
- Full WebAuthn attestation or assertion verification (see Decisions).
- Logging out of Authelia from the app.
- Rate limiting unlock (see Security).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Who the user is | **Header mode**: when `AUTH_PROXY_USER` is set, a request is signed in exactly when `Remote-User` equals it. Unset, today's cookie mode is unchanged (used in development) | Authelia already authenticates every request, so a second app session only adds restarts-mean-logout friction |
| Trusting the header | Requires that nothing but the proxy can reach the port with a forged `Remote-User`. With the proxy on a shared Docker network (port not published), that holds. When the port is published (even on `127.0.0.1`, as `compose.yml` does for a host proxy), set the optional `AUTH_PROXY_SECRET`: the proxy then adds `X-Doc-Scanner-Proxy-Secret`, compared in constant time. The proxy must also overwrite or strip any client-supplied `Remote-User` on every route, including Authelia `bypass` rules | Anyone who reaches the port directly could send `Remote-User` |
| Cross-site requests | In header mode, `POST`/`PUT`/`DELETE` require `Sec-Fetch-Site: same-origin`, or the header absent (non-browser clients) → else 403 `cross_site` | Today the app's `SameSite=Strict` cookie stops cross-site requests. Authelia's cookie is usually `Lax`, so this restores the protection explicitly |
| Unlock secret | The passkey's **WebAuthn PRF** output (32 bytes per credential and salt), used as key material to wrap the mailbox passphrase on the server | The output can only be produced by the user's authenticator after user verification. The server never stores it |
| Signature verification | None: no `@simplewebauthn/server`, no challenges | The PRF output is a 256-bit secret, and the GCM tag proves it is right. Anyone holding it and the database can decrypt either way, so assertion checks add little behind Authelia |
| Storage of the wrapped passphrase | Two layers: inner AES-GCM under `HKDF(prf, salt)`, outer `AtRestCipher(SESSION_ENCRYPTION_KEY, 'passkeys')` | The database alone reveals nothing. The database plus the env key still lacks the PRF output |
| Several passkeys | Allowed (for example Apple Passwords and 1Password). Each wraps the same passphrase independently | The guidance is to enrol two unlock methods. The Proton password login stays as the always-available fallback |
| Platform support | iOS 18.4+ iCloud Keychain passkeys (PRF since iOS 18; 18.4 fixed data-loss bugs). 1Password on iOS is reported to work. A passkey without PRF is refused at enrolment with a clear message | Confirmed from current sources; see References |
| Proton password changed | Detected two ways: (1) at unlock, the unwrapped passphrase fails to decrypt the **user** key; (2) at a password login, the stored key-salt fingerprint (see §2) no longer matches. Either way: delete every wrap and, when live, prompt re-enrolment. A user-key rotation without a password change also changes the salt and drops the passkeys; harmless (re-enrol) | Every wrap holds the old passphrase; catching it at login avoids a surprise at the next restart |
| Re-login in header mode | Never calls logout: a Proton login simply replaces the `PROXY_SID` live session and the stored tokens. Logging in as a **different** Proton account (compared by Proton `User.ID`, not the typed email, which can differ in case or form) first clears the entities and event-id caches (`DriveClient.clearCaches()` on the new client, before it is registered), the folder cache (a new `FolderCacheStore.clear()`, reached through a `clearAccountData` callback the pipeline gives the auth routes) and all passkeys | Today's "Sign in again" calls logout first, which would now destroy the passkeys |
| Concurrency | Unlock and login share one in-process **mutex**: calls queue, and each re-checks state when its turn comes (an unlock that finds `'live'` answers 200 without touching Proton). No call ever receives another call's result | Two concurrent refreshes with one refresh token make Proton reject the second, which would clear the stored session; sharing a result across operations could turn a wrong password into a success |
| Logout | Also deletes every passkey wrap. In header mode it requires the matching `Remote-User` (it is unguarded today) | "Sign out" means "forget my Proton access here" |
| Passkeys in cookie mode | Not offered: enrolment, listing and unlock routes are header-mode only (404 in cookie mode), and status reports `unlockAvailable: false` so the PWA hides passkey UI | Unlock is header-mode only, so a cookie-mode passkey could never be used |

## Architecture

### 1. Sign-in modes (server)

**Config** (`server/src/config.ts`), both through `blankToUndefined` (Compose passes unset vars as `''`):

- `AUTH_PROXY_USER`, optional. Setting it turns on header mode.
- `AUTH_PROXY_SECRET`, optional, at least 32 characters. Setting it without `AUTH_PROXY_USER` fails startup (it would otherwise silently do nothing).

`compose.yml` gains `AUTH_PROXY_USER: ${AUTH_PROXY_USER:-}` and `AUTH_PROXY_SECRET: ${AUTH_PROXY_SECRET:-}`, with a comment explaining when the secret is needed.

**Middleware** (`http/middleware.ts`): `sessionMiddleware` takes the mode.

- **Header mode:**
  - When `Remote-User === AUTH_PROXY_USER` (and, if `AUTH_PROXY_SECRET` is set, `X-Doc-Scanner-Proxy-Secret` matches it: compare the SHA-256 digests of both with `timingSafeEqual`, which needs equal lengths), set `auth = { email, sid: PROXY_SID, liveSession: getLiveSession(PROXY_SID) }`.
    - `email` is the stored Proton session's email if there is one, else `Remote-Email`, else the user.
    - `PROXY_SID` is a constant such as `'proxy'`.
  - Otherwise leave `auth` unset, so guarded routes answer 401 as they do today.
  - No cookie is read or issued.
  - Also check `Sec-Fetch-Site` on `POST`/`PUT`/`DELETE`, as in the Decisions table.
- **Cookie mode:** unchanged.

**Login** (`POST /api/auth/login`):
- In header mode it runs the same Proton login. It registers the live session under `PROXY_SID` and issues no cookie.
- The work that builds the `DriveClient` and registers the live session moves into a shared `startLiveSession({ session, mailboxSecret, decryptedKeys, sid })` helper. `/login` and `/unlock` both use it. It keeps `onSessionRefreshed` persisting rotated tokens.
- In cookie mode, login stays reachable without `auth`, as it is today. In header mode, login requires header auth (401 `not_authenticated` otherwise), so nothing can start a Proton session around Authelia.
- Login takes the shared mutex with unlock (Decisions). In header mode it never logs out first. If the stored Proton `User.ID` (`app_settings` `proton.user_id`) differs from the new login's, it clears the caches and all passkeys as the Decisions table describes, before registering the new session; it then stores the new `User.ID`. A missing stored `User.ID` (the first login after this ships) counts as unknown: nothing is cleared.
- After a successful password login, it compares the stored key-salt fingerprint (§2) with the login's; on a mismatch it removes every passkey wrap and, only if at least one was removed, records that so Settings can say why once.
- **Where the values come from:** `fetchAndDecryptUserKey` returns the user's `User.ID` alongside the keys, and `ProtonAuth.login` and `ProtonAuth.resume` both return `keySaltFingerprint` (SHA-256 of the primary user key's `KeySalt`; `resume` calls `getKeySalts` too, since it has no password step). `LiveSession` keeps `userId` and `keySaltFingerprint`, so enrolment can write the fingerprint whichever way the session started.

**Status** (`GET /api/auth/status`) returns `{ email, proton, passkeys, unlockAvailable }`, where `passkeys` is a count, `unlockAvailable` is true in header mode only, and `proton` is one of:
- `'live'`: a live session with decrypted keys exists.
- `'locked'`: Proton tokens are stored, but there is no live session.
- `'none'`: no stored session.

It answers 401 as today when `auth` is missing. In cookie mode an authenticated request always has `proton: 'live'` (cookie mode only authenticates sids that logged in during this process).

**Logout** clears the stored session, disposes every live session and deletes every `passkey_unlocks` row. In header mode it requires header auth. In cookie mode it also deletes the cookie, and stays reachable without `auth` as today.

**Guards:** `/api/passkeys/*` and `/api/auth/unlock*` require header auth and answer 404 in cookie mode.

**What needs keys:** documents, folders and settings routes only need `auth`, so the inbox works while `'locked'`. Drive routes and filing keep their existing live-session requirement. Approved documents wait in `awaiting_login`.

**Resuming work:** neither login nor unlock touches the repo or worker directly. `startLiveSession` calls `registerLiveSession`, whose `onLiveSessionRegistered` listeners already run `worker.onLogin()` (`pipeline.ts`): that resumes `awaiting_login`, refreshes the folder cache, makes deferred `received` work due, and wakes the worker. Unlock gets the same behaviour for free.

### 2. Passkey unlock (server)

**Data** (migration `009_passkey_unlocks.sql`):

```sql
-- Passkeys that can unlock the Proton keys after a restart
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

The key-salt fingerprint lives in `app_settings` under `passkeys.key_salt_fingerprint`: SHA-256 of the primary user key's `KeySalt` (not secret; the salt is public to the account), written whenever a passkey is enrolled. A password login compares it (§1).

**`server/src/auth/passkey-store.ts`** owns the wrap and unwrap.
- `inner = AES-256-GCM(key = HKDF-SHA256(ikm = prf, salt = salt, info = "docscanner-passkey-unlock", 32 bytes), plaintext = passphrase bytes, aad = credentialId)`
- `wrapped = AtRestCipher('passkeys').seal(inner, aad = credentialId)`
- `label` is sealed with the same cipher, with `aad = credentialId + "\0label"`.
- Its methods are `add`, `list` (labels opened), `remove`, `removeAll`, `saltsFor()`, `unwrap(credentialId, prf) → Uint8Array | 'unknown' | 'wrong_secret' | 'unreadable'`, and `touch(credentialId)`. `'unreadable'` is an outer-layer failure (env key changed, corrupt row): the row is removed and logged as such, distinct from a wrong PRF output.
- Credential ids are `PublicKeyCredential.id` values: base64url, validated against `^[A-Za-z0-9_-]{16,256}$` at enrolment (they are a primary key, associated data and a URL segment). Salts and PRF outputs travel as base64url too.
- `AtRestPurpose` (`crypto/at-rest.ts`) gains `'passkeys'`.
- It never logs or returns the PRF output or the passphrase.

**Enrolment** needs `proton: 'live'`, otherwise 409 `proton_not_live`.

1. `POST /api/passkeys/begin`:
   - Returns:
     - `salt`: 32 random bytes, base64url
     - `userHandle`: a stable 16-byte value stored in `app_settings` under `passkeys.user_handle`, base64url
     - `excludeCredentials`: the existing credential ids
   - The server keeps the salt in a pending map for 5 minutes, keyed by the salt itself.
2. The PWA calls `navigator.credentials.create` with:
   - `rp: { name: 'Doc Scanner' }` (the RP ID defaults to the page host)
   - `user: { id: userHandle, name: email, displayName: email }`
   - `authenticatorSelection: { residentKey: 'required', userVerification: 'required' }`
   - `extensions: { prf: { eval: { first: salt } } }`

   When the result has no `prf.results.first`, the PWA needs a `get` with `allowCredentials: [that id]` and `prf.eval.first = salt`. Safari may refuse a second WebAuthn call without a fresh user gesture, so the PWA tries it at once and, if that throws `NotAllowedError`, shows a **Finish setup** button that runs the `get` on tap. If the `get` returns no PRF result either, the PWA reports `prf_unsupported` and makes no server call.

A credential the authenticator already holds (excluded) throws `InvalidStateError`: the PWA says "This passkey is already added." A passkey that was created but never stored on the server (no PRF, an expired or restarted enrolment) is left in the password manager; the PWA calls `PublicKeyCredential.signalUnknownCredential` where available so the manager can hide it, and otherwise tells the user it can be deleted there.
3. `POST /api/passkeys` with body `{ credentialId, salt, prf, label }`:
   - The server checks that the salt is pending, unexpired and unused. If not: 400 `invalid_enrolment`.
   - It checks that `prf` decodes to 32 bytes. If not: 400 `invalid_input`.
   - It trims and caps the label at 60 characters (an empty label becomes "Passkey").
   - It wraps the live session's passphrase (`mailboxSecret.use`), inserts the row, consumes the salt, writes the live session's `keySaltFingerprint`, and answers 201 with the listed passkey.
   - A server restart between begin and this call loses the pending salt: 400 `invalid_enrolment`, and the PWA says "Setup expired. Try again."
4. `GET /api/passkeys` returns `[{ credentialId, label, createdAt, lastUsedAt }]`.
5. `DELETE /api/passkeys/:credentialId` answers 204, or 404.

**Unlock** (header mode only; in cookie mode these routes answer 404).

1. `POST /api/auth/unlock/begin` returns `{ credentials: [{ credentialId, salt }] }`, or 409 `no_passkeys`.
2. The PWA calls `navigator.credentials.get` once, with:
   - `allowCredentials` listing them
   - `userVerification: 'required'`
   - `extensions: { prf: { evalByCredential: { [credentialId]: { first: salt } } } }`
3. `POST /api/auth/unlock` with body `{ credentialId, prf }` (takes the shared mutex with login, then re-checks state):
   - If `proton` is already `'live'`: 200 with the status (idempotent).
   - If there is no stored Proton session: 409 `proton_login_required`.
   - `unwrap`:
     - `'unknown'`: 404 `unknown_passkey`.
     - `'wrong_secret'`: 401 `unlock_failed`.
     - `'unreadable'`: 409 `passkey_unreadable` (the row is removed; the PWA says "That passkey can no longer unlock. Remove it and add it again." rather than blaming a password change).
   - With the passphrase bytes, call a new **`ProtonAuth.resume(session, passphraseBytes, { onRefreshed }) → { session, decryptedKeys, userId, keySaltFingerprint }`** (`auth/srp.ts`; it owns the private `ProtonApi`, so the routes never need it):
     1. Run `fetchAndDecryptUserKey` with the stored tokens.
     2. On a `ProtonApiError` 401, refresh the session through `refresh()` and retry once. `resume` calls `onRefreshed(newSession)` **the moment the refresh succeeds**, before the retry; the route's callback saves it to the session store. So rotated tokens are kept even if the retry then fails (5xx, 429, `KeyDecryptError`). On success the refreshed session is also returned and handed to `startLiveSession`.
     3. Errors map as follows:
        - `refresh()` rejected with `ProtonApiError` 400, 401 or 422 (Proton ended the session): clear the stored session, keep the passkeys, 409 `proton_login_required`.
        - A network error, 429 or 5xx (from `getUser` or `refresh`): change nothing, 503 `proton_unavailable` (retryable).
        - `KeyDecryptError` with reason `user_key` (the passphrase no longer opens the primary user key): `removeAll()` the passkeys, 409 `passkeys_stale`. `KeyDecryptError` gains a `reason` field (`user_key`, `no_keys`, `no_addresses`, `address_key`) so only a passphrase mismatch removes the passkeys ("No decryptable user keys", every user key inactive, is `no_keys`); the other reasons answer 500 and change nothing.
   - On success:
     - wrap the bytes in a `MailboxSecret` (it takes ownership; nothing else zeroes them, and zeroing is best-effort since key decryption builds a string, as login does today)
     - `startLiveSession` under `PROXY_SID`, which triggers the resume of waiting work (§1)
     - `touch` the passkey
     - answer 200 with the status

**Logging:** credential ids (first 8 characters), outcomes and error type names only. Never the label, the PRF output, the salt or the passphrase. Full credential ids may appear in proxy access logs and PWA breadcrumbs via `DELETE /api/passkeys/:id`; they are not secret. Sentry already drops request bodies and headers.

### 3. PWA

**`App.tsx`** routes on `GET /api/auth/status`, and gains a **"sign in to Proton"** route: `LoginScreen` shown over a signed-in app (with **Cancel** back to the inbox) whenever the user chooses to sign in to Proton while `'live'` or `'locked'`. In header mode, `signInAgain` opens that route and **never calls logout**. In cookie mode it behaves as today.

The routes (only the 401 case can't tell the modes apart; everywhere else `unlockAvailable` does, and `signInAgain` branches on it):
- **401:** cookie mode shows today's `LoginScreen`. In header mode, a 401 means a misconfigured proxy; the PWA can't tell the modes apart, so it shows `LoginScreen` as today, and a Proton login in that state still fails with 401 and shows the error.
- **`proton: 'none'`:** `LoginScreen` (Proton password and 2FA).
- **`'live'` or `'locked'`:** the inbox.

App keeps `{ email, proton, passkeys }` in state and refreshes it after login, unlock, enrolment and removal.

**Locked banner** (`InboxScreen`) is shown whenever `proton === 'locked'`. It replaces today's "Sign in again" banner while it is shown. Today's banner stays for `'live'` with documents in `awaiting_login` (dead tokens inside a live session), and its button opens the sign-in route above.
- **With passkeys:** "Filing is paused until you unlock." with an **Unlock** button. The button is tapped, never auto-triggered, because iOS needs a user gesture. On success the status is refreshed.
- **No passkeys, or after `proton_login_required`:** "Filing is paused. Sign in to Proton to resume." with **Sign in to Proton**, which shows `LoginScreen`.
- **After `passkeys_stale`:** "Your Proton password changed. Sign in again, then add your passkey again in Settings."
- **After `passkey_unreadable`:** "That passkey can no longer unlock. Sign in to Proton, then remove it and add it again in Settings."
- **After `unlock_failed` or a cancelled ceremony:** "Couldn’t unlock. Try again." The button stays.
- **After `proton_unavailable`:** "Proton isn’t reachable right now. Try again in a moment." The button stays.

**Nudge:** when `unlockAvailable`, after a successful Proton login with `passkeys === 0`, the inbox shows a dismissible hint: "Add a passkey so a server restart doesn’t need your Proton password." The hint has an **Add passkey** button, and the dismissal is stored in localStorage.

**Settings → Passkeys** (shown only when `unlockAvailable`):
- A list of label, added date and last-used date, each with **Remove**.
- **Add passkey**, shown only while `'live'`:
  - Asks for a label, defaulting to "Passkey".
  - Runs enrolment.
  - On `prf_unsupported`: "This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password."
- **Sign out** now says it also removes passkey unlocks.
- After passkeys are removed because a login detected a changed Proton password, Settings shows "Your passkeys were removed because your Proton password changed. Add one again." once.

**`pwa/src/auth/passkeys.ts`** wraps `navigator.credentials` in two functions, `enrolPasskey(begin) → { credentialId, prf }` and `unlockWithPasskey(credentials) → { credentialId, prf }`. It also handles base64url conversion and PRF result extraction (including the follow-up `get` at enrolment), and maps `NotAllowedError` (cancelled) to a typed `cancelled` result. Components never touch raw WebAuthn.

**API client:** `api.ts` gains `status()` (now typed with `proton`, `passkeys` and `unlockAvailable`), `passkeys.begin`, `passkeys.add`, `passkeys.list`, `passkeys.remove`, `unlock.begin` and `unlock`.

### 4. Security summary

| Threat | Outcome |
|---|---|
| Database stolen | Tokens and passphrase sealed; nothing decryptable |
| Database plus `SESSION_ENCRYPTION_KEY` | Proton API tokens (as today). The passphrase, which unlocks every Proton key (Mail as well as Drive), still needs a PRF output |
| Request forging `Remote-User` | Only possible around the proxy: closed by not publishing the port, or by `AUTH_PROXY_SECRET` when it is published |
| Cross-site request | Blocked by `Sec-Fetch-Site` |
| Leaked PRF output | With the database and env key: the passphrase. Through Authelia: an unlock. Equivalent to a leaked password; remove the passkey (salt rotation per unlock is a possible later hardening, not in scope) |
| Brute-forcing unlock | 2^256 space; no rate limit needed |
| Signature verification skipped | WebAuthn client-extension outputs are not signed, so even full assertion verification could not stop script on the page from planting a PRF value; the GCM tag is the real check |
| Passphrase in memory | Same lifetime as today: from login or unlock until a restart or logout |

## Testing

**Server (vitest):**
- **Config:** blank `AUTH_PROXY_USER`/`AUTH_PROXY_SECRET` mean unset; a short secret fails startup.
- **Middleware, header mode:**
  - the right user, a wrong user and a missing header
  - with `AUTH_PROXY_SECRET`: a missing or wrong secret header gives 401
  - `Sec-Fetch-Site` for `same-origin`, `cross-site`, `same-site` and an absent header, on `GET` and `POST`
  - cookie mode unchanged
- **Status:** `live`, `locked` and `none`, with the passkey count.
- **`startLiveSession`:** used by both login and unlock (the existing login tests still pass).
- **`passkey-store`:**
  - the round trip
  - a wrong PRF output gives `wrong_secret`
  - an unknown id gives `unknown`
  - the label is sealed, and the raw row holds no plaintext passphrase or label
  - `removeAll`
- **Enrolment:**
  - not live: 409
  - unknown, expired or reused salt: 400
  - a bad `prf` length: 400
  - the happy path wraps the live passphrase, and an unlock with the same `prf` gets it back
- **Unlock, against a fake `ProtonApi`/`ProtonAuth`:**
  - already live
  - no stored session
  - unknown passkey
  - wrong secret
  - expired access token refreshed then success
  - refresh rejected: the session is cleared and passkeys kept
  - `KeyDecryptError`: all passkeys removed
  - success resumes `awaiting_login` documents
  - the routes are 404 in cookie mode
  - transient failure (network, 5xx, 429): 503 `proton_unavailable`, nothing cleared
  - a refreshed session is saved through `onRefreshed` before the retry, and stays saved when the retry then fails with 503
  - two concurrent unlocks call `refresh` once (the second finds `'live'`)
  - a login queued behind an unlock gets its own result (a wrong password still fails)
  - `'unreadable'` answers `passkey_unreadable` and removes that row only
  - `KeyDecryptError` reasons other than `user_key` remove nothing
  - the resume of `awaiting_login` happens through the live-session listener
- **Logout** removes the passkeys, and needs header auth in header mode.
- **Login in header mode:** does not log out; a different Proton `User.ID` clears entities, event ids, the folder cache and passkeys (an email differing only in case does not); a changed key-salt fingerprint removes passkeys.
- **Config:** `AUTH_PROXY_SECRET` without `AUTH_PROXY_USER` fails startup; a secret header of a different length is rejected without throwing.
- **Enrolment:** credential-id validation; restart between begin and add gives `invalid_enrolment`.
- **Logs** never contain the PRF output, the label or the passphrase.
- **Migration 009** applies.

**PWA (happy-dom):**
- `App` routing on each status.
- **The locked banner:**
  - the passkey and no-passkey variants
  - `unlock_failed`, cancelled, `proton_login_required` and `passkeys_stale`
- **Settings → Passkeys:** list, add, `prf_unsupported`, already added, expired setup, **Finish setup** after a refused follow-up `get`, remove; hidden when `!unlockAvailable`.
- **Sign in to Proton** route: opened from the banners, Cancel returns to the inbox, never calls logout in header mode.
- **The nudge:** shown, dismissed and remembered.
- **`passkeys.ts`:**
  - against a mocked `navigator.credentials`, including the enrolment follow-up `get`
  - `evalByCredential`
  - cancellation

**Manual (the user):** in production with header mode on:
1. Enrol an iCloud Keychain passkey.
2. Restart the container.
3. Open the PWA and tap **Unlock**.
4. Confirm that Face ID alone resumes filing.
5. Change nothing else.

Optionally enrol a 1Password passkey as well and unlock with it.

## Deployment

To deploy:
1. Set `AUTH_PROXY_USER` to the Authelia username in the production environment.
2. Either keep the container port unpublished (proxy and app on a shared Docker network), or, if the port is published (including the `127.0.0.1:3000` in `compose.yml`), set `AUTH_PROXY_SECRET` and configure the proxy to send it as `X-Doc-Scanner-Proxy-Secret` on every forwarded request.
3. Make sure the proxy overwrites or strips any client-supplied `Remote-User` on every route to the app, including Authelia `bypass` rules.

**Docs:** update the parent spec's Trust boundary bullet (a restart no longer forces a full Proton login in header mode; it needs a passkey unlock), `CLAUDE.md`'s environment list (`AUTH_PROXY_USER`, `AUTH_PROXY_SECRET`) and the README's deployment notes.

## References

- [Corbado: Passkeys & WebAuthn PRF for End-to-End Encryption (2026)](https://www.corbado.com/blog/passkeys-prf-webauthn)
- [Yubico: Developer's Guide to PRF](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html)
- [Apple Developer Forums: PRF in Safari's cross-device flow](https://developer.apple.com/forums/thread/774112)
- [1Password: encrypting data with saved passkeys](https://1password.com/blog/encrypt-data-saved-passkeys)
