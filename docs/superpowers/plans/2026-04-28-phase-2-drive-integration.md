# Phase 2: Drive Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Proton Drive SDK into the existing server so the user can hit `POST /api/drive/test-upload` and see a synthetic file appear in their Proton Drive web UI within seconds.

**Architecture:** Login flow extends Phase 1 to also fetch the user's primary private key, derive the mailbox password, and decrypt the key into process memory. A new `drive/` module group contains 6 small adapter classes implementing the SDK's interfaces (HTTP client, account, caches, SRP, crypto module). A `LiveSession` map keys these per cookie sid. One new SQLite migration adds an encrypted entities cache + plaintext event cursor; the crypto cache and mailbox secret stay in memory only with type-level non-persistence.

**Tech Stack:** Phase 1 stack + `openpgp` (real OpenPGP implementation backing `crypto-impl.ts` and the SDK's `OpenPGPCryptoWithCryptoProxy`) + `@protontech/drive-sdk` (Drive operations). Vendored `@proton/srp` already provides `computeKeyPassword` for mailbox-password derivation.

**Reference spec:** `docs/superpowers/specs/2026-04-28-phase-2-drive-design.md`

---

## File Structure

```
server/src/
├── auth/
│   ├── srp.ts                       # MODIFY: login() returns mailboxSecret + decryptedKeys
│   ├── keys.ts                      # NEW: fetchAndDecryptUserKey()
│   ├── crypto-impl.ts               # MODIFY: replace stubs with real openpgp
│   ├── live-session.ts              # NEW: LiveSession type + Map registry
│   └── secrets/
│       └── mailbox-password.ts      # NEW: MailboxSecret typed wrapper
├── drive/                           # NEW directory
│   ├── client.ts                    # facade exposing listRoot + uploadFile
│   ├── account.ts                   # ProtonDriveAccount adapter
│   ├── http-client.ts               # ProtonDriveHTTPClient adapter
│   ├── srp-module.ts                # SRPModule adapter
│   ├── entities-cache.ts            # ProtonDriveCache<string>, encrypted SQLite
│   ├── crypto-cache.ts              # ProtonDriveCache<CachedCryptoMaterial>, in-memory
│   ├── event-id-store.ts            # LatestEventIdProvider, plaintext SQLite
│   └── crypto-module.ts             # builds SDK's OpenPGPCryptoWithCryptoProxy
├── http/
│   ├── routes-auth.ts               # MODIFY: register LiveSession on login
│   ├── routes-drive.ts              # NEW: POST /api/drive/test-upload
│   ├── server.ts                    # MODIFY: mount drive routes; pass deps
│   └── middleware.ts                # MODIFY: session middleware exposes LiveSession
└── migrations/
    └── 002_drive_caches.sql         # NEW
```

**Decomposition rationale:** the `drive/` module group is one adapter per SDK interface — each small, focused, independently testable. Auth-related additions (`live-session`, `keys`, `secrets/`) live under `auth/` with the existing SRP code. HTTP routes stay thin — they wire `LiveSession` into `DriveClient` calls and shape responses.

---

## Task 1: Discovery + dependency installation

This task front-loads the two known unknowns from the spec ("Open Questions" section) so subsequent tasks rest on resolved facts. Output: package versions in `package.json`, a short `docs/superpowers/notes/2026-04-28-drive-sdk-findings.md` documenting the SDK constructor wiring and bcryptjs resolution.

**Files:**
- Modify: `server/package.json`
- Create: `docs/superpowers/notes/2026-04-28-drive-sdk-findings.md`

- [ ] **Step 1: Install latest stable `@protontech/drive-sdk` and `openpgp`**

```bash
eval "$(/opt/homebrew/bin/fnm env --shell bash)" && fnm use
cd /Users/owine/Git/doc-scanner
npm install --save-exact @protontech/drive-sdk@latest openpgp@latest --workspace @doc-scanner/server
```

The `.npmrc` already enforces `save-exact=true` so no caret prefix should appear.

- [ ] **Step 2: Resolve bcryptjs version conflict**

The Phase 1 install pinned `bcryptjs 3.0.3`. The SDK's `package.json` declares `bcryptjs ^2.4.3`. Determine compatibility:

```bash
cd /Users/owine/Git/doc-scanner
node -e "const b3 = require('bcryptjs'); console.log('v3:', b3.hashSync('x','$2a$10$abcdefghijklmnopqrstuv'.slice(0,29)));"
```

If the SDK works with v3 (likely; bcryptjs API has been stable), keep `3.0.3`. If npm complains or the SDK's own tests don't run against 3.x, downgrade by setting `"bcryptjs": "2.4.3"` exactly in `server/package.json` and running `npm install`. **Document the decision** in the findings file.

- [ ] **Step 3: Inspect SDK constructor wiring**

Read enough of the SDK source to answer: does `OpenPGPCryptoWithCryptoProxy` set CryptoProxy globally (singleton) or per-instance?

```bash
grep -n "CryptoProxy.setEndpoint\|setEndpoint" \
  /Users/owine/Git/doc-scanner/node_modules/@protontech/drive-sdk/dist/crypto/*.js \
  /Users/owine/Git/doc-scanner/node_modules/@protontech/drive-sdk/dist/crypto/*.d.ts 2>/dev/null | head -20
```

Also check whether the SDK exports a `getNodeUrl(nodeUid)` helper that returns a Drive web URL. The spec's preferred path:

```bash
grep -n "getNodeUrl\|driveUrl\|drive.proton.me" \
  /Users/owine/Git/doc-scanner/node_modules/@protontech/drive-sdk/dist/**/*.js 2>/dev/null | head -10
```

- [ ] **Step 4: Document findings**

Create `docs/superpowers/notes/2026-04-28-drive-sdk-findings.md`:

```markdown
# Drive SDK + OpenPGP install notes

**SDK version installed:** <exact pinned version>
**openpgp version installed:** <exact pinned version>

## bcryptjs decision

<one paragraph: what version we settled on and why; whether SDK + Phase 1 integration test still pass>

## CryptoProxy wiring

<one paragraph: singleton or per-instance, with a file:line reference to SDK source>

## getNodeUrl helper

<one paragraph: present/absent; if present, exact API; if absent, the URL pattern we'll construct>

## Surprises

<bullet list of anything the spec assumed that turned out different — used by the implementer of subsequent tasks>
```

- [ ] **Step 5: Verify Phase 1 tests still pass under the new lockfile**

```bash
cd /Users/owine/Git/doc-scanner/server
npm test
```

Expected: 21 passing (no regressions from new dependencies).

- [ ] **Step 6: Commit**

```bash
cd /Users/owine/Git/doc-scanner
git add server/package.json package-lock.json docs/superpowers/notes/
git commit -m "chore(server): add @protontech/drive-sdk and openpgp; document SDK wiring findings"
```

Verify `git log -1 --pretty='%G?'` shows `G`.

---

## Task 2: Real OpenPGP in crypto-impl.ts

Replace the Phase 1 stubs in `server/src/auth/crypto-impl.ts` with `openpgp.js`-backed implementations. The Phase 1 SRP integration test must continue to pass; if it doesn't, the OpenPGP wiring is wrong.

**Files:**
- Modify: `server/src/auth/crypto-impl.ts`
- Modify: `server/tests/auth/crypto-impl.test.ts` (NEW if not yet present, or extend existing)

- [ ] **Step 1: Write failing test for `verifyCleartextMessage`**

Create `server/tests/auth/crypto-impl.test.ts` with these cases:
- Valid signed cleartext + a known modulus key → returns `data` matching the body, `verificationStatus: SIGNED_AND_VALID`
- Tampered signature → returns `verificationStatus: SIGNED_AND_INVALID`
- Malformed input → throws

Use a deterministic fixture: small text, small armored ECDSA or RSA key, signed cleartext message. Generate the fixture with `openpgp` directly in a `beforeAll` so the test is self-contained.

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import * as openpgp from 'openpgp';
import { cryptoImpl, installCryptoImpl } from '../../src/auth/crypto-impl.js';
import { CryptoProxy, VERIFICATION_STATUS } from '../../src/vendor/proton-srp/crypto/index.js';

describe('cryptoImpl.verifyCleartextMessage', () => {
  let armoredKey: string;
  let signedMessage: string;
  let tamperedMessage: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ email: 'test@example.com' }],
      format: 'armored',
    });
    armoredKey = publicKey;
    const message = await openpgp.createCleartextMessage({ text: 'hello world' });
    signedMessage = await openpgp.sign({
      message,
      signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
      format: 'armored',
    }) as string;
    tamperedMessage = signedMessage.replace('hello world', 'hello WORLD');

    installCryptoImpl();
  });

  it('returns SIGNED_AND_VALID for a good signature', async () => {
    const key = await CryptoProxy.importPublicKey({ armoredKey });
    const result = await CryptoProxy.verifyCleartextMessage({
      armoredCleartextMessage: signedMessage,
      verificationKeys: key,
    });
    expect(result.data).toBe('hello world');
    expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);
  });

  it('returns SIGNED_AND_INVALID for a tampered cleartext', async () => {
    const key = await CryptoProxy.importPublicKey({ armoredKey });
    const result = await CryptoProxy.verifyCleartextMessage({
      armoredCleartextMessage: tamperedMessage,
      verificationKeys: key,
    });
    expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
  });

  it('throws on malformed input', async () => {
    const key = await CryptoProxy.importPublicKey({ armoredKey });
    await expect(CryptoProxy.verifyCleartextMessage({
      armoredCleartextMessage: 'not a pgp message',
      verificationKeys: key,
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- crypto-impl
```

Expected: FAIL — current stub returns `SIGNED_AND_VALID` for tampered messages too (it doesn't actually verify).

- [ ] **Step 3: Replace stubs in `server/src/auth/crypto-impl.ts`**

Replace the body of `cryptoImpl`:

```ts
import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import {
  CryptoProxy,
  VERIFICATION_STATUS,
  type CryptoProxyEndpoint,
  type PublicKeyReference,
  type HashAlgorithm,
} from '../vendor/proton-srp/crypto/index.js';

const ALGO_MAP: Record<HashAlgorithm, string> = {
  SHA512: 'sha512',
  SHA256: 'sha256',
  unsafeMD5: 'md5',
};

const VERIFY_STATUS_MAP: Record<number, number> = {
  [openpgp.enums.signature.unknown]: VERIFICATION_STATUS.NOT_SIGNED,
  [openpgp.enums.signature.binary]: VERIFICATION_STATUS.SIGNED_AND_VALID,
};

export const cryptoImpl: CryptoProxyEndpoint = {
  async computeHash({ algorithm, data }) {
    const nodeAlgo = ALGO_MAP[algorithm];
    const hash = createHash(nodeAlgo).update(data).digest();
    const out = new Uint8Array(new ArrayBuffer(hash.byteLength));
    out.set(hash);
    return out;
  },

  async importPublicKey({ armoredKey }): Promise<PublicKeyReference> {
    return openpgp.readKey({ armoredKey });
  },

  async exportPublicKey({ key, format }) {
    const k = key as openpgp.Key;
    if (format === 'armored') return k.armor();
    const binary = k.write();
    const out = new Uint8Array(new ArrayBuffer(binary.byteLength));
    out.set(binary);
    return out;
  },

  async verifyCleartextMessage({ armoredCleartextMessage, verificationKeys }) {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: armoredCleartextMessage });
    const keys = Array.isArray(verificationKeys) ? verificationKeys : [verificationKeys];
    const result = await openpgp.verify({
      message,
      verificationKeys: keys as openpgp.Key[],
      format: 'utf8',
    });

    let verificationStatus = VERIFICATION_STATUS.NOT_SIGNED;
    if (result.signatures.length > 0) {
      try {
        await result.signatures[0]!.verified;
        verificationStatus = VERIFICATION_STATUS.SIGNED_AND_VALID;
      } catch {
        verificationStatus = VERIFICATION_STATUS.SIGNED_AND_INVALID;
      }
    }

    return { data: result.data as string, verificationStatus };
  },
};

let installed = false;
export function installCryptoImpl(): void {
  if (installed) return;
  CryptoProxy.setEndpoint(cryptoImpl);
  installed = true;
}
```

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- crypto-impl
```

Expected: 3 passing.

- [ ] **Step 5: Run Phase 1 SRP integration test (regression check)**

```bash
cd /Users/owine/Git/doc-scanner/server
INTEGRATION=1 \
  PROTON_TEST_EMAIL='<test account>' \
  PROTON_TEST_PASSWORD='<password>' \
  npm run test:integration
```

Expected: 1 passing (Phase 1's `srp.integration.test.ts`). **If this fails, do not proceed** — the OpenPGP swap broke SRP login. Diagnose by comparing the new `verifyCleartextMessage` body extraction against the Phase 1 stub's parser.

NOTE: This is a manual verification; the implementer should ask the user to run it if they can't.

- [ ] **Step 6: Run full test suite + typecheck**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test && npm run typecheck
```

Expected: 24 passing total (21 existing + 3 new), typecheck clean both configs.

- [ ] **Step 7: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/auth/crypto-impl.ts server/tests/auth/crypto-impl.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(auth): replace cryptoImpl stubs with real openpgp.js implementations"
```

---

## Task 3: MailboxSecret typed wrapper

**Files:**
- Create: `server/src/auth/secrets/mailbox-password.ts`
- Create: `server/tests/auth/secrets/mailbox-password.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/tests/auth/secrets/mailbox-password.test.ts` with these cases:
- `use(fn)` provides bytes; return value of `fn` propagates
- `dispose()` zeroes the underlying buffer
- `toJSON()` returns `'[REDACTED]'`
- `[Symbol.for('nodejs.util.inspect.custom')]()` returns `'[REDACTED]'`
- `JSON.stringify({ secret })` does not contain the underlying bytes
- `util.inspect({ secret })` does not contain the underlying bytes

```ts
import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { MailboxSecret } from '../../../src/auth/secrets/mailbox-password.js';

describe('MailboxSecret', () => {
  const SAMPLE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('use() provides the underlying bytes', async () => {
    const secret = new MailboxSecret(SAMPLE);
    const length = await secret.use(async (bytes) => bytes.length);
    expect(length).toBe(8);
  });

  it('dispose() zeroes the buffer', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const secret = new MailboxSecret(buf);
    secret.dispose();
    expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
  });

  it('toJSON returns [REDACTED]', () => {
    const secret = new MailboxSecret(SAMPLE);
    expect(secret.toJSON()).toBe('[REDACTED]');
  });

  it('inspect.custom returns [REDACTED]', () => {
    const secret = new MailboxSecret(SAMPLE);
    expect(inspect(secret)).toBe('[REDACTED]');
  });

  it('JSON.stringify of containing object hides bytes', () => {
    const secret = new MailboxSecret(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const out = JSON.stringify({ x: secret });
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('222');  // 0xde,0xad,... in decimal
    expect(out).toContain('[REDACTED]');
  });

  it('util.inspect of containing object hides bytes', () => {
    const secret = new MailboxSecret(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const out = inspect({ x: secret });
    expect(out).not.toContain('deadbeef');
    expect(out).toContain('[REDACTED]');
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- mailbox-password
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/auth/secrets/mailbox-password.ts`**

```ts
/**
 * Wraps mailbox password bytes so they cannot be accidentally serialized,
 * logged, or returned. Public surface is intentionally minimal: callers must
 * use `.use(fn)` to get scoped access to the underlying bytes, then explicitly
 * `.dispose()` when no longer needed.
 *
 * This is a runtime guard in addition to the discipline of never persisting
 * mailbox passwords (Phase 2 design decision: memory-only).
 */
export class MailboxSecret {
  // Private; no getter exposed. The bytes are only accessible via `use(fn)`.
  readonly #bytes: Uint8Array;
  #disposed = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async use<T>(fn: (bytes: Uint8Array) => Promise<T> | T): Promise<T> {
    if (this.#disposed) throw new Error('MailboxSecret: already disposed');
    return await fn(this.#bytes);
  }

  dispose(): void {
    this.#bytes.fill(0);
    this.#disposed = true;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}
```

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- mailbox-password
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/auth/secrets/ server/tests/auth/secrets/
git -C /Users/owine/Git/doc-scanner commit -m "feat(auth): add MailboxSecret typed wrapper with non-leak guarantees"
```

---

## Task 4: auth/keys.ts — fetch user info + decrypt private keys

**Files:**
- Modify: `server/src/auth/proton-api.ts` (add `getUser`, `getUserKeys` methods if not yet present)
- Create: `server/src/auth/keys.ts`
- Create: `server/tests/auth/keys.test.ts`

- [ ] **Step 1: Add user/keys endpoints to ProtonApi**

Modify `server/src/auth/proton-api.ts` — add interface types and methods:

```ts
// Add to existing interfaces:
export interface ProtonUser {
  ID: string;
  Name: string;
  Currency: string;
  Email: string;
  DisplayName: string;
  Keys: ProtonUserKey[];
  // ... other fields, optional
}

export interface ProtonUserKey {
  ID: string;
  Version: number;
  Primary: number;
  Active: number;
  Flags: number;
  PrivateKey: string;  // armored, encrypted
  Fingerprint: string;
  Address?: string;
}

// Add methods to ProtonApi class:
async getUser(uid: string, accessToken: string): Promise<{ User: ProtonUser }> {
  return this.request<{ User: ProtonUser }>('GET', '/core/v4/users', undefined, {
    'x-pm-uid': uid,
    authorization: `Bearer ${accessToken}`,
  });
}
```

NOTE: The exact endpoint shape for fetching user + keys may differ — verify against Task 1's findings. The `/core/v4/users` endpoint should return the user object with their keys inline. If the SDK or recent docs indicate a different path, use what's correct.

The `request<T>` helper currently always sends a body — if it doesn't already handle GET-without-body, that's a bug to fix in the same task. Look at the existing implementation; if `body !== undefined` is the gate, GET will work fine (no body argument).

- [ ] **Step 2: Write failing test for keys.ts**

Create `server/tests/auth/keys.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchAndDecryptUserKey, KeyDecryptError } from '../../src/auth/keys.js';
import type { ProtonApi, ProtonUser } from '../../src/auth/proton-api.js';
import * as openpgp from 'openpgp';

describe('fetchAndDecryptUserKey', () => {
  it('decrypts the primary user key with the correct mailbox password', async () => {
    // Generate a real test key with a real passphrase
    const passphrase = 'test-mailbox-password-bytes';
    const { privateKey: armoredKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ email: 'test@example.com' }],
      passphrase,
      format: 'armored',
    });

    const fakeUser: ProtonUser = {
      ID: 'u1',
      Name: 'test',
      Currency: 'USD',
      Email: 'test@example.com',
      DisplayName: 'Test',
      Keys: [{
        ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: armoredKey, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };

    const fakeApi = {
      getUser: vi.fn().mockResolvedValue({ User: fakeUser }),
      getAuthInfo: vi.fn(),  // unused
    } as unknown as ProtonApi;

    // Phase 2 derives mailbox password via vendored computeKeyPassword(plaintext, salt)
    // For this unit test, we bypass that path by passing the pre-derived bytes.
    // The full login-with-keys integration test exercises the real derivation.
    const result = await fetchAndDecryptUserKey({
      api: fakeApi,
      uid: 'uid-x',
      accessToken: 'at-x',
      mailboxPasswordBytes: new TextEncoder().encode(passphrase),
    });

    expect(result.primaryKey).toBeDefined();
    expect(result.addresses).toHaveLength(1);
    expect(result.addresses[0]!.email).toBe('test@example.com');
  });

  it('throws KeyDecryptError on wrong mailbox password', async () => {
    const { privateKey: armoredKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ email: 'test@example.com' }],
      passphrase: 'correct-password',
      format: 'armored',
    });

    const fakeUser: ProtonUser = {
      ID: 'u1', Name: 't', Currency: 'USD', Email: 'test@example.com', DisplayName: 't',
      Keys: [{
        ID: 'k1', Version: 4, Primary: 1, Active: 1, Flags: 3,
        PrivateKey: armoredKey, Fingerprint: 'fp', Address: 'test@example.com',
      }],
    };

    const fakeApi = { getUser: vi.fn().mockResolvedValue({ User: fakeUser }) } as unknown as ProtonApi;

    await expect(fetchAndDecryptUserKey({
      api: fakeApi, uid: 'u', accessToken: 'a',
      mailboxPasswordBytes: new TextEncoder().encode('wrong-password'),
    })).rejects.toThrow(KeyDecryptError);
  });
});
```

- [ ] **Step 3: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- keys
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `server/src/auth/keys.ts`**

```ts
import * as openpgp from 'openpgp';
import type { ProtonApi, ProtonUser, ProtonUserKey } from './proton-api.js';

