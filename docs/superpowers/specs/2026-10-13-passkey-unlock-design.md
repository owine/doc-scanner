# Passkey Unlock and Proxy Sign-in: Design Spec

**Date:** 2026-10-13
**Status:** Approved design; planned in [`2026-10-13-passkey-unlock.md`](../plans/2026-10-13-passkey-unlock.md)
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
| Cross-site requests | In header mode, `POST`/`PUT`/`PATCH`/`DELETE` require `Sec-Fetch-Site: same-origin`, or the header absent (non-browser clients) → else 403 `cross_site` | Today the app's `SameSite=Strict` cookie stops cross-site requests. Authelia's cookie is usually `Lax`, so this restores the protection explicitly |
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
  - Also check `Sec-Fetch-Site` on `POST`/`PUT`/`PATCH`/`DELETE`, as in the Decisions table.
- **Cookie mode:** unchanged.

**Login** (`POST /api/auth/login`):
- In header mode it runs the same Proton login. It registers the live session under `PROXY_SID` and issues no cookie.
- The work that builds the `DriveClient` and registers the live session moves into a shared `startLiveSession({ session, mailboxSecret, decryptedKeys, sid })` helper. `/login` and `/unlock` both use it. It keeps `onSessionRefreshed` persisting rotated tokens.
- In cookie mode, login stays reachable without `auth`, as it is today, and the sid joins the signed-in set and its cookie is issued only after the live session has started, so a failed start leaves no cookie without a session. In header mode, login requires header auth (401 `not_authenticated` otherwise), so nothing can start a Proton session around Authelia.
- Login takes the shared mutex with unlock (Decisions). In header mode it never logs out first. If the stored Proton `User.ID` (`app_settings` `proton.user_id`) differs from the new login's, it first forgets the old live session (before the new tokens are stored, so a failure part-way can't leave one account's keys beside another's tokens), then clears the caches and all passkeys as the Decisions table describes. It writes the new `User.ID` after the clearing and before the new session goes live: a failure before the write leaves the old id, so the next login clears again, and a failed write never leaves this account live under the old id. A missing stored `User.ID` (the first login after this ships) counts as unknown: nothing is cleared. Documents already decided against the previous account's folders are not migrated: they fail under the new account and need review.
- After a successful password login, it compares the stored key-salt fingerprint (§2) with the login's; on a mismatch it removes every passkey wrap and, only if at least one was removed, records that so Settings can say why once.
- **Where the values come from:** `fetchAndDecryptUserKey` returns the user's `User.ID` alongside the keys, and `ProtonAuth.login` returns `keySaltFingerprint` (SHA-256 of the primary user key's `KeySalt`). `ProtonAuth.resume` doesn't fetch the salts: a successful unlock proves the passphrase, and so the KeySalt, unchanged since enrolment, and while any passkey exists the stored `passkeys.key_salt_fingerprint` is current. So the unlock carries the stored value into the session. `LiveSession` keeps `userId` and `keySaltFingerprint` (null if none is stored), and enrolment writes the fingerprint when the session knows it.

**Status** (`GET /api/auth/status`) returns `{ email, proton, passkeys, unlockAvailable }`, where `passkeys` is a count, `unlockAvailable` is true in header mode only, and `proton` is one of:
- `'live'`: a live session with decrypted keys exists.
- `'locked'`: Proton tokens are stored, but there is no live session.
- `'none'`: no stored session.

It answers 401 as today when `auth` is missing. In cookie mode an authenticated request always has `proton: 'live'` (cookie mode only authenticates sids that logged in during this process).

