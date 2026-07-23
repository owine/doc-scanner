# Tier 1: tsx Runtime + Drive SDK Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock upgrading `@protontech/drive-sdk` past the `0.14.10` pin by running the server through `tsx` (which compiles the SDK's raw-`.ts` peer dependency on the fly), then bump to `0.19.2` and adapt `drive/client.ts` to the post-0.17.0 node API.

**Architecture:** Two independent phases. **Phase A** switches the server's dev *and* production runtime from `node dist/` to `tsx src/` while staying on `0.14.10` — a pure runtime-mechanism change with zero behavior change, proven safe by the existing 92-test suite. **Phase B** bumps the SDK + its `@protontech/crypto` peer, adds two typecheck-config tweaks, and reworks `drive/client.ts` for the new API surface (nodes are returned unwrapped; `NodeEntity.name` is now itself a `Result`).

**Tech Stack:** Node 24.18.0, TypeScript 7, tsx (esbuild loader), Hono, node:sqlite, Vitest, Docker, pnpm.

**Why tsx and not a bundler:** Plain Node refuses to type-strip `.ts` files inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and `@protontech/crypto@2.x` ships raw `.ts` source with no compiled JS. `tsx`'s esbuild-based loader compiles those on demand. This was verified end-to-end against `drive-sdk@0.19.2` + `@protontech/crypto@2.1.1`: the SDK loads and runs, and `tsc` type-checks clean once `allowImportingTsExtensions` and a one-line `Uint8Array.toHex` shim are added.

**Out of scope:** Full bundler (Tier 2), any sharing/photos features, live Proton integration testing (requires real credentials; the existing `*.integration.test.ts` remain credential-gated).

---

## File Structure

| File | Phase | Responsibility |
|------|-------|----------------|
| `server/package.json` | A, B | Promote `tsx` to a runtime dep; `start` → tsx; **retire the dead `build` script + `main` field**; (B) SDK + crypto versions |
| `pnpm-lock.yaml` (repo root) | A, B | Regenerated when deps move/bump — must be staged with each dependency change |
| `Dockerfile` | A | Production runtime: ship `server/src`, run via `tsx`, drop server/vendor `tsc` emit + migrations copy |
| `.github/workflows/ci.yml` | A | Remove the now-dead "Build (server)" step (would break under `allowImportingTsExtensions` in B) |
| `server/tsconfig.json` | B | `allowImportingTsExtensions` for the raw-`.ts` peer |
| `server/src/types/protontech-crypto-shims.d.ts` | B | Ambient `Uint8Array.toHex` declaration (create) |
| `server/src/drive/client.ts` | B | Adapt to 0.19.2 node API; extract `nodeName` helper |
| `server/tests/drive/node-name.test.ts` | B | Unit test for the `nodeName` helper (create) |
| `renovate.json` | B | Update the drive-sdk gate note to record the tsx unblock |

*(`server/src/vendor/tsconfig.json` needs no change — it already has `noEmit: true`. The root `build` script is `pnpm -r --if-present run build`, so removing the server `build` script makes root build cleanly skip the server and still build the PWA.)*

---

## Phase A — Switch runtime to `tsx` (still on `@protontech/drive-sdk` 0.14.10)

Goal: production and dev both run `tsx server/src/index.ts`. No SDK change, no behavior change. This isolates the runtime-mechanism switch from the upgrade so a regression in either is unambiguous.

### Task A1: Run the server under tsx in dev + production

**Files:**
- Modify: `server/package.json` (scripts)
- Modify: `Dockerfile` (build + runtime stages)

- [ ] **Step 1: Confirm the green baseline**

Run (from repo root, Node 24.18.0 per `.nvmrc`):
```bash
cd server && pnpm test 2>&1 | tail -3
```
Expected: `Test Files 17 passed (17)` / `Tests 92 passed (92)`.

- [ ] **Step 2: Point the production `start` script at tsx and retire the dead build**

In `server/package.json`:
- Change `"start": "node dist/index.js",` to `"start": "tsx src/index.ts",`. Leave `"dev": "tsx watch src/index.ts"` unchanged.
- Promote `tsx` from `devDependencies` to `dependencies` (move the `"tsx": "4.23.1"` line) since production now imports it.
- **Remove the `"build": "tsc -p tsconfig.json",` script** — nothing runs a compiled server anymore (Step 3 repoints Docker, Step 4 repoints CI). Keep `"typecheck"` as-is.
- **Remove the `"main": "dist/index.js",` field** — it points at a `dist` that no longer exists.