export interface DecryptedUserKey {
  primaryAddress: { email: string; addressId: string };
  primaryKey: openpgp.PrivateKey;
  addresses: { email: string; addressId: string; key: openpgp.PrivateKey }[];
}

export class KeyDecryptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'KeyDecryptError';
  }
}

export interface FetchAndDecryptParams {
  api: ProtonApi;
  uid: string;
  accessToken: string;
  mailboxPasswordBytes: Uint8Array;
}

/**
 * Fetches the user's profile from Proton and decrypts their primary private key
 * using the supplied mailbox password bytes. Returns key handles suitable for
 * passing to the SDK's ProtonDriveAccount adapter.
 *
 * Stateless — call this once per login, then store the result in the
 * caller's LiveSession map (memory only).
 */
export async function fetchAndDecryptUserKey(params: FetchAndDecryptParams): Promise<DecryptedUserKey> {
  const { api, uid, accessToken, mailboxPasswordBytes } = params;

  const { User } = await api.getUser(uid, accessToken);
  if (!User.Keys || User.Keys.length === 0) {
    throw new KeyDecryptError('User has no keys');
  }

  const passphrase = new TextDecoder().decode(mailboxPasswordBytes);

  // Decrypt every active user key. The "primary" one is the address-level
  // primary; for Drive operations, the primary user key is what signs/decrypts.
  const decrypted: { email: string; addressId: string; key: openpgp.PrivateKey }[] = [];
  for (const k of User.Keys) {
    if (!k.Active) continue;
    try {
      const armored = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
      const key = await openpgp.decryptKey({ privateKey: armored, passphrase });
      decrypted.push({
        email: k.Address ?? User.Email,
        addressId: k.ID,
        key,
      });
    } catch (e) {
      throw new KeyDecryptError(`Failed to decrypt key ${k.ID}`, e);
    }
  }

  if (decrypted.length === 0) throw new KeyDecryptError('No decryptable keys');

  const primary = User.Keys.find((k) => k.Primary === 1 && k.Active === 1);
  const primaryEntry = primary
    ? decrypted.find((d) => d.addressId === primary.ID)
    : decrypted[0];

  if (!primaryEntry) throw new KeyDecryptError('No primary key after decryption');

  return {
    primaryAddress: { email: primaryEntry.email, addressId: primaryEntry.addressId },
    primaryKey: primaryEntry.key,
    addresses: decrypted,
  };
}
```

NOTE on the User/Address model: Proton's API distinguishes between *user keys* (root keys, decrypt other keys) and *address keys* (per-email-address, used for Drive sharing). For the narrow Phase 2 scope (own files, no sharing), the user's primary user key is sufficient. If the SDK throws complaining about missing addresses with their own keys, extend this function to fetch `/core/v4/addresses` and decrypt those too — but defer until that surfaces.

- [ ] **Step 5: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- keys
```

Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/auth/proton-api.ts server/src/auth/keys.ts server/tests/auth/keys.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(auth): fetch and decrypt user private key on login"
```

---

## Task 5: Migration 002 — drive caches schema

**Files:**
- Create: `server/src/migrations/002_drive_caches.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Schema version 2: drive integration caches.

