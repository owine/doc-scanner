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
| Trusting the header | Safe only because the container port is reachable through the proxy alone (confirmed for production). Documented as a requirement of header mode | Anyone who reaches the port directly could send `Remote-User` |
| Cross-site requests | In header mode, `POST`/`PUT`/`DELETE` require `Sec-Fetch-Site: same-origin`, or the header absent (non-browser clients) → else 403 `cross_site` | Today the app's `SameSite=Strict` cookie stops cross-site requests. Authelia's cookie is usually `Lax`, so this restores the protection explicitly |
| Unlock secret | The passkey's **WebAuthn PRF** output (32 bytes per credential and salt), used as key material to wrap the mailbox passphrase on the server | The output can only be produced by the user's authenticator after user verification. The server never stores it |
| Signature verification | None: no `@simplewebauthn/server`, no challenges | The PRF output is a 256-bit secret, and the GCM tag proves it is right. Anyone holding it and the database can decrypt either way, so assertion checks add little behind Authelia |
| Storage of the wrapped passphrase | Two layers: inner AES-GCM under `HKDF(prf, salt)`, outer `AtRestCipher(SESSION_ENCRYPTION_KEY, 'passkeys')` | The database alone reveals nothing. The database plus the env key still lacks the PRF output |
| Several passkeys | Allowed (for example Apple Passwords and 1Password). Each wraps the same passphrase independently | The guidance is to enrol two unlock methods. The Proton password login stays as the always-available fallback |
| Platform support | iOS 18.4+ iCloud Keychain passkeys (PRF since iOS 18; 18.4 fixed data-loss bugs). 1Password on iOS is reported to work. A passkey without PRF is refused at enrolment with a clear message | Confirmed from current sources; see References |
| Proton password changed | Unwrapped passphrase fails to decrypt the keys → delete every wrap, ask for a login and re-enrolment | Every wrap holds the old passphrase |
| Logout | Also deletes every passkey wrap | "Sign out" means "forget my Proton access here" |

## Architecture

### 1. Sign-in modes (server)

**Config** (`server/src/config.ts`): `AUTH_PROXY_USER`, an optional non-empty string. Setting it turns on header mode.

**Middleware** (`http/middleware.ts`): `sessionMiddleware` takes the mode.

- **Header mode:**
  - When `Remote-User === AUTH_PROXY_USER`, set `auth = { email, sid: PROXY_SID, liveSession: getLiveSession(PROXY_SID) }`.
    - `email` is the stored Proton session's email if there is one, else `Remote-Email`, else the user.
    - `PROXY_SID` is a constant such as `'proxy'`.
  - Otherwise leave `auth` unset, so guarded routes answer 401 as they do today.
  - No cookie is read or issued.
  - Also check `Sec-Fetch-Site` on `POST`/`PUT`/`DELETE`, as in the Decisions table.
- **Cookie mode:** unchanged.

**Login** (`POST /api/auth/login`):
- In header mode it runs the same Proton login. It registers the live session under `PROXY_SID` and issues no cookie.
- The work that builds the `DriveClient` and registers the live session moves into a shared `startLiveSession({ session, mailboxSecret, decryptedKeys, sid })` helper. `/login` and `/unlock` both use it. It keeps `onSessionRefreshed` persisting rotated tokens.
- In cookie mode, login stays reachable without `auth`, as it is today. In header mode, login requires the matching `Remote-User` (401 `not_authenticated` otherwise), so nothing can start a Proton session around Authelia.

**Status** (`GET /api/auth/status`) returns `{ email, proton, passkeys }`, where `passkeys` is a count and `proton` is one of:
- `'live'`: a live session with decrypted keys exists.
- `'locked'`: Proton tokens are stored, but there is no live session.
- `'none'`: no stored session.

It answers 401 as today when `auth` is missing. In cookie mode an authenticated request always has `proton: 'live'` (cookie mode only authenticates sids that logged in during this process).

