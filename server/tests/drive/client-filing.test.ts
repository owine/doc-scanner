import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as openpgp from 'openpgp';
import { createTestDb } from '../helpers/test-db.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import type { DB } from '../../src/db.js';

// Same SDK-mocking pattern as client-upload.test.ts, extended with the folder
// iteration and creation calls the filing stage relies on.
const { mockSdk } = vi.hoisted(() => ({
  mockSdk: {
    getMyFilesRootFolder: vi.fn(),
    getAvailableName: vi.fn(),
    getFileUploader: vi.fn(),
    iterateFolderChildrenNodeUids: vi.fn(),
    iterateNodes: vi.fn(),
    createFolder: vi.fn(),
    experimental: { getNodeUrl: vi.fn() },
  },
}));

// Stub the three value exports the DriveClient graph pulls from the SDK root.
// We deliberately do NOT importActual: that would load the real SDK, whose
// crypto peer ships raw .ts that vitest's loader can't type-strip. uploadFile
// only touches ProtonDriveClient (mocked below); the crypto module and feature
// flag provider are constructed but never exercised on this path.
vi.mock('@protontech/drive-sdk', () => ({
  // Regular function (not an arrow) so `new ProtonDriveClient(...)` works —
  // returning an object from a constructor call yields that object.
  ProtonDriveClient: vi.fn(function () {
    return mockSdk;
  }),
  NullFeatureFlagProvider: vi.fn(),
  OpenPGPCryptoWithCryptoProxy: vi.fn(),
  NodeType: { File: 'file', Folder: 'folder' },
}));

// Imported after the mock is registered (vi.mock is hoisted above imports).
const { DriveClient } = await import('../../src/drive/client.js');

async function makeClient(db: DB) {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ email: 'x@y.test' }],
    passphrase: 'p',
    format: 'object',
  });
  const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  const protonAuth = new ProtonAuth(
    new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0'),
  );
  return new DriveClient({
    db,
    encryptionKey: Buffer.alloc(32, 1).toString('base64'),
    appVersion: 'external-drive-docscanner@0.1.0',
    user: {
      primaryAddress: { email: 'x@y.test', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [
        { email: 'x@y.test', addressId: 'a1', keys: [{ id: 'k1', key: decrypted }], primaryKeyIndex: 0 },
      ],
    },
    session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'x@y.test' },
    protonAuth,
  });
}

async function* gen<T>(items: T[]) {
  for (const i of items) yield i;
}

function node(uid: string, type: 'file' | 'folder', name: string, sha1?: string) {
  return {
    uid,
    type,
    name: { ok: true, value: name },
    activeRevision: sha1 ? { claimedDigests: { sha1, sha1Verified: false } } : undefined,
  };
}

describe('DriveClient filing helpers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads into the given folder instead of the root', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      mockSdk.getAvailableName.mockResolvedValue('Bill.pdf');
      mockSdk.getFileUploader.mockResolvedValue({
        uploadFromStream: vi.fn().mockResolvedValue({ completion: () => Promise.resolve({ nodeUid: 'N1' }) }),
      });
      mockSdk.experimental.getNodeUrl.mockResolvedValue('https://drive.example/N1');
      const res = await client.uploadFile('Bill.pdf', new Uint8Array([1]), 'application/pdf', { parentFolderUid: 'F9' });
      expect(mockSdk.getMyFilesRootFolder).not.toHaveBeenCalled();
      expect(mockSdk.getAvailableName).toHaveBeenCalledWith('F9', 'Bill.pdf');
      expect(mockSdk.getFileUploader.mock.calls[0]![0]).toBe('F9');
      expect(res).toMatchObject({ nodeUid: 'N1', name: 'Bill.pdf' });
    } finally {
      cleanup();
    }
  });

  it('finds a child folder by name', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['a', 'b']));
      mockSdk.iterateNodes.mockReturnValue(gen([node('a', 'file', 'Water'), node('b', 'folder', 'Water')]));
      expect(await client.findChildFolder('P', 'Water')).toBe('b');
    } finally {
      cleanup();
    }
  });

  it('creates a folder and returns its uid', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      mockSdk.createFolder.mockResolvedValue({ uid: 'NEW' });
      expect(await client.createFolder('P', 'Water')).toBe('NEW');
      expect(mockSdk.createFolder).toHaveBeenCalledWith('P', 'Water');
    } finally {
      cleanup();
    }
  });

  it('finds a file in a folder by its claimed SHA-1', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['x', 'y']));
      mockSdk.iterateNodes.mockReturnValue(
        gen([node('x', 'file', 'Other.pdf', 'aaa'), node('y', 'file', 'Bill.pdf', 'bbb')]),
      );
      expect(await client.findFileBySha1('P', 'bbb')).toEqual({ uid: 'y', name: 'Bill.pdf' });
    } finally {
      cleanup();
    }
  });
});
