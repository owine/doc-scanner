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

// Reset IndexedDB to a fresh factory before each test so tests are fully isolated.
// This prevents state from leaking between tests when a prior test's IDB connection is still open.
beforeEach(() => {
  globalThis.indexedDB = new FakeIDBFactory();
});