- [ ] **Step 3: Regenerate the lockfile for the tsx dep move**

The single shared lockfile lives at the **repo root** and records `tsx` under `server.devDependencies`. Moving it to `dependencies` changes the importer snapshot, so `--frozen-lockfile` (used by both CI and the Docker build) will fail until the lockfile is regenerated:
```bash
cd server && pnpm install 2>&1 | tail -3
```
Expected: install succeeds; `git status` shows the root `pnpm-lock.yaml` modified.

- [ ] **Step 4: Remove the dead "Build (server)" CI step**

In `.github/workflows/ci.yml`, delete the step:
```yaml
      - name: Build (server)
        run: pnpm --filter @doc-scanner/server run build
```
Leave "Build (pwa)", the typecheck step, and the test steps untouched. (This step is dead after Step 2 removes the `build` script, and would otherwise fail once Phase B adds `allowImportingTsExtensions`.)

- [ ] **Step 5: Simplify the Dockerfile to ship source and run tsx**

In `Dockerfile`, the `build` stage currently runs `tsc` to emit `server/dist` and a separate vendor compile. Under tsx we run source directly, so:

Replace the server build line:
```dockerfile
RUN pnpm --filter @doc-scanner/server run build
```
and the vendor-compile block:
```dockerfile
RUN cd server && pnpm exec tsc -p src/vendor/tsconfig.json --noEmit false --outDir dist/vendor --rootDir src/vendor --module commonjs \
 && echo '{"type":"commonjs"}' > dist/vendor/package.json
```
with a single typecheck (build-time safety net, no emit):
```dockerfile
RUN pnpm --filter @doc-scanner/server run typecheck
```

In the `runtime` stage, replace the three server copies + migrations copy:
```dockerfile
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/migrations ./server/dist/migrations
COPY --from=build /app/server/package.json ./server/
```
with a copy of the whole server source tree (migrations now load from `src/migrations` relative to `src/db.ts`, so no separate copy is needed):
```dockerfile
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/server/package.json ./server/
```

Change the runtime `CMD`:
```dockerfile
CMD ["node", "server/dist/index.js"]
```
to run via the pnpm binary that resolves tsx from `node_modules`:
```dockerfile
CMD ["node", "--import", "tsx", "server/src/index.ts"]
```
(`--import tsx` registers the loader without a bundler; the runtime stage already copies the full `node_modules` from `deps`, so `tsx` is present.)

- [ ] **Step 6: Verify the server boots under tsx**

Run (from repo root):
```bash
cd server && DB_PATH=/tmp/tier1-smoke.db SESSION_ENCRYPTION_KEY=$(node -e "console.log(Buffer.alloc(32,1).toString('base64'))") INSECURE_COOKIES=1 PORT=3999 timeout 6 node --import tsx src/index.ts 2>&1 | tail -5; rm -f /tmp/tier1-smoke.db
```
Expected: a log line `"server listening"` with `"port":3999` and the migration lines (`applying migration ... 001/002`). The `timeout` returns non-zero on kill — that is fine; success is the "server listening" line.

- [ ] **Step 7: Re-run the suite unchanged**

Run:
```bash
cd server && pnpm test 2>&1 | tail -3
```
Expected: `Tests 92 passed (92)` — Phase A changes nothing the tests observe.

- [ ] **Step 8: Verify the Docker image builds and boots**

Run (from repo root):
```bash
docker build -t doc-scanner:tier1 . && \
docker run --rm -e SESSION_ENCRYPTION_KEY=$(node -e "console.log(Buffer.alloc(32,1).toString('base64'))") -e INSECURE_COOKIES=1 -e DB_PATH=/tmp/app.db -p 3998:3000 --name tier1-smoke -d doc-scanner:tier1 && \
sleep 4 && docker logs tier1-smoke 2>&1 | tail -5 && docker rm -f tier1-smoke
```
Expected: `"server listening"` in the logs. If the build fails on a missing `dist`, re-check Step 5's runtime COPY lines.

- [ ] **Step 9: Commit**