CREATE TABLE IF NOT EXISTS entities_cache (
  key TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_cursors (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Run existing db tests to verify migration runs cleanly**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- db
```

The Phase 1 migration runner picks up new `NNN_*.sql` files automatically; tests should still pass and the new tables exist after `openDb()`. To be sure:

```bash
cd /Users/owine/Git/doc-scanner/server
npx vitest run tests/db.test.ts -t "expected tables"
```

Will only assert original tables — that's fine. Add a new test asserting the new tables exist.

Append to `server/tests/db.test.ts` (inside the existing `describe`):

```ts
  it('migration 002 creates drive cache tables', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('entities_cache');
    expect(names).toContain('event_cursors');

    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(2);
  });
```

- [ ] **Step 3: Run db tests**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- db
```

Expected: 4 passing (3 existing + 1 new).

- [ ] **Step 4: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/migrations/002_drive_caches.sql server/tests/db.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(server): migration 002 — drive caches (entities + event cursor)"
```

---

## Task 6: drive/entities-cache.ts — encrypted SQLite cache

**Files:**
- Create: `server/src/drive/entities-cache.ts`
- Create: `server/tests/drive/entities-cache.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { EntitiesCache } from '../../src/drive/entities-cache.js';
import { createTestDb } from '../helpers/test-db.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

let cleanupFn: (() => void) | null = null;
afterEach(() => { cleanupFn?.(); cleanupFn = null; });

describe('EntitiesCache', () => {
  it('round-trips a value', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.set('foo', 'bar-value');
    expect(await cache.get('foo')).toBe('bar-value');
  });

  it('returns undefined for missing keys', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    expect(await cache.get('nonexistent')).toBeUndefined();
  });

  it('removes a key', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.set('foo', 'bar');
    await cache.remove('foo');
    expect(await cache.get('foo')).toBeUndefined();
  });

  it('throws on wrong encryption key', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    await new EntitiesCache(db, KEY).set('foo', 'bar');
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    const otherCache = new EntitiesCache(db, otherKey);
    await expect(otherCache.get('foo')).rejects.toThrow();
  });

  it('overwrites existing key', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const cache = new EntitiesCache(db, KEY);
    await cache.set('foo', 'v1');
    await cache.set('foo', 'v2');
    expect(await cache.get('foo')).toBe('v2');
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- entities-cache
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/drive/entities-cache.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * SDK ProtonDriveCache<string> implementation backed by SQLite.
 *
 * Each value is encrypted with AES-GCM using the SESSION_ENCRYPTION_KEY,
 * keeping folder metadata (which can include filenames) protected at rest
 * to the same standard as the session blob in Phase 1.
 */
export class EntitiesCache {
  private readonly key: Buffer;

  constructor(private readonly db: DB, base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('EntitiesCache: key must be 32 bytes');
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT encrypted_blob FROM entities_cache WHERE key = ?').get(key) as { encrypted_blob: Buffer } | undefined;
    if (!row) return undefined;
    return this.decrypt(row.encrypted_blob);
  }

  async set(key: string, value: string): Promise<void> {
    const blob = this.encrypt(value);
    this.db.prepare(`
      INSERT INTO entities_cache (key, encrypted_blob, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET encrypted_blob = excluded.encrypted_blob, updated_at = datetime('now')
    `).run(key, blob);
  }

  async remove(key: string): Promise<void> {
    this.db.prepare('DELETE FROM entities_cache WHERE key = ?').run(key);
  }

  private encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }

  private decrypt(blob: Buffer): string {
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = blob.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
```

NOTE: the SDK's `ProtonDriveCache<T>` interface may have additional methods (e.g., `iterate`, `clear`). Check the SDK's `cache.d.ts` and add stubs for any required methods. If the interface includes methods we don't need for narrow scope, implement them with reasonable defaults (empty iterate, full clear) — don't over-engineer.

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- entities-cache
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/entities-cache.ts server/tests/drive/entities-cache.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): encrypted SQLite-backed entities cache"
```

---

## Task 7: drive/crypto-cache.ts — in-memory cache

**Files:**
- Create: `server/src/drive/crypto-cache.ts`
- Create: `server/tests/drive/crypto-cache.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { CryptoCache } from '../../src/drive/crypto-cache.js';

describe('CryptoCache', () => {
  it('round-trips a value', async () => {
    const cache = new CryptoCache();
    await cache.set('k1', { nodeKeys: { passphrase: 'p', key: {} as any, passphraseSessionKey: {} as any } });
    const v = await cache.get('k1');
    expect(v?.nodeKeys?.passphrase).toBe('p');
  });

  it('returns undefined for missing keys', async () => {
    const cache = new CryptoCache();
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('remove() deletes a key', async () => {
    const cache = new CryptoCache();
    await cache.set('k1', {} as any);
    await cache.remove('k1');
    expect(await cache.get('k1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- crypto-cache
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/drive/crypto-cache.ts`**

```ts
import type { CachedCryptoMaterial } from '@protontech/drive-sdk';

/**
 * SDK ProtonDriveCache<CachedCryptoMaterial> implementation backed only by
 * an in-process Map.
 *
 * DO NOT add SQLite or any other persistence here. Decrypted node keys must
 * never touch disk; persisting them would defeat Drive's end-to-end encryption.
 * Type-level non-persistence is enforced by this being a separate class from
 * EntitiesCache rather than a parameterized common base.
 */
export class CryptoCache {
  private readonly store = new Map<string, CachedCryptoMaterial>();

  async get(key: string): Promise<CachedCryptoMaterial | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: CachedCryptoMaterial): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}
```

If the SDK's interface requires more methods (`iterate`, `clear`), add them — implement against the in-memory `Map`.

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- crypto-cache
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/crypto-cache.ts server/tests/drive/crypto-cache.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): in-memory crypto cache (never persists, by type)"
```

---

## Task 8: drive/event-id-store.ts — event cursor

**Files:**
- Create: `server/src/drive/event-id-store.ts`
- Create: `server/tests/drive/event-id-store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { EventIdStore } from '../../src/drive/event-id-store.js';
import { createTestDb } from '../helpers/test-db.js';

let cleanupFn: (() => void) | null = null;
afterEach(() => { cleanupFn?.(); cleanupFn = null; });

describe('EventIdStore', () => {
  it('returns null when no cursor stored', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new EventIdStore(db);
    expect(await store.getLatest()).toBeNull();
  });

  it('round-trips a cursor', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatest('cursor-1');
    expect(await store.getLatest()).toBe('cursor-1');
  });

  it('overwrites existing cursor (single-row contract)', async () => {
    const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
    const store = new EventIdStore(db);
    await store.setLatest('c1');
    await store.setLatest('c2');
    expect(await store.getLatest()).toBe('c2');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM event_cursors').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- event-id-store
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/drive/event-id-store.ts`**

```ts
import type { DB } from '../db.js';

/**
 * SDK LatestEventIdProvider implementation backed by a single-row SQLite table.
 * The cursor is opaque, non-secret — stored plaintext.
 */
export class EventIdStore {
  constructor(private readonly db: DB) {}

  async getLatest(): Promise<string | null> {
    const row = this.db.prepare('SELECT cursor FROM event_cursors WHERE id = 1').get() as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async setLatest(cursor: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO event_cursors (id, cursor, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = datetime('now')
    `).run(cursor);
  }
}
```

NOTE: the SDK's `LatestEventIdProvider` may have specific method names — verify against `node_modules/@protontech/drive-sdk/dist/internal/events/interface.d.ts`. Adjust `getLatest`/`setLatest` to match. Behavior stays the same.

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- event-id-store
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/event-id-store.ts server/tests/drive/event-id-store.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): plaintext SQLite event cursor store"
```

---

## Task 9: drive/account.ts — ProtonDriveAccount adapter

**Files:**
- Create: `server/src/drive/account.ts`
- Create: `server/tests/drive/account.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { DriveAccount } from '../../src/drive/account.js';

describe('DriveAccount', () => {
  it('returns the primary address from decrypted keys', async () => {
    const { privateKey } = await openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy',
      userIDs: [{ email: 'test@example.com' }],
      passphrase: 'p',
      format: 'object',
    });
    const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });

    const account = new DriveAccount({
      primaryAddress: { email: 'test@example.com', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'test@example.com', addressId: 'a1', key: decrypted }],
    });

    const addr = await account.getOwnPrimaryAddress();
    expect(addr.email).toBe('test@example.com');
    expect(addr.addressId).toBe('a1');
    expect(addr.keys[0]!.id).toBe('a1');
  });

  it('hasProtonAccount returns true for own email', async () => {
    const { privateKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'me@example.com' }], passphrase: 'p', format: 'object' });
    const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });

    const account = new DriveAccount({
      primaryAddress: { email: 'me@example.com', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'me@example.com', addressId: 'a1', key: decrypted }],
    });

    expect(await account.hasProtonAccount('me@example.com')).toBe(true);
    expect(await account.hasProtonAccount('other@example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- account
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/drive/account.ts`**

```ts
import * as openpgp from 'openpgp';
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { DecryptedUserKey } from '../auth/keys.js';

/**
 * Implements the SDK's ProtonDriveAccount interface from in-memory decrypted keys.
 * Constructed once per LiveSession; lifetime is the cookie lifetime.
 *
 * For Phase 2's narrow scope (own files, no sharing), the user's primary key is
 * the only one needed. `getPublicKeys` returns own public key for own email and
 * an empty array otherwise (sharing is out of scope).
 */
export class DriveAccount implements ProtonDriveAccount {
  constructor(private readonly user: DecryptedUserKey) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    return {
      email: this.user.primaryAddress.email,
      addressId: this.user.primaryAddress.addressId,
      primaryKeyIndex: 0,
      keys: [{
        id: this.user.primaryAddress.addressId,
        key: this.user.primaryKey as any,
      }],
    };
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    return this.user.addresses.map((a, i) => ({
      email: a.email,
      addressId: a.addressId,
      primaryKeyIndex: 0,
      keys: [{ id: a.addressId, key: a.key as any }],
    }));
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const all = await this.getOwnAddresses();
    const match = all.find((a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId);
    if (!match) throw new Error(`No address matching ${emailOrAddressId}`);
    return match;
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return this.user.addresses.some((a) => a.email === email);
  }

  async getPublicKeys(email: string, _forceRefresh?: boolean): Promise<unknown[]> {
    const own = this.user.addresses.find((a) => a.email === email);
    if (!own) return [];  // Phase 2: no sharing → don't fetch other users' keys
    return [own.key.toPublic() as unknown];
  }
}
```

NOTE: the SDK's interface uses `PublicKey` from `'@protontech/drive-sdk'`. The cast through `unknown` is a type-laundering escape hatch because openpgp's types and the SDK's types don't directly intersect. If the SDK rejects this at runtime (it shouldn't — SDK uses CryptoProxy to mediate), revisit by checking what the SDK does with the returned key.

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- account
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/account.ts server/tests/drive/account.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): ProtonDriveAccount adapter from in-memory decrypted keys"
```

---

## Task 10: drive/http-client.ts — ProtonDriveHTTPClient adapter

**Files:**
- Create: `server/src/drive/http-client.ts`
- Create: `server/tests/drive/http-client.test.ts`

- [ ] **Step 1: Inspect SDK HTTP interface**

The SDK's `ProtonDriveHTTPClient` interface is in `node_modules/@protontech/drive-sdk/dist/interface/httpClient.d.ts`. Read it before writing the adapter — it specifies methods like `requestJson`, `requestBlob`, etc.:

```bash
cat /Users/owine/Git/doc-scanner/node_modules/@protontech/drive-sdk/dist/interface/httpClient.d.ts | head -50
```

Adapt the implementation below to the actual interface.

- [ ] **Step 2: Write test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriveHttpClient } from '../../src/drive/http-client.js';

describe('DriveHttpClient', () => {
  const mockFetch = vi.fn();
  beforeEach(() => { mockFetch.mockReset(); global.fetch = mockFetch as any; });

  it('sends Authorization, x-pm-uid, x-pm-appversion headers', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const client = new DriveHttpClient({
      baseUrl: 'https://drive-api.example.test',
      appVersion: 'external-drive-docscanner@0.1.0',
      uid: 'uid-x',
      accessToken: 'at-x',
    });
    await client.requestJson({ method: 'GET', path: '/some/endpoint' });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer at-x');
    expect(headers['x-pm-uid']).toBe('uid-x');
    expect(headers['x-pm-appversion']).toBe('external-drive-docscanner@0.1.0');
  });

  it('throws on non-2xx with parsed error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"Error":"Forbidden","Code":403}', { status: 403 }));
    const client = new DriveHttpClient({
      baseUrl: 'https://drive-api.example.test',
      appVersion: 'external-drive-docscanner@0.1.0',
      uid: 'uid-x',
      accessToken: 'at-x',
    });
    await expect(client.requestJson({ method: 'GET', path: '/x' })).rejects.toThrow(/Forbidden/);
  });
});
```

- [ ] **Step 3: Implement `server/src/drive/http-client.ts`**

The exact interface should match what the SDK requires. Below is a reference implementation; adapt method names if SDK requires (e.g., `request`, `requestBlob`, etc.):

```ts
import type { ProtonDriveHTTPClient } from '@protontech/drive-sdk';
import { ProtonApiError } from '../auth/proton-api.js';