**Logout** takes the mutex, forgets every live session (disposing it), clears the stored session, deletes every `passkey_unlocks` row, and only then clears the SDK caches, with the client that was live when its turn came: once the sessions are forgotten, no client (the worker's included) can write to the caches being cleared. In header mode it requires header auth. In cookie mode it also deletes the cookie, and stays reachable without `auth` as today.

**Guards:** `/api/passkeys/*` and `/api/auth/unlock*` require header auth and answer 404 in cookie mode. Request bodies to `/api/auth/*` and `/api/passkeys/*` are limited to 16 KiB (413 `payload_too_large`); theirs are a few hundred bytes.

**What needs keys:** documents, folders and settings routes only need `auth`, so the inbox works while `'locked'`. Drive routes and filing keep their existing live-session requirement. Approved documents wait in `awaiting_login`.

**Resuming work:** neither login nor unlock touches the repo or worker directly. `startLiveSession` calls `registerLiveSession`, whose `onLiveSessionRegistered` listeners already run `worker.onLogin()` (`pipeline.ts`): that resumes `awaiting_login`, refreshes the folder cache, makes deferred `received` work due, and wakes the worker. Unlock gets the same behaviour for free.

**Replaced clients:** the worker can hold a `DriveClient` through a long job after a login replaced its session or a logout forgot it. Only the registered live client speaks for the stored session: a replaced or forgotten client's token refreshes are not saved (they would overwrite the newer login's tokens, or undo a logout), and its entities cache neither reads nor writes (clearing is never refused), since that table is shared by every account. A folder walk saves its tree only while the live session that started it is still live, and a new session never joins an older session's walk.

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
- Its methods are `add` (which throws unless the PRF output and the salt are 32 bytes and the credential id matches the pattern below: HKDF accepts an empty key, which would leave a wrap sealed by the public salt alone), `has`, `list` (labels opened), `remove`, `removeAll`, `saltsFor()`, `unwrap(credentialId, prf) → Uint8Array | 'unknown' | 'wrong_secret' | 'unreadable'`, and `touch(credentialId)`. `'unreadable'` is an outer-layer failure (env key changed, corrupt row): the row is removed and logged as such, distinct from a wrong PRF output.
- Credential ids are `PublicKeyCredential.id` values: base64url, validated against `^[A-Za-z0-9_-]{16,256}$` at enrolment (they are a primary key, associated data and a URL segment). Salts and PRF outputs travel as base64url too.
- `AtRestPurpose` (`crypto/at-rest.ts`) gains `'passkeys'`.
- It never logs or returns the PRF output or the passphrase.

**Enrolment** needs `proton: 'live'`, otherwise 409 `proton_not_live`.

1. `POST /api/passkeys/begin`:
   - Returns:
     - `salt`: 32 random bytes, base64url
     - `userHandle`: a stable 16-byte value stored in `app_settings` under `passkeys.user_handle`, base64url
     - `excludeCredentials`: the existing credential ids
   - The server keeps the salt in a pending map for 5 minutes, keyed by the salt itself. The map holds at most 16 salts; a new one evicts the oldest.
2. The PWA calls `navigator.credentials.create` with:
   - `rp: { name: 'Doc Scanner' }` (the RP ID defaults to the page host)
   - `user: { id: userHandle, name: email, displayName: email }`
   - `authenticatorSelection: { residentKey: 'required', userVerification: 'required' }`
   - `extensions: { prf: { eval: { first: salt } } }`

   When the result reports `prf.enabled === false`, the authenticator has no PRF: the PWA reports `prf_unsupported` at once, with no second prompt. Otherwise, when the result has no `prf.results.first`, the PWA needs a `get` with `allowCredentials: [that id]` and `prf.eval.first = salt`. Safari may refuse a second WebAuthn call without a fresh user gesture, so the PWA tries it at once and, if that throws `NotAllowedError`, shows a **Finish setup** button that runs the `get` on tap. If the `get` returns no PRF result either, the PWA reports `prf_unsupported` and makes no server call.

A credential the authenticator already holds (excluded) throws `InvalidStateError`: the PWA says "This passkey is already added." A passkey that was created but never stored on the server (no PRF, an expired or restarted enrolment, any other refusal by the server, or a setup abandoned at **Finish setup**) is left in the password manager; the PWA calls `PublicKeyCredential.signalUnknownCredential` where available so the manager can hide it, and otherwise tells the user it can be deleted there. Only a refusal, a 4xx carrying the server's error code, counts as never stored. No answer, a 5xx, or an answer without a code (a proxy's HTML 502) may have come after the server stored the passkey, so the PWA keeps it and signals nothing.
3. `POST /api/passkeys` with body `{ credentialId, salt, prf, label }`:
   - If the session ended (a logout, or another login) while the body was being read: 409 `proton_not_live`, since the passphrase that session held is already disposed.
   - The server checks that the salt is pending, unexpired and unused. If not: 400 `invalid_enrolment`.
   - It checks that `prf` decodes to 32 bytes. If not: 400 `invalid_input`.
   - A credential id that is already stored: 409 `already_enrolled`, and its wrap is kept (`excludeCredentials` normally stops this; storing it again would silently replace the first wrap).
   - It trims and caps the label at 60 characters (an empty label becomes "Passkey").
   - It wraps the live session's passphrase (`mailboxSecret.use`), inserts the row, consumes the salt, writes the live session's `keySaltFingerprint`, and answers 201 with the listed passkey. The decoded PRF output is zeroed once it is used, whether or not the wrap succeeded (and on `already_enrolled`).
   - A server restart between begin and this call loses the pending salt: 400 `invalid_enrolment`, and the PWA says "Setup expired. Try again."