```bash
git add server/package.json pnpm-lock.yaml Dockerfile .github/workflows/ci.yml
git commit -m "build: run server under tsx instead of compiled dist

Plain node cannot type-strip .ts files inside node_modules, which blocks
consuming @protontech/crypto (raw-.ts peer of drive-sdk >=0.15). Running
via tsx's esbuild loader compiles those on demand. No behavior change;
migrations now load from src/migrations directly.

Claude-Session: https://claude.ai/code/session_01HSK1VvNGECnzW8zunoschH"
```

---

## Phase B — Bump the SDK and adapt the client

Goal: `@protontech/drive-sdk@0.19.2` + `@protontech/crypto@2.1.1`, typecheck clean, tests green, server boots.

### Task B1: Add the typecheck escape hatch and bump the dependencies

**Files:**
- Create: `server/src/types/protontech-crypto-shims.d.ts`
- Modify: `server/tsconfig.json`
- Modify: `server/package.json` (dependencies)

- [ ] **Step 1: Add the ambient `toHex` shim**

`@protontech/crypto` calls `Uint8Array.prototype.toHex` (a TC39 proposal method it polyfills at runtime via `core-js`). Its raw `.ts` source has no type for it, so `tsc` — which follows the source since the package ships no `.d.ts` — errors `TS2339`. Create `server/src/types/protontech-crypto-shims.d.ts`:

```typescript
// @protontech/crypto (a peer of @protontech/drive-sdk >=0.15) ships raw .ts
// source with no bundled .d.ts, so tsc type-checks its source directly. That
// source uses the TC39 Uint8Array.prototype.toHex proposal, polyfilled at
// runtime via core-js. Declare it here so the project type-checks.
interface Uint8Array {
  toHex(): string;
}
```

- [ ] **Step 2: Enable `.ts`-extension imports in the server tsconfig**

The SDK's compiled code imports its crypto peer by literal source path (`'@protontech/crypto/subtle/hmac.ts'`). `tsc` rejects `.ts`-suffixed imports unless told otherwise. In `server/tsconfig.json`, add to `compilerOptions`:

```json
"allowImportingTsExtensions": true,
```

This flag requires `noEmit` (or `emitDeclarationOnly`) — an emit build would fail `TS5096`. Phase A already retired the emit build **everywhere** (the Dockerfile step, the CI "Build (server)" step, and the `build` script itself), and the `typecheck` script runs `tsc --noEmit`, so nothing emits and the flag is safe. Verify the include still excludes `tests/**` and `src/vendor/**` (unchanged).

- [ ] **Step 3: Bump the dependencies**

In `server/package.json`, change:
```json
"@protontech/drive-sdk": "0.14.10",
```
to pin the target version and add the (previously transitive-only) peer explicitly:
```json
"@protontech/crypto": "2.1.1",
"@protontech/drive-sdk": "0.19.2",
```
Then install (the `.npmrc` 7-day soak is satisfied — both versions are months old):
```bash
cd server && pnpm install 2>&1 | tail -5
```
Expected: install succeeds, lockfile passes the supply-chain policy check.

- [ ] **Step 4: Confirm the runtime loads (independent of our client rework)**

Run:
```bash
cd server && node --import tsx -e "import('@protontech/drive-sdk').then(m => console.log('SDK', m.VERSION, typeof m.ProtonDriveClient))"
```
Expected: `SDK 0.19.2 function` — no type-stripping crash. This proves the tsx + peer wiring before touching our code.

- [ ] **Step 5: Confirm typecheck now fails only in `client.ts` (drives B2)**

Run:
```bash
cd server && pnpm typecheck 2>&1 | grep -E "error TS" | head
```
Expected: errors **only** in `src/drive/client.ts` (e.g. `MaybeNode`/`DegradedNode` no longer exported; `getMyFilesRootFolder` returns `NodeEntity` not `MaybeNode`). No `TS5097` and no `toHex` `TS2339` errors — those are cleared by Steps 1–2. If any TS5097/toHex errors remain, fix the tsconfig flag / shim before proceeding.

- [ ] **Step 6: Commit**

```bash
git add server/package.json pnpm-lock.yaml server/tsconfig.json server/src/types/protontech-crypto-shims.d.ts
git commit -m "deps: bump drive-sdk to 0.19.2 with @protontech/crypto peer

Adds allowImportingTsExtensions + a Uint8Array.toHex ambient shim so tsc
can read the crypto peer's raw .ts source. client.ts rework follows.

Claude-Session: https://claude.ai/code/session_01HSK1VvNGECnzW8zunoschH"
```