export interface DriveHttpClientConfig {
  baseUrl: string;
  appVersion: string;
  uid: string;
  accessToken: string;
}

export class DriveHttpClient implements ProtonDriveHTTPClient {
  constructor(private readonly config: DriveHttpClientConfig) {}

  // Adapt method signatures to match the actual SDK interface from
  // @protontech/drive-sdk/dist/interface/httpClient.d.ts
  async requestJson<T = unknown>(opts: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${opts.path}`, {
      method: opts.method,
      headers: this.commonHeaders(opts.headers),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return await this.parseJson<T>(res);
  }

  async requestBlob(opts: {
    method: string;
    path: string;
    body: Uint8Array | Blob;
    headers?: Record<string, string>;
  }): Promise<Uint8Array> {
    const res = await fetch(`${this.config.baseUrl}${opts.path}`, {
      method: opts.method,
      headers: this.commonHeaders({ 'content-type': 'application/octet-stream', ...opts.headers }),
      body: opts.body as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ProtonApiError(text || `HTTP ${res.status}`, res.status);
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  private commonHeaders(extras: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.accessToken}`,
      'x-pm-uid': this.config.uid,
      'x-pm-appversion': this.config.appVersion,
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': `Mozilla/5.0 (compatible; ${this.config.appVersion})`,
      accept: 'application/json',
      ...extras,
    };
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const err = parsed as { Error?: string; Code?: number };
      throw new ProtonApiError(err.Error ?? `HTTP ${res.status}`, res.status, err.Code);
    }
    return parsed as T;
  }
}
```

NOTE: When the implementer reads the SDK's `httpClient.d.ts`, the interface methods may differ from `requestJson`/`requestBlob`. Match the actual names + signatures.

- [ ] **Step 4: Run test, verify passing**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test -- http-client
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/http-client.ts server/tests/drive/http-client.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): ProtonDriveHTTPClient adapter with bearer auth + Proton headers"
```

