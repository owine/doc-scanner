# Drive SDK + OpenPGP install notes

**SDK version installed:** `@protontech/drive-sdk` 0.14.10
**openpgp version installed:** `openpgp` 6.3.0

## KeySalt source

The user's KeySalt comes from a dedicated endpoint, **`GET /core/v4/keys/salts`**, which returns a JSON body of shape `{ Code, KeySalts: [{ ID, KeySalt }] }` where each `ID` is an encrypted/internal user-key ID and `KeySalt` is a base64-encoded 16-byte salt (24 chars). See `node_modules/@protontech/drive-sdk/src/internal/apiService/coreTypes.ts:1164` for the path schema and lines 13390-13405 for the response shape (the same shape is reflected in `dist/internal/apiService/coreTypes.d.ts:13394-13402`). The SDK itself does **not** call this endpoint — it delegates user-key/address management to the host application via the `ProtonDriveAccount` interface (`dist/interface/account.d.ts`), which expects already-decrypted `PrivateKey` instances. So our `auth/keys.ts` (Task 4) must hit `/core/v4/keys/salts`, match the salt by `ID` to the corresponding key from the auth response (or `/core/v4/users` / `/core/v4/keys`), feed `(password, KeySalt)` into the vendored `computeKeyPassword`, and use the resulting passphrase to decrypt the user's PGP private key. The KeySalt is **not** present in `/auth/v4/info` (that's the SRP password-hash salt only) nor in the `/auth/v4` response body for the SDK version we vendored.

## bcryptjs decision

Kept at **3.0.3** (Phase 1's pin). The SDK declares `bcryptjs ^2.4.3` but the only API surfaces it touches are `bcryptjs.hash(...)` and `bcryptjs.encodeBase64(...)` (see `dist/internal/sharing/cryptoService.js:231,233`), both of which are unchanged in v3.x. A direct smoke test via `node -e "require('bcryptjs').hashSync('x', '$2a$10$abc...')"` plus `require('@protontech/drive-sdk')` loads cleanly with v3 installed; npm did not warn about a peer/dep conflict during `npm install --save-exact @protontech/drive-sdk@latest openpgp@latest`. The full Phase 1 unit suite (21 tests) passes after install + `npm rebuild better-sqlite3`. No downgrade required.

## CryptoProxy wiring

**Per-instance, no global singleton.** `OpenPGPCryptoWithCryptoProxy` (`dist/crypto/openPGPCrypto.js:11-16`) takes the `cryptoProxy` argument in its constructor and stores it on `this.cryptoProxy`; every method call (`generateSessionKey`, `encryptSessionKey`, etc.) goes through `this.cryptoProxy.*`. There is no `setEndpoint`, no module-level state, and no static initializer — `grep "CryptoProxy.setEndpoint\|setEndpoint" dist/crypto/*` returns nothing. This means we can construct multiple `ProtonDriveClient` instances per process (one per active user session) safely; each instance gets its own `cryptoProxy` adapter wrapping `openpgp` directly. The `getRandomValues` calls inside the SDK use the global `crypto` (Web Crypto), which is fine on Node 24.

## getNodeUrl helper

**Present.** Exposed as `protonDriveClient.experimental.getNodeUrl(nodeUid): Promise<string>` (see `dist/protonDriveClient.d.ts:31` and the implementation chain in `dist/protonDriveClient.js:66` → `dist/internal/nodes/nodesAccess.js:390-403`). The runtime URL pattern emitted is:

- Regular files/folders: `https://drive.proton.me/{shareId}/{file|folder}/{nodeId}` where `shareId` is the root share's id and `nodeId` is the link id (split out of the `nodeUid`).
- Proton Docs / Sheets: `https://docs.proton.me/doc?type={doc|sheet}&mode=open&volumeId={volumeId}&linkId={nodeId}`.

For our Phase 2 scope (uploading a synthetic file to root) we will receive a `file`-form URL. We will return the SDK's value verbatim from the test endpoint rather than constructing it ourselves.

## Surprises

- The SDK requires the host to provide an already-implemented `ProtonDriveAccount` (with decrypted `PrivateKey` objects) and an `OpenPGPCryptoProxy` adapter. There is no batteries-included "log in with email/password" path — Task 4 (key fetching/decryption) and Task 12 (CryptoProxy adapter over `openpgp`) are doing real work the spec correctly anticipated.
- `KeySalts[].ID` is the user-key ID, not the address-key ID. Multiple KeySalts can be returned (one per user key); we must match by ID against the primary user key from `/users` or `/keys`. Plan Task 4 must surface this explicitly.
- The vendored `@proton/srp` `computeKeyPassword(password, salt)` returns the bcrypt-derived mailbox passphrase that decrypts the user's *user-key*. The SDK's own `dist/internal/sharing/cryptoService.js` re-implements roughly the same primitive for sharing/public links (using `bcryptjs.encodeBase64(salt, 16)` + `bcryptjs.hash` + `slice(29)`). For Task 11 (`drive/srp-module.ts`) we should keep using the vendored `@proton/srp` path for the user-key passphrase and not try to reuse the SDK's sharing helper — they're for different scopes.
- Node 24 + better-sqlite3: `npm install` invalidates the native binding; running `npm rebuild better-sqlite3` after the SDK install is required, otherwise all DB-touching tests fail with a NODE_MODULE_VERSION mismatch. Worth automating in a postinstall script if/when CI runs.
- `package-lock.json` diff was a clean +70/-0; the npm optional-deps cross-platform-binding bug was not triggered (we did not delete the lockfile).