*(The lockfile is a single shared file at the repo root — `pnpm-lock.yaml`, not `server/pnpm-lock.yaml`.)*

### Task B2: Rework `drive/client.ts` for the 0.19.2 node API

The 0.19.2 API changed how nodes are returned:
- `getMyFilesRootFolder(): Promise<NodeEntity>` — returns the node directly; **no `MaybeNode` wrapper**.
- `iterateFolderChildren(parentUid): AsyncGenerator<NodeEntity>` — yields `NodeEntity` directly (still present, now marked `@deprecated` in favor of `iterateFolderChildrenNodeUids`; we keep it to minimize churn).
- `NodeEntity.name` is now `Result<string, Error | InvalidNameError>` — **name decryption can fail independently of the node**. This is where the old node-level "degraded" concept moved.
- `getAvailableName`, `getFileUploader`, `experimental.getNodeUrl`, and `UploadController.completion()` (`{ nodeUid, nodeRevisionUid }`) are unchanged.

**Files:**
- Modify: `server/src/drive/client.ts`
- Create: `server/tests/drive/node-name.test.ts`

- [ ] **Step 1: Write the failing unit test for the name-unwrap helper**

Create `server/tests/drive/node-name.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { nodeName } from '../../src/drive/client.js';
import type { NodeEntity } from '@protontech/drive-sdk';

function node(name: NodeEntity['name']): NodeEntity {
  // Only `name` matters for this helper; cast the rest.
  return { uid: 'u', name } as unknown as NodeEntity;
}

describe('nodeName', () => {
  it('returns the decrypted name when the Result is ok', () => {
    expect(nodeName(node({ ok: true, value: 'scan.pdf' }))).toBe('scan.pdf');
  });

  it('returns null when the name failed to decrypt', () => {
    expect(nodeName(node({ ok: false, error: new Error('bad name') }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd server && pnpm vitest run tests/drive/node-name.test.ts 2>&1 | tail -8
```
Expected: FAIL — `nodeName` is not exported from `client.ts` yet.

- [ ] **Step 3: Rework `client.ts`**

In `server/src/drive/client.ts`:

Change the SDK import block — drop `MaybeNode` and `DegradedNode`, keep `NodeEntity`:
```typescript
import {
  ProtonDriveClient,
  NullFeatureFlagProvider,
  type ProtonDriveTelemetry,
  type Logger,
  type NodeEntity,
} from '@protontech/drive-sdk';
```

Delete the entire `unwrapNode` function (lines around the `MaybeNode` unwrap) and replace it with the exported helper:
```typescript
/**
 * `NodeEntity.name` is a `Result`: the SDK can decrypt the node while failing
 * to decrypt its name (e.g. a name signed with an unavailable key). Returns
 * the name, or null when it could not be decrypted. This is the field-level
 * successor to the pre-0.17 node-level `DegradedNode`.
 */
export function nodeName(node: NodeEntity): string | null {
  return node.name.ok ? node.name.value : null;
}
```

Rewrite `listRoot` to consume unwrapped nodes and treat an undecryptable *name* as the degraded case:
```typescript
  async listRoot(): Promise<ListRootResult> {
    const root = await this.sdk.getMyFilesRootFolder();

    const children: ListRootChild[] = [];
    let degradedCount = 0;
    for await (const child of this.sdk.iterateFolderChildren(root.uid)) {
      const name = nodeName(child);
      if (name === null) {
        // Name could not be decrypted; skip it but keep the count visible.
        degradedCount += 1;
        continue;
      }
      children.push({ uid: child.uid, name, type: String(child.type) });
    }

    return {
      root: { uid: root.uid, name: nodeName(root) ?? '(unknown)' },
      children,
      degradedCount,
    };
  }
```

Rewrite the two `getMyFilesRootFolder()` call sites in `uploadFile` to drop the unwrap:
```typescript
  async uploadFile(name: string, bytes: Uint8Array, mimeType: string): Promise<UploadResult> {
    const root = await this.sdk.getMyFilesRootFolder();

    const availableName = await this.sdk.getAvailableName(root.uid, name);
    // ...rest of uploadFile unchanged (getFileUploader, stream, completion, getNodeUrl)...
```