---

## Task 11: drive/srp-module.ts — SRPModule adapter

**Files:**
- Create: `server/src/drive/srp-module.ts`
- Create: `server/tests/drive/srp-module.test.ts`

The SDK's `SRPModule` interface is in `node_modules/@protontech/drive-sdk/dist/crypto/index.d.ts`. Inspect it first:

```bash
cat /Users/owine/Git/doc-scanner/node_modules/@protontech/drive-sdk/dist/crypto/*.d.ts | grep -A 20 "interface SRPModule\|class SRPModule"
```

- [ ] **Step 1: Write failing test (adapt to actual interface)**

The SRPModule typically exposes methods to compute SRP proofs. Our existing `ProtonAuth.refresh()` already handles re-authentication; the SDK's SRPModule should delegate to it. Specific test cases depend on the actual interface — read the SDK source first.

If the interface is `{ login(username, password) -> proof }`, the test:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DriveSrpModule } from '../../src/drive/srp-module.js';

describe('DriveSrpModule', () => {
  it('delegates re-authentication to provided refresh callback', async () => {
    const refresh = vi.fn().mockResolvedValue({ uid: 'u', accessToken: 'a-new', refreshToken: 'r-new', email: 'x@y.test' });
    const mod = new DriveSrpModule({ onRefreshNeeded: refresh });

    // Whatever method the interface exposes — adapt:
    // If it's `refresh()`, call `await mod.refresh()`
    // If it's `getCredentials()`, call `await mod.getCredentials()`
    // Etc.
  });
});
```

- [ ] **Step 2: Implement adapter matching the SDK's interface**

The shape will look something like:

```ts
import type { ProtonSession } from '../auth/srp.js';

