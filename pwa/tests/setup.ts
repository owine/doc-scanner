/// <reference types="node" />
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/preact';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'buffer';

// Restore Node.js native Blob so structuredClone (used by fake-indexeddb) works correctly.
// happy-dom replaces globalThis.Blob with its own implementation which is not structured-clone
// compatible, causing Blob objects to be serialized as plain Objects when stored in IndexedDB.
(globalThis as any).Blob = NodeBlob;

// happy-dom >=20.10.2 defines createImageBitmap, but its implementation rejects the
// Blob it receives AND emits an *internal* unhandled promise rejection that escapes
// makeThumbnail()'s try/catch. That leaked rejection intermittently fails the whole
// run (Vitest: "caught 1 unhandled error"). Thumbnail generation is best-effort and
// intentionally no-ops in tests, so remove the broken global to force the guard in
// makeThumbnail() to short-circuit to the source blob. The one test that exercises the
// throwing path installs and restores its own createImageBitmap stub.
// Delete (rather than assign undefined) so the global is genuinely absent, matching the
// pre-regression world the makeThumbnail() guard was written for; happy-dom defines it as
// an own, configurable property so this removes it cleanly with no prototype fallback.
delete (globalThis as any).createImageBitmap;

// Reset IndexedDB to a fresh factory before each test so tests are fully isolated.
// This prevents state from leaking between tests when a prior test's IDB connection is still open.
beforeEach(() => {
  globalThis.indexedDB = new FakeIDBFactory();
});

// Unmount rendered trees after every test. @testing-library/preact only self-registers
// its auto-cleanup when `afterEach` is a global, and this project deliberately runs
// without `globals: true` — so without this, nothing ever unmounts the *last* tree in a
// file (a `beforeEach(cleanup)` only cleans up before the next test, never after the
// final one). A left-mounted tree turns any late setState from a still-pending promise
// into a real Preact DOM diff against a torn-down happy-dom, surfacing as an
// unhandled "ReferenceError: document is not defined" that fails the whole run.
afterEach(() => {
  cleanup();
});
