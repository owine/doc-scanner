/// <reference types="node" />
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
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