**Logout** clears the stored session, disposes every live session and deletes every `passkey_unlocks` row. In cookie mode it also deletes the cookie.

**What needs keys:** documents, folders and settings routes only need `auth`, so the inbox works while `'locked'`. Drive routes and filing keep their existing live-session requirement. Approved documents wait in `awaiting_login`.

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

**`server/src/auth/passkey-store.ts`** owns the wrap and unwrap.
- `inner = AES-256-GCM(key = HKDF-SHA256(ikm = prf, salt = salt, info = "docscanner-passkey-unlock", 32 bytes), plaintext = passphrase bytes, aad = credentialId)`
- `wrapped = AtRestCipher('passkeys').seal(inner, aad = credentialId)`
- `label` is sealed with the same cipher, with `aad = credentialId + "\0label"`.
- Its methods are `add`, `list` (labels opened), `remove`, `removeAll`, `saltsFor()`, `unwrap(credentialId, prf) → Uint8Array | 'unknown' | 'wrong_secret'`, and `touch(credentialId)`.
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

   When the result has no `prf.results.first`, it immediately calls `navigator.credentials.get` with `allowCredentials: [that id]` and `prf.eval.first = salt`. If neither returns a result, the PWA reports `prf_unsupported` and makes no server call.
3. `POST /api/passkeys` with body `{ credentialId, salt, prf, label }`:
   - The server checks that the salt is pending, unexpired and unused. If not: 400 `invalid_enrolment`.
   - It checks that `prf` decodes to 32 bytes. If not: 400 `invalid_input`.
   - It trims and caps the label at 60 characters (an empty label becomes "Passkey").
   - It wraps the live session's passphrase (`mailboxSecret.use`), inserts the row, consumes the salt, and answers 201 with the listed passkey.
4. `GET /api/passkeys` returns `[{ credentialId, label, createdAt, lastUsedAt }]`.
5. `DELETE /api/passkeys/:credentialId` answers 204, or 404.

**Unlock** (header mode only; in cookie mode these routes answer 404).

1. `POST /api/auth/unlock/begin` returns `{ credentials: [{ credentialId, salt }] }`, or 409 `no_passkeys`.
2. The PWA calls `navigator.credentials.get` once, with:
   - `allowCredentials` listing them
   - `userVerification: 'required'`
   - `extensions: { prf: { evalByCredential: { [credentialId]: { first: salt } } } }`
3. `POST /api/auth/unlock` with body `{ credentialId, prf }`:
   - If `proton` is already `'live'`: 200 with the status (idempotent).
   - If there is no stored Proton session: 409 `proton_login_required`.
   - `unwrap`:
     - `'unknown'`: 404 `unknown_passkey`.
     - `'wrong_secret'`: 401 `unlock_failed`.
   - With the passphrase bytes:
     1. Run `fetchAndDecryptUserKey` with the stored tokens. On a Proton 401, refresh through `protonAuth.refresh` and retry once.
        - If the refresh is rejected: clear the stored session, keep the passkeys, and answer 409 `proton_login_required`.
        - If key decryption fails (`KeyDecryptError`): `removeAll()` the passkeys and answer 409 `passkeys_stale`.
     2. Otherwise:
        - `startLiveSession` under `PROXY_SID`
        - `touch` the passkey
        - `repo.resumeAwaitingLogin()` and wake the worker, as login does
        - answer 200 with the status
   - The passphrase bytes are wrapped in a `MailboxSecret` straight away, and the copy is zeroed.

**Logging:** credential ids (first 8 characters), outcomes and error type names only. Never the label, the PRF output, the salt or the passphrase.

### 3. PWA

**`App.tsx`** routes on `GET /api/auth/status`:
- **401:** cookie mode shows today's `LoginScreen`. In header mode, a 401 means a misconfigured proxy; the PWA can't tell the modes apart, so it shows `LoginScreen` as today, and a Proton login in that state still fails with 401 and shows the error.
- **`proton: 'none'`:** `LoginScreen` (Proton password and 2FA).
- **`'live'` or `'locked'`:** the inbox.