export interface DriveSrpModuleConfig {
  onRefreshNeeded: (current: ProtonSession) => Promise<ProtonSession>;
}

export class DriveSrpModule {
  constructor(private readonly config: DriveSrpModuleConfig) {}

  // Methods specific to SDK's SRPModule interface.
  // Most SDK clients only need refresh handling — implement that path.
}
```

Defer specifics until the implementer reads the actual SDK interface.

- [ ] **Step 3: Run test, verify passing**

- [ ] **Step 4: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/srp-module.ts server/tests/drive/srp-module.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): SRPModule adapter delegating to ProtonAuth refresh"
```

---

## Task 12: drive/crypto-module.ts — wires SDK's OpenPGPCryptoWithCryptoProxy

**Files:**
- Create: `server/src/drive/crypto-module.ts`

Per Task 1's findings, the SDK exposes `OpenPGPCryptoWithCryptoProxy` and uses our `CryptoProxy` shim (now real-backed via Task 2). This module just constructs and exports the wrapper.

- [ ] **Step 1: Implement**

```ts
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';
import { installCryptoImpl } from '../auth/crypto-impl.js';

/**
 * Returns the SDK's OpenPGPCryptoWithCryptoProxy instance, ensuring our
 * CryptoProxy endpoint is installed first. Idempotent — safe to call multiple
 * times per process.
 */
export function getOpenPGPModule() {
  installCryptoImpl();
  return new OpenPGPCryptoWithCryptoProxy();
}
```

NOTE: `OpenPGPCryptoWithCryptoProxy` may be a class or a factory function — check the SDK export. If it's a class with constructor args, supply them per the SDK's docs.

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/owine/Git/doc-scanner/server && npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit (no test — this is just glue, exercised via Task 13's integration)**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/crypto-module.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): build SDK OpenPGPCryptoWithCryptoProxy with our shim"
```

---

## Task 13: drive/client.ts — facade

**Files:**
- Create: `server/src/drive/client.ts`
- Create: `server/tests/drive/client.test.ts` (constructor wiring; full behavior validated by integration test)

This is the facade that constructs `ProtonDriveClient` with all adapters and exposes the two methods we need.

- [ ] **Step 1: Implement `server/src/drive/client.ts`**

```ts
import { ProtonDriveClient, NullFeatureFlagProvider, type ProtonDriveTelemetry } from '@protontech/drive-sdk';
import type { DB } from '../db.js';
import type { DecryptedUserKey } from '../auth/keys.js';
import type { ProtonSession } from '../auth/srp.js';
import { DriveAccount } from './account.js';
import { DriveHttpClient } from './http-client.js';
import { DriveSrpModule } from './srp-module.js';
import { EntitiesCache } from './entities-cache.js';
import { CryptoCache } from './crypto-cache.js';
import { EventIdStore } from './event-id-store.js';
import { getOpenPGPModule } from './crypto-module.js';

export interface DriveClientConfig {
  db: DB;
  encryptionKey: string;
  appVersion: string;
  baseUrl?: string;
  user: DecryptedUserKey;
  session: ProtonSession;
  onRefreshNeeded: (current: ProtonSession) => Promise<ProtonSession>;
}

const NULL_TELEMETRY: ProtonDriveTelemetry = {
  logEvent() {},
  logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
};

export class DriveClient {
  private readonly sdk: ProtonDriveClient;

  constructor(cfg: DriveClientConfig) {
    const httpClient = new DriveHttpClient({
      baseUrl: cfg.baseUrl ?? 'https://drive-api.proton.me',
      appVersion: cfg.appVersion,
      uid: cfg.session.uid,
      accessToken: cfg.session.accessToken,
    });

    this.sdk = new ProtonDriveClient({
      httpClient: httpClient as any,
      entitiesCache: new EntitiesCache(cfg.db, cfg.encryptionKey) as any,
      cryptoCache: new CryptoCache() as any,
      account: new DriveAccount(cfg.user) as any,
      openPGPCryptoModule: getOpenPGPModule(),
      srpModule: new DriveSrpModule({ onRefreshNeeded: cfg.onRefreshNeeded }) as any,
      featureFlagProvider: new NullFeatureFlagProvider(),
      latestEventIdProvider: new EventIdStore(cfg.db) as any,
      telemetry: NULL_TELEMETRY,
    });
  }

  async listRoot() {
    const root = await this.sdk.getMyFilesRootFolder();
    const children: any[] = [];
    for await (const child of this.sdk.iterateFolderChildren(root)) {
      children.push({ uid: (child as any).uid, name: (child as any).name, type: (child as any).type });
    }
    return { root: { uid: (root as any).uid, name: (root as any).name }, children };
  }

  async uploadFile(name: string, bytes: Uint8Array, mimeType: string): Promise<{ nodeUid: string; driveUrl: string }> {
    const root = await this.sdk.getMyFilesRootFolder();
    // Adapt to actual SDK upload API; this is illustrative
    const result = await (this.sdk as any).uploadFile({
      parent: root,
      name,
      content: bytes,
      mimeType,
    });
    const nodeUid = (result as any).uid as string;

    let driveUrl: string;
    try {
      driveUrl = await this.sdk.experimental.getNodeUrl(nodeUid);
    } catch {
      driveUrl = `https://drive.proton.me/u/0/${nodeUid}`;
    }

    return { nodeUid, driveUrl };
  }
}
```

The `as any` casts are isolated to where SDK types and our types disagree by design (we're satisfying the SDK's interface, not consuming an SDK-typed value). When the implementer writes this file, they should remove `any` casts where the actual types align.

NOTE: the SDK's upload API is the most variable part of this implementation. `iterateFolderChildren`, `getMyFilesRootFolder`, and the upload method should all be exercised against the real SDK during the integration tests in Task 15. If the API surface differs from the illustrative usage above, adapt — the contract this file owes the route handler is `listRoot()` and `uploadFile()`, both returning the simple shapes used in the route handler.

- [ ] **Step 2: Smoke compile**

```bash
cd /Users/owine/Git/doc-scanner/server && npm run typecheck
```

Expected: clean (with the `any` casts as escape hatches where needed).

- [ ] **Step 3: Optional unit test (constructor doesn't throw)**

Create `server/tests/drive/client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';

describe('DriveClient', () => {
  it('constructs without throwing given valid deps', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const { privateKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'x@y.test' }], passphrase: 'p', format: 'object' });
      const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });

      const client = new DriveClient({
        db,
        encryptionKey: Buffer.alloc(32, 1).toString('base64'),
        appVersion: 'external-drive-docscanner@0.1.0',
        user: {
          primaryAddress: { email: 'x@y.test', addressId: 'a1' },
          primaryKey: decrypted,
          addresses: [{ email: 'x@y.test', addressId: 'a1', key: decrypted }],
        },
        session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'x@y.test' },
        onRefreshNeeded: async (s) => s,
      });
      expect(client).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 4: Run typecheck + test**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/drive/client.ts server/tests/drive/client.test.ts
