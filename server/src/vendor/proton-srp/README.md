# Vendored: Proton SRP

This directory contains a minimal subset of Proton's SRP implementation,
copied from the [WebClients monorepo](https://github.com/ProtonMail/WebClients)
because `@proton/srp` is a workspace-only package and is not published to npm.

## Source

- **Repository:** https://github.com/ProtonMail/WebClients
- **Pinned commit:** `c324b82f2b83867798d942e115c1fd12cbd73f5b`
- **License:** MIT (see `./LICENSE`, copied verbatim from upstream)

One file (`crypto/bigInteger.ts`) is taken from a different upstream repo:

- **Repository:** https://github.com/ProtonMail/pmcrypto
- **Pinned commit:** `dc8a675cefd6200bf05e143ee0587d987d8af19e`
- **License:** MIT
- **Note:** The pmcrypto file's header notes those routines were originally
  copied from openpgpjs v6 (LGPL-3.0). The implementations are basic BigInt
  arithmetic helpers and the upstream pmcrypto carries them under MIT.

## Files vendored

Grouped by upstream source path. Files are byte-identical to upstream except
for the import-path rewrites described in the "Modifications" section below.

### From `WebClients/packages/srp/lib/` at pinned SHA

- `constants.ts`
- `getAuthVersionWithFallback.ts`
- `index.ts`
- `interface.ts`
- `keys.ts`
- `passwords.ts`
- `srp.ts`
- `utils/modulus.ts`
- `utils/username.ts`

Test files (`*.test.ts`) were intentionally not vendored.

### From `WebClients/packages/utils/` at pinned SHA

- `utils/mergeUint8Arrays.ts`

### From `WebClients/packages/shared/lib/helpers/` at pinned SHA

- `shared/encoding.ts`

### From `WebClients/packages/crypto/lib/` at pinned SHA

- `crypto/utils.ts` (no transitive dependencies)

### From `pmcrypto/lib/` at pinned SHA

- `crypto/bigInteger.ts` — pure BigInt helpers; replaces upstream
  `@proton/crypto/lib/bigInteger`, which itself is just a re-export of
  `pmcrypto/lib/bigInteger` plus a small additional helper that we don't use.

### Hand-written shim (this repo)

- `crypto/index.ts` — minimal `CryptoProxy` interface, see "Modifications".

## Modifications

By policy, we only modify import paths in vendored files. The shim file
(`crypto/index.ts`) is the only hand-authored file in this tree.

### Import-path rewrites

All `@proton/*` imports in vendored files were rewritten to relative paths:

| Original                                  | Rewritten to            |
| ----------------------------------------- | ----------------------- |
| `@proton/crypto/lib/bigInteger`           | `./crypto/bigInteger`   |
| `@proton/crypto/lib/utils`                | `./crypto/utils`        |
| `@proton/crypto`                          | `./crypto`              |
| `@proton/shared/lib/helpers/encoding`     | `./shared/encoding`     |
| `@proton/utils/mergeUint8Arrays`          | `./utils/mergeUint8Arrays` |

(In files inside `utils/` and `shared/` the relative prefix is `../` instead
of `./`.)

### `crypto/index.ts` shim (CryptoProxy)

Upstream `@proton/crypto` is a large package backed by OpenPGP.js
(~16.5 MB unpacked on npm) and bundles a worker-based proxy abstraction.
Vendoring it whole would dominate the server bundle and pull in OpenPGP.js
as an effective dependency.

The vendored SRP code only uses four CryptoProxy methods:

- `computeHash({ algorithm: 'SHA512' | 'unsafeMD5', data })` — used by
  `passwords.ts`. Trivially backed by Node's built-in `node:crypto`.
- `importPublicKey({ armoredKey })` — used by `utils/modulus.ts`.
- `exportPublicKey({ key, format: 'binary' })` — used by `utils/modulus.ts`.
- `verifyCleartextMessage({ armoredCleartextMessage, verificationKeys })` —
  used by `utils/modulus.ts`.

The last three need an OpenPGP implementation to verify the SRP modulus
signature against Proton's published public key.

`crypto/index.ts` exports a lightweight `CryptoProxy` object with a
`setEndpoint(impl)` method. Consumers (Task 6: `server/src/auth/srp.ts`)
must install a runtime endpoint before calling any SRP function.
This keeps the OpenPGP dependency decision out of the vendor tree.

### `crypto/index.ts` differs structurally from upstream

Upstream `packages/crypto/lib/index.ts` re-exports `serverTime`, `proxy`,
`constants`, `worker/api.models`, and `worker/sentry`. We do not vendor any
of those. The replacement file exposes only the API surface used by the
vendored SRP code: `CryptoProxy`, `VERIFICATION_STATUS`, and the
`PublicKeyReference` type alias.

## Configuration changes outside the vendor tree

The vendored code is type-checked under a separate
`server/src/vendor/tsconfig.json` with `noUncheckedIndexedAccess: false` and
`exactOptionalPropertyTypes: false`. The vendored code does not satisfy these
extra-strict checks (e.g., it indexes static lookup tables without `?? ''`
and passes `undefined` to optional parameters). Per policy we cannot rewrite
the vendored logic, and these two flags are above and beyond the standard
`strict: true` baseline.

The main `server/tsconfig.json` excludes `src/vendor/**` from its compilation,
so production code is type-checked normally and gets the strict flags
(`noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
Production code that imports from `@vendor/proton-srp/*` is type-checked
under the strict main config — only the vendored module's internal type
checking is relaxed.

`server/tsconfig.json` was also modified to:

1. Add `"lib": ["ES2022", "ESNext.TypedArrays"]` so TypeScript knows about
   `Uint8Array.fromBase64`, `Uint8Array.prototype.toBase64`, and `.toHex`,
   which the vendored code uses extensively. These methods are stage-3
   ECMAScript proposals available in Node 22+.
2. Add `"paths": { "@vendor/proton-srp/*": ["./src/vendor/proton-srp/*"] }`
   so consumer code can import via the `@vendor/proton-srp/*` alias.

`npm run typecheck` runs both tsconfigs: the main one against `src/` (excluding
vendor), and the vendor one against `src/vendor/`.

`server/package.json` gained a runtime dependency on `bcryptjs` (pinned
exact, currently `3.0.3`). The vendored `passwords.ts` and `keys.ts`
import from `bcryptjs`, which is published on npm and not vendored.
`bcryptjs` ships its own type definitions; no `@types/bcryptjs` is needed.

## Re-vendoring procedure

1. Pick a new pinned commit:

   ```bash
   curl -s https://api.github.com/repos/ProtonMail/WebClients/commits/main \
     | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])"
   ```

   (Optionally also bump the pmcrypto pin for `crypto/bigInteger.ts`.)

2. Re-fetch each file listed under "Files vendored" from the new SHA.
3. Re-apply the import-path rewrites listed in the table above.
4. Re-run `npx tsc --noEmit` from `server/` and resolve any new transitive
   imports. The known transitive set at the current pin is enumerated
   above; an upstream change might add or drop entries.
5. Update the pinned SHAs and any changed file lists in this README.
6. Bump the `bcryptjs` pin in `server/package.json` if upstream's
   `packages/srp/package.json` changed its dep range.