Leave `getFileUploader`, the `ReadableStream` wrapper, `controller.completion()`, `experimental.getNodeUrl`, and `clearCaches` exactly as they are — those signatures are unchanged in 0.19.2.

- [ ] **Step 4: Run the helper test to verify it passes**

Run:
```bash
cd server && pnpm vitest run tests/drive/node-name.test.ts 2>&1 | tail -6
```
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck the whole server**

Run:
```bash
cd server && pnpm typecheck 2>&1 | tail -3; echo "exit=$?"
```
Expected: `exit=0`, no errors.

- [ ] **Step 6: Run the full suite**

Run:
```bash
cd server && pnpm test 2>&1 | tail -3
```
Expected: all tests pass (92 prior + 2 new = 94), or the same count if the deprecated integration tests are skipped. Investigate any real failure — the crypto-module and account tests exercise the paths most likely to shift.

- [ ] **Step 7: Boot smoke under the new SDK**

Run:
```bash
cd server && DB_PATH=/tmp/tier1b-smoke.db SESSION_ENCRYPTION_KEY=$(node -e "console.log(Buffer.alloc(32,1).toString('base64'))") INSECURE_COOKIES=1 PORT=3997 timeout 6 node --import tsx src/index.ts 2>&1 | tail -5; rm -f /tmp/tier1b-smoke.db
```
Expected: `"server listening"` on port 3997, migrations applied — proves the crypto peer loads through the full app under tsx.

- [ ] **Step 8: Commit**

```bash
git add server/src/drive/client.ts server/tests/drive/node-name.test.ts
git commit -m "feat(drive): adapt client to drive-sdk 0.19.2 node API

getMyFilesRootFolder/iterateFolderChildren now return NodeEntity directly;
NodeEntity.name is a Result. Replaces node-level unwrapNode with a
field-level nodeName helper (degraded == undecryptable name).

Claude-Session: https://claude.ai/code/session_01HSK1VvNGECnzW8zunoschH"
```

### Task B3: Update the Renovate gate note

**Files:**
- Modify: `renovate.json`

- [ ] **Step 1: Record the unblock in the gate description**

The `@protontech/drive-sdk` packageRule keeps `dependencyDashboardApproval: true` + `automerge: false` (bumps still warrant a human look because of API drift), but its `description` block is now stale — it says the versions are *blocked*. Update it to state that Tier 1 (tsx runtime + `allowImportingTsExtensions` + `toHex` shim) unblocked consumption as of this change, that the project now runs on `0.19.2`, and that future bumps still need the client re-checked for node-API changes. Keep the rule's `matchPackageNames`, `groupName`, and flags unchanged.

- [ ] **Step 2: Validate the JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('renovate.json','utf8')); console.log('valid')"
```
Expected: `valid`.

- [ ] **Step 3: Commit**

```bash
git add renovate.json
git commit -m "chore(renovate): record tsx-based drive-sdk unblock

Claude-Session: https://claude.ai/code/session_01HSK1VvNGECnzW8zunoschH"
```

---

## Verification checklist (whole plan)

- [ ] `cd server && pnpm typecheck` exits 0.
- [ ] `cd server && pnpm test` is green.
- [ ] Server boots under `node --import tsx src/index.ts` and logs `server listening`.
- [ ] `docker build .` succeeds and the container logs `server listening`.
- [ ] `git log --oneline` shows the atomic commits (runtime switch, dep bump, client rework, renovate note) as separate entries.

## Risks & notes

- **tsx in production** compiles TS on first module load — a one-time boot cost, not per-request. Acceptable for a single-user self-hosted server; revisit Tier 2 (esbuild bundle) only if cold-start or a single compiled artifact becomes a requirement.
- **Full `node_modules` in the runtime image**: the Docker `runtime` stage copies all deps (incl. dev) from `deps`, so `tsx` is present. If image size later matters, split a prod-only install that still includes `tsx`.
- **Deprecated `iterateFolderChildren`**: kept to minimize the rework. A later change can migrate to `iterateFolderChildrenNodeUids` + `iterateNodes` if the deprecated method is removed upstream.
- **`.npmrc` `ignore-scripts=true`**: `core-js` (transitive via the crypto peer) normally has a postinstall; it is skipped by policy and `core-js` functions without it (only its funding notice is suppressed).