git -C /Users/owine/Git/doc-scanner commit -m "feat(drive): DriveClient facade wiring SDK with all adapters"
```

---

## Task 14: LiveSession map + login route extension

**Files:**
- Create: `server/src/auth/live-session.ts`
- Modify: `server/src/auth/srp.ts`
- Modify: `server/src/http/routes-auth.ts`
- Modify: `server/src/http/middleware.ts`

- [ ] **Step 1: Create `server/src/auth/live-session.ts`**

```ts
import type { ProtonSession } from './srp.js';
import type { MailboxSecret } from './secrets/mailbox-password.js';
import type { DecryptedUserKey } from './keys.js';
import type { DriveClient } from '../drive/client.js';

export interface LiveSession {
  sid: string;
  session: ProtonSession;
  mailboxSecret: MailboxSecret;
  decryptedKeys: DecryptedUserKey;
  driveClient: DriveClient;
}

const sessions = new Map<string, LiveSession>();

export function registerLiveSession(s: LiveSession): void {
  sessions.set(s.sid, s);
}

export function getLiveSession(sid: string): LiveSession | undefined {
  return sessions.get(sid);
}

export function disposeLiveSession(sid: string): void {
  const s = sessions.get(sid);
  s?.mailboxSecret.dispose();
  sessions.delete(sid);
}

export function _resetLiveSessions(): void {
  for (const sid of sessions.keys()) disposeLiveSession(sid);
}
```

- [ ] **Step 2: Modify `server/src/auth/srp.ts`**

Change `login()` to also derive the mailbox password and the decrypted keys, returning all three:

The existing `login()` returns `ProtonSession`. Extend its return type to `{ session: ProtonSession; mailboxSecret: MailboxSecret; decryptedKeys: DecryptedUserKey }`.

Inside `login()`, after the auth succeeds and `auth` is populated, BEFORE returning:

```ts
// Derive mailbox password using vendored computeKeyPassword
import { computeKeyPassword } from '../vendor/proton-srp/keys.js';
import { MailboxSecret } from './secrets/mailbox-password.js';
import { fetchAndDecryptUserKey } from './keys.js';

// inside login(), after the auth response is available:
const mailboxPasswordBytes = await computeKeyPassword(password, info.Salt);
const mailboxSecret = new MailboxSecret(mailboxPasswordBytes);

const decryptedKeys = await fetchAndDecryptUserKey({
  api: this.api,
  uid: auth.UID,
  accessToken: auth.AccessToken,
  mailboxPasswordBytes,
});

return {
  session: { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken, email },
  mailboxSecret,
  decryptedKeys,
};
```

Update the existing unit test for `login()` (`server/tests/auth/srp.test.ts`) to assert the new shape — at minimum, `result.session.uid` instead of `result.uid`. The integration test will exercise the full flow.

- [ ] **Step 3: Modify `server/src/http/routes-auth.ts` login handler**

After `protonAuth.login()` succeeds and `store.save()` runs, also construct the `DriveClient` and register the `LiveSession`:

```ts
// in /login handler, after store.save(session.session):
const sid = issueSession(c);
const driveClient = new DriveClient({
  db: deps.db,
  encryptionKey: deps.encryptionKey,
  appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
  user: result.decryptedKeys,
  session: result.session,
  onRefreshNeeded: async (current) => {
    const refreshed = await deps.protonAuth.refresh(current);
    deps.store.save(refreshed);
    return refreshed;
  },
});
registerLiveSession({
  sid,
  session: result.session,
  mailboxSecret: result.mailboxSecret,
  decryptedKeys: result.decryptedKeys,
  driveClient,
});
```

NOTE: `authRoutes()` will need access to `db` and `encryptionKey`; add them to the deps argument.

- [ ] **Step 4: Modify `server/src/http/middleware.ts`**

Extend `sessionMiddleware` to populate `c.get('liveSession')` from `getLiveSession(sid)`:

```ts
// Add to AuthContext:
export interface AuthContext { email: string; sid: string; liveSession?: LiveSession }
```

Then in `sessionMiddleware`:

```ts
if (sid && liveSids.has(sid)) {
  const session = store.load();
  const liveSession = getLiveSession(sid);
  if (session) c.set('auth', { email: session.email, sid, liveSession });
}
```

- [ ] **Step 5: Update `revokeSession` to dispose live session**

```ts
export function revokeSession(c: Context<Env>): void {
  const sid = getCookie(c, COOKIE_NAME);
  if (sid) {
    liveSids.delete(sid);
    disposeLiveSession(sid);
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}
```

- [ ] **Step 6: Update existing routes-auth.test.ts tests**

The tests use a fake ProtonAuth — its `login()` mock now needs to return the new shape `{ session, mailboxSecret, decryptedKeys }`. Update each `mockResolvedValue` accordingly. Adding fixture `decryptedKeys` is fine for the routes test (the route doesn't inspect them deeply unless drive endpoints are involved).

- [ ] **Step 7: Run all tests + typecheck**

```bash
cd /Users/owine/Git/doc-scanner/server && npm test && npm run typecheck
```

Expected: all passing.

- [ ] **Step 8: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/auth/live-session.ts server/src/auth/srp.ts server/src/http/routes-auth.ts server/src/http/middleware.ts server/tests/
git -C /Users/owine/Git/doc-scanner commit -m "feat(auth): LiveSession map; login flow constructs DriveClient and registers it"
```

---

## Task 15: Drive test endpoint + integration tests

**Files:**
- Create: `server/src/http/routes-drive.ts`
- Modify: `server/src/http/server.ts`
- Create: `server/tests/drive/list-root.integration.test.ts`
- Create: `server/tests/drive/upload.integration.test.ts`

- [ ] **Step 1: Implement test endpoint**

```ts
// server/src/http/routes-drive.ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from './middleware.js';
import { logger } from '../logger.js';
import type { DB } from '../db.js';

const TestUploadSchema = z.object({ name: z.string().optional() });

type Env = { Variables: { auth?: AuthContext } };

export function driveRoutes(deps: { db: DB }) {
  const r = new Hono<Env>();

  r.post('/test-upload', async (c) => {
    const auth = c.get('auth');
    if (!auth?.liveSession) return c.json({ error: 'not_authenticated' }, 401);

    const body = TestUploadSchema.safeParse(await c.req.json().catch(() => ({})));
    const name = body.success && body.data.name
      ? body.data.name
      : `doc-scanner-test-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

    const payload = `doc-scanner test ${new Date().toISOString()}`;
    const bytes = new TextEncoder().encode(payload);

    try {
      const { nodeUid, driveUrl } = await auth.liveSession.driveClient.uploadFile(name, bytes, 'text/plain');
      deps.db.prepare(`
        INSERT INTO audit_log (event, detail, remote_user)
        VALUES ('drive_test_upload', ?, ?)
      `).run(JSON.stringify({ filename: name, nodeUid, driveUrl }), c.req.header('Remote-User') ?? null);
      logger.info({ email: auth.email, nodeUid }, 'drive test upload succeeded');
      return c.json({ ok: true, nodeUid, driveUrl, filename: name });
    } catch (e) {
      logger.warn({ email: auth.email, err: (e as Error).message }, 'drive test upload failed');
      return c.json({ error: 'upload_failed', detail: (e as Error).message }, 500);
    }
  });

  return r;
}
```

- [ ] **Step 2: Mount on `createApp`**

In `server/src/http/server.ts`, add:

```ts
import { driveRoutes } from './routes-drive.js';