App keeps `{ email, proton, passkeys }` in state and refreshes it after login, unlock, enrolment and removal.

**Locked banner** (`InboxScreen`) is shown whenever `proton === 'locked'`. It replaces today's "Sign in again" banner while it is shown.
- **With passkeys:** "Filing is paused until you unlock." with an **Unlock** button. The button is tapped, never auto-triggered, because iOS needs a user gesture. On success the status is refreshed.
- **No passkeys, or after `proton_login_required`:** "Filing is paused. Sign in to Proton to resume." with **Sign in to Proton**, which shows `LoginScreen`.
- **After `passkeys_stale`:** "Your Proton password changed. Sign in again, then add your passkey again in Settings."
- **After `unlock_failed` or a cancelled ceremony:** "Couldn’t unlock. Try again." The button stays.

**Nudge:** after a successful Proton login with `passkeys === 0`, the inbox shows a dismissible hint: "Add a passkey so a server restart doesn’t need your Proton password." The hint has an **Add passkey** button, and the dismissal is stored in localStorage.

**Settings → Passkeys:**
- A list of label, added date and last-used date, each with **Remove**.
- **Add passkey**, shown only while `'live'`:
  - Asks for a label, defaulting to "Passkey".
  - Runs enrolment.
  - On `prf_unsupported`: "This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password."
- **Sign out** now says it also removes passkey unlocks.

**`pwa/src/auth/passkeys.ts`** wraps `navigator.credentials` in two functions, `enrolPasskey(begin) → { credentialId, prf }` and `unlockWithPasskey(credentials) → { credentialId, prf }`. It also handles base64url conversion and PRF result extraction (including the follow-up `get` at enrolment), and maps `NotAllowedError` (cancelled) to a typed `cancelled` result. Components never touch raw WebAuthn.

**API client:** `documents/api.ts` or `api.ts` gains `status()` (now typed with `proton` and `passkeys`), `passkeys.begin`, `passkeys.add`, `passkeys.list`, `passkeys.remove`, `unlock.begin` and `unlock`.

### 4. Security summary

| Threat | Outcome |
|---|---|
| Database stolen | Tokens and passphrase sealed; nothing decryptable |
| Database plus `SESSION_ENCRYPTION_KEY` | Proton API tokens (as today). The passphrase still needs a PRF output |
| Request forging `Remote-User` | Only possible if the port is reachable around the proxy. Header mode documents that requirement |
| Cross-site request | Blocked by `Sec-Fetch-Site` |
| Leaked PRF output | With the database and env key: the passphrase. Through Authelia: an unlock. Equivalent to a leaked password; remove the passkey |
| Brute-forcing unlock | 2^256 space; no rate limit needed |
| Passphrase in memory | Same lifetime as today: from login or unlock until a restart or logout |

## Testing

**Server (vitest):**
- **Middleware, header mode:**
  - the right user, a wrong user and a missing header
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
- **Logout** removes the passkeys.
- **Logs** never contain the PRF output, the label or the passphrase.
- **Migration 009** applies.

**PWA (happy-dom):**
- `App` routing on each status.
- **The locked banner:**
  - the passkey and no-passkey variants
  - `unlock_failed`, cancelled, `proton_login_required` and `passkeys_stale`
- **Settings → Passkeys:** list, add, `prf_unsupported`, remove.
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
2. Keep the container port unpublished (proxy network only).

## References

- [Corbado: Passkeys & WebAuthn PRF for End-to-End Encryption (2026)](https://www.corbado.com/blog/passkeys-prf-webauthn)
- [Yubico: Developer's Guide to PRF](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html)
- [Apple Developer Forums: PRF in Safari's cross-device flow](https://developer.apple.com/forums/thread/774112)
- [1Password: encrypting data with saved passkeys](https://1password.com/blog/encrypt-data-saved-passkeys)