4. `GET /api/passkeys` returns `{ passkeys: [{ credentialId, label, createdAt, lastUsedAt }], notice }`. `notice` is `'password_changed'` on the first read after a login removed the passkeys for a changed password (the read clears it), else `null`: that is how Settings says why, once.
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
     - `'unreadable'`: 409 `passkey_unreadable` (the row is removed; the PWA says "That passkey can no longer unlock. Sign in to Proton, then add a passkey again in Settings." rather than blaming a password change).
   - With the passphrase bytes, call a new **`ProtonAuth.resume(session, passphraseBytes, { onRefreshed }) → { session, decryptedKeys, userId }`** (`auth/srp.ts`; it owns the private `ProtonApi`, so the routes never need it):
     1. Run `fetchAndDecryptUserKey` with the stored tokens.
     2. On a `ProtonApiError` 401, refresh the session through `refresh()` and retry once. `resume` calls `onRefreshed(newSession)` **the moment the refresh succeeds**, before the retry; the route's callback saves it to the session store. So rotated tokens are kept even if the retry then fails (5xx, 429, `KeyDecryptError`). On success the refreshed session is also returned and handed to `startLiveSession`.
     3. Errors map as follows:
        - `refresh()` rejected with `ProtonApiError` 400, 401 or 422 (Proton ended the session): clear the stored session, keep the passkeys, 409 `proton_login_required`.
        - A network error, 429 or 5xx (from `getUser` or `refresh`): change nothing, 503 `proton_unavailable` (retryable). A network error is undici's `TypeError('fetch failed')` (or a `TypeError` with a `cause`), or a timeout: every Proton request gives up after 30 seconds, so a hung call can't hold the mutex. Any other `TypeError` is a bug, reported, and answers 500.
        - `KeyDecryptError` with reason `user_key` (an active user key parsed, but the passphrase no longer decrypts it): `removeAll()` the passkeys, 409 `passkeys_stale`. `KeyDecryptError` gains a `reason` field (`user_key`, `key_unreadable`, `no_keys`, `no_addresses`, `address_key`) so only a passphrase mismatch removes the passkeys (`key_unreadable` is a user key that won't parse; "No decryptable user keys", every user key inactive, is `no_keys`); the other reasons answer 500 and change nothing.
   - On success:
     - wrap the bytes in a `MailboxSecret` (it takes ownership; nothing else zeroes them, and zeroing is best-effort since key decryption builds a string, as login does today)
     - `startLiveSession` under `PROXY_SID`, which triggers the resume of waiting work (§1)
     - `touch` the passkey
     - answer 200 with the status
   - Whatever the outcome, the decoded PRF output is zeroed when the call's turn ends.

**Logging:** credential ids (first 8 characters), outcomes and error type names only. Never the label, the PRF output, the salt or the passphrase. Full credential ids may appear in proxy access logs and PWA breadcrumbs via `DELETE /api/passkeys/:id`; they are not secret. Sentry already drops request bodies and headers.

### 3. PWA

**`App.tsx`** routes on `GET /api/auth/status`, and gains a **"sign in to Proton"** route: `LoginScreen` shown over a signed-in app (with **Cancel** back to the inbox) whenever the user chooses to sign in to Proton while `'live'` or `'locked'`. In header mode, `signInAgain` opens that route and **never calls logout**. It logs out first, as today, only when the server has said it is in cookie mode (`unlockAvailable: false`). `unlockAvailable` stays unknown until a status read says so (a login answers before the status is read again), and an unknown mode never logs out, so a passkey is never removed on a guess.

The routes (only the 401 case can't tell the modes apart; everywhere else `unlockAvailable` does, and `signInAgain` branches on it):
- **401:** cookie mode shows today's `LoginScreen`. In header mode, a 401 means a misconfigured proxy; the PWA can't tell the modes apart, so it shows `LoginScreen` as today, and a Proton login in that state still fails with 401 and shows the error.
- **Any other failure of the first status read** (no answer, a 5xx): "Can't reach the server." with **Retry**, never the login screen.
- **`proton: 'none'`:** `LoginScreen` (Proton password and 2FA).
- **`'live'` or `'locked'`:** the inbox.

App keeps `{ email, proton, passkeys }` in state and refreshes it after login, unlock, enrolment and removal.

`LoginScreen` says each failure in words, never as a raw code: Proton didn't accept the email, password or code; check the email and password; a 2FA code is needed; this browser isn't signed in to the server (header mode without the proxy's user); can't reach the server; otherwise "Couldn't sign in. Try again."

Whenever the focused control disappears, focus moves to what replaced it: **Sign in to Proton** when it replaces **Unlock**, **Finish setup** or **Add passkey** in Settings (the section heading when neither is shown), and the inbox heading after **Cancel** on the sign-in route.

**Locked banner** (`InboxScreen`) is shown whenever `proton === 'locked'`. It replaces today's "Sign in again" banner while it is shown. Today's banner stays for `'live'` with documents in `awaiting_login` (dead tokens inside a live session), and its button opens the sign-in route above.
- **With passkeys:** "Filing is paused until you unlock." with an **Unlock** button. The button is tapped, never auto-triggered, because iOS needs a user gesture. On success the status is refreshed.
  - The banner fetches `unlock/begin` when it appears, and **Unlock** stays disabled until that first fetch settles; it fetches again after any failed unlock. If a fetch failed, the tap fetches for itself. Settings fetches `passkeys/begin` when **Add passkey** is tapped. So each passkey prompt starts straight from a tap, with no request in between.
  - After `proton_login_required`, `passkeys_stale` or `passkey_unreadable`, the app reads `GET /api/auth/status` again, so its Proton state and passkey count match the server's.
- **No passkeys, or after `proton_login_required`:** "Filing is paused. Sign in to Proton to resume." with **Sign in to Proton**, which shows `LoginScreen`.
- **After `passkeys_stale`:** "Your Proton password changed. Sign in again, then add your passkey again in Settings."
- **After `passkey_unreadable`:** "That passkey can no longer unlock. Sign in to Proton, then add a passkey again in Settings." (The server has already removed it.)
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

**`pwa/src/auth/passkeys.ts`** wraps `navigator.credentials` in two functions, `enrolPasskey(begin) → { credentialId, prf }` and `unlockWithPasskey(credentials) → { credentialId, prf }`. It also handles base64url conversion and PRF result extraction (including the follow-up `get` at enrolment), and maps `NotAllowedError` and `AbortError` (the user, the page or the browser stopped the prompt) to a typed `cancelled` result, `InvalidStateError` at creation to `already_added`, and any other named WebAuthn error to `webauthn_<name>`. Components never touch raw WebAuthn.

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
  - a credential id already stored: 409 `already_enrolled`, the wrap kept
  - the session ending while the body is read: 409 `proton_not_live`
  - at most 16 pending salts, the oldest evicted
  - a body over 16 KiB: 413
  - the decoded PRF output is zeroed after a success and a failure
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
  - `KeyDecryptError` reasons other than `user_key` remove nothing (`key_unreadable` included)
  - the resume of `awaiting_login` happens through the live-session listener
- **Logout** removes the passkeys, and needs header auth in header mode.
- **Replaced clients:** a replaced or forgotten client's refreshed tokens are not saved, its entities cache is inert, and a folder walk that outlives its session saves nothing.
- **Login in header mode:** does not log out; a different Proton `User.ID` clears entities, event ids, the folder cache and passkeys (an email differing only in case does not); a changed key-salt fingerprint removes passkeys.
- **Config:** `AUTH_PROXY_SECRET` without `AUTH_PROXY_USER` fails startup; a secret header of a different length is rejected without throwing.
- **Enrolment:** credential-id validation; restart between begin and add gives `invalid_enrolment`.
- **Logs** never contain the PRF output, the label or the passphrase.
- **Migration 009** applies.

**PWA (happy-dom):**
- `App` routing on each status; a non-401 failure of the first status read shows "Can't reach the server." with **Retry**; an unknown mode never logs out.
- **The locked banner:**
  - the passkey and no-passkey variants
  - `unlock_failed`, cancelled, `proton_login_required`, `passkeys_stale` and `passkey_unreadable`
  - **Unlock** disabled until the first salts arrive
- **Settings → Passkeys:** list, add, `prf_unsupported`, already added, expired setup, **Finish setup** after a refused follow-up `get`, remove; hidden when `!unlockAvailable`. An add that gets a 5xx or an answer without a code keeps the passkey; a 4xx with a code signals it as unknown.
- **Sign in to Proton** route: opened from the banners, Cancel returns to the inbox, never calls logout in header mode.
- **The nudge:** shown, dismissed and remembered.
- **`passkeys.ts`:**
  - against a mocked `navigator.credentials`, including the enrolment follow-up `get`
  - `evalByCredential`
  - cancellation (`NotAllowedError` and `AbortError`), `prf.enabled === false` with no second prompt, and `webauthn_<name>` for other errors

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