// inside createApp, after app.route('/api/auth', ...):
app.route('/api/drive', driveRoutes({ db: deps.db }));
```

- [ ] **Step 3: Write integration test for list-root**

`server/tests/drive/list-root.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('Drive list-root (integration)', () => {
  it('lists the root folder of the test account', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const api = new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0');
      const auth = new ProtonAuth(api);
      const result = await auth.login(process.env.PROTON_TEST_EMAIL!, process.env.PROTON_TEST_PASSWORD!);

      const client = new DriveClient({
        db,
        encryptionKey: Buffer.alloc(32, 1).toString('base64'),
        appVersion: 'external-drive-docscanner@0.1.0',
        user: result.decryptedKeys,
        session: result.session,
        onRefreshNeeded: async (s) => auth.refresh(s),
      });

      const root = await client.listRoot();
      expect(root.root.uid).toBeTruthy();
    } finally {
      cleanup();
    }
  }, 60_000);
});
```

- [ ] **Step 4: Write integration test for upload (with cleanup)**

`server/tests/drive/upload.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('Drive upload (integration)', () => {
  it('uploads then deletes a synthetic file', async () => {
    const { db, cleanup } = createTestDb();
    let nodeUid: string | undefined;
    try {
      const api = new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0');
      const auth = new ProtonAuth(api);
      const result = await auth.login(process.env.PROTON_TEST_EMAIL!, process.env.PROTON_TEST_PASSWORD!);

      const client = new DriveClient({
        db,
        encryptionKey: Buffer.alloc(32, 1).toString('base64'),
        appVersion: 'external-drive-docscanner@0.1.0',
        user: result.decryptedKeys,
        session: result.session,
        onRefreshNeeded: async (s) => auth.refresh(s),
      });

      const filename = `docscanner-test-${Date.now()}.txt`;
      const bytes = new TextEncoder().encode('doc-scanner integration test');
      const uploaded = await client.uploadFile(filename, bytes, 'text/plain');
      nodeUid = uploaded.nodeUid;
      expect(uploaded.nodeUid).toBeTruthy();
      expect(uploaded.driveUrl).toMatch(/^https:\/\/drive\.proton\.me\//);
    } finally {
      // Cleanup: delete the uploaded file via SDK if upload succeeded
      // (The SDK has trash/delete operations even though we don't expose them via PWA in P2)
      if (nodeUid) {
        try {
          // Direct SDK access via DriveClient is limited in our facade — for
          // the test, we may need to call the underlying SDK directly. Add a
          // narrow `_internal_delete(nodeUid)` method to DriveClient for test use.
        } catch (e) {
          console.warn('Test cleanup failed:', e);
        }
      }
      cleanup();
    }
  }, 120_000);
});
```

NOTE: The cleanup path needs SDK access. Add a narrowly-scoped test-only method to `DriveClient` (e.g., `_test_trashByUid(uid)`) or accept that test-uploaded files will accumulate in the test account and require periodic manual cleanup. Document the choice.

- [ ] **Step 5: Run integration tests**

```bash
cd /Users/owine/Git/doc-scanner/server
INTEGRATION=1 \
  PROTON_TEST_EMAIL='<test account>' \
  PROTON_TEST_PASSWORD='<password>' \
  npm run test:integration
```

Expected: all passing (Phase 1 SRP + Phase 2 list-root + Phase 2 upload).

NOTE: This is a manual verification; the implementer should ask the user to run it if they can't.

- [ ] **Step 6: Commit**

```bash
git -C /Users/owine/Git/doc-scanner add server/src/http/routes-drive.ts server/src/http/server.ts server/tests/drive/
git -C /Users/owine/Git/doc-scanner commit -m "feat(http): /api/drive/test-upload endpoint + integration tests"
```

---

## Task 16: End-to-end manual smoke

User-driven, not automated. Validates the full flow.

- [ ] **Step 1: Boot the stack**

```bash
cd /Users/owine/Git/doc-scanner
docker compose up --build -d
```

In another terminal:

```bash
eval "$(/opt/homebrew/bin/fnm env --shell bash)" && fnm use
cd /Users/owine/Git/doc-scanner/pwa
npm run dev
```

- [ ] **Step 2: Log in via PWA at `http://localhost:5173/`**

Use the test account. Should land on StatusScreen.

- [ ] **Step 3: Hit the test endpoint via curl**

```bash
COOKIE=$(grep -oE 'docscanner_sid=[^;]+' < browser-extracted-cookie-or-similar)

curl -X POST http://localhost:3000/api/drive/test-upload \
  -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"name":"phase-2-smoke.txt"}'
```

Expected: JSON response with `nodeUid` and `driveUrl`.

- [ ] **Step 4: Verify in Proton Drive web UI**

Open https://drive.proton.me — the file `phase-2-smoke.txt` should appear in My Files within seconds. Open it; contents should be `doc-scanner test <timestamp>`.

Delete it manually after verification.

- [ ] **Step 5: Record smoke results in this plan**

Add to the bottom of this plan file:

```markdown
## Smoke Results

_Date:_
_Test account:_
_Notes:_
```

- [ ] **Step 6: Final commit + tag**

```bash
git -C /Users/owine/Git/doc-scanner add docs/superpowers/plans/
git -C /Users/owine/Git/doc-scanner commit -m "docs: phase 2 smoke recorded"
git -C /Users/owine/Git/doc-scanner tag -a phase-2-complete -m "Phase 2: Drive integration — smoke verified"
```

---

## Phase 2 Done — Definition

- All unit tests pass (Phase 1 + new Phase 2): `cd server && npm test`.
- Integration tests pass with `INTEGRATION=1`: Phase 1 SRP + Phase 2 list-root + Phase 2 upload (with cleanup).
- Phase 1 manual smoke (login + status persistence) still works.
- Phase 2 manual smoke succeeds: hit `/api/drive/test-upload`, see file in Proton Drive web UI.
- `audit_log` records the test-upload event.
- No new vendoring (only npm packages added).

---

## Smoke Results (filled in during Task 16)

_Date:_
_Test account:_
_Notes:_
