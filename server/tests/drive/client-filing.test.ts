import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as openpgp from 'openpgp';
import { createTestDb } from '../helpers/test-db.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import type { DB } from '../../src/db.js';

// Same SDK-mocking pattern as client-upload.test.ts, extended with the folder
// iteration and creation calls the filing stage relies on.
const { mockSdk, sdkErrors } = vi.hoisted(() => {
  class ProtonDriveError extends Error {}
  class ValidationError extends ProtonDriveError {}
  class NodeWithSameNameExistsValidationError extends ValidationError {
    constructor(message: string, readonly code: number, readonly existingNodeUid?: string) {
      super(message);
    }
  }
  class ServerError extends ProtonDriveError {}
  return {
  sdkErrors: { ProtonDriveError, NodeWithSameNameExistsValidationError, ServerError },
  mockSdk: {
    getMyFilesRootFolder: vi.fn(),
    getAvailableName: vi.fn(),
    getFileUploader: vi.fn(),
    iterateFolderChildrenNodeUids: vi.fn(),
    iterateNodes: vi.fn(),
    createFolder: vi.fn(),
    experimental: { getNodeUrl: vi.fn() },
  },
  };
});

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
  ProtonDriveError: sdkErrors.ProtonDriveError,
  NodeWithSameNameExistsValidationError: sdkErrors.NodeWithSameNameExistsValidationError,
}));

// Imported after the mock is registered (vi.mock is hoisted above imports).
const { DriveClient, FolderNameTakenError } = await import('../../src/drive/client.js');

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

function node(uid: string, type: 'file' | 'folder', name: string, sha1?: string, extra: object = {}) {
  return {
    uid,
    type,
    name: { ok: true, value: name },
    ...extra,
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

  async function withClient<T>(fn: (c: Awaited<ReturnType<typeof makeClient>>) => Promise<T>): Promise<T> {
    const { db, cleanup } = createTestDb();
    try {
      return await fn(await makeClient(db));
    } finally {
      cleanup();
    }
  }

  it('asks the SDK for folders only when looking up a folder', () =>
    withClient(async (client) => {
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['b']));
      mockSdk.iterateNodes.mockReturnValue(gen([node('b', 'folder', 'Water')]));
      await client.findChildFolder('P', 'Water');
      expect(mockSdk.iterateFolderChildrenNodeUids).toHaveBeenCalledWith('P', { type: 'folder' });
    }));

  it('skips trashed, undecryptable and missing entries, and returns null when nothing matches', () =>
    withClient(async (client) => {
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['t', 'u', 'm']));
      mockSdk.iterateNodes.mockReturnValue(
        gen([
          node('t', 'folder', 'Water', undefined, { trashTime: new Date() }),
          { ...node('u', 'folder', 'Water'), name: { ok: false, error: new Error('x') } },
          { missingUid: 'm' },
        ]),
      );
      expect(await client.findChildFolder('P', 'Water')).toBeNull();
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['t']));
      mockSdk.iterateNodes.mockReturnValue(gen([node('t', 'file', 'x.pdf', 'aaa')]));
      expect(await client.findFileBySha1('P', 'zzz')).toBeNull();
    }));

  it('does not fetch nodes for an empty folder', () =>
    withClient(async (client) => {
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen([]));
      expect(await client.findChildFolder('P', 'Water')).toBeNull();
      expect(await client.findFileBySha1('P', 'aaa')).toBeNull();
      expect(mockSdk.iterateNodes).not.toHaveBeenCalled();
    }));

  it('does not match a file that has no revision or SHA-1', () =>
    withClient(async (client) => {
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['x']));
      mockSdk.iterateNodes.mockReturnValue(gen([node('x', 'file', 'Bill.pdf')]));
      expect(await client.findFileBySha1('P', 'undefined')).toBeNull();
    }));

  it('matches folder names across Unicode normalisation forms, case-sensitively', () =>
    withClient(async (client) => {
      const nfd = 'Cafe\u0301';
      mockSdk.iterateFolderChildrenNodeUids.mockImplementation(() => gen(['a']));
      mockSdk.iterateNodes.mockImplementation(() => gen([node('a', 'folder', nfd)]));
      expect(await client.findChildFolder('P', 'Caf\u00e9')).toBe('a');
      expect(await client.findChildFolder('P', 'caf\u00e9')).toBeNull();
    }));

  it('turns a name clash into FolderNameTakenError carrying the existing uid', () =>
    withClient(async (client) => {
      mockSdk.createFolder.mockRejectedValue(new sdkErrors.NodeWithSameNameExistsValidationError('exists', 2500, 'N7'));
      const err = await client.createFolder('P', 'Water').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FolderNameTakenError);
      expect((err as InstanceType<typeof FolderNameTakenError>).existingNodeUid).toBe('N7');
    }));

  it('propagates other createFolder errors', () =>
    withClient(async (client) => {
      mockSdk.createFolder.mockRejectedValue(new Error('boom'));
      await expect(client.createFolder('P', 'Water')).rejects.toThrow('boom');
    }));

  it('tolerates the SDK reporting unloadable siblings, keeping what it yielded', () =>
    withClient(async (client) => {
      mockSdk.iterateFolderChildrenNodeUids.mockImplementation(() => gen(['a', 'b']));
      async function* partial() {
        yield node('a', 'folder', 'Water');
        throw new sdkErrors.ProtonDriveError('Some items could not be loaded');
      }
      mockSdk.iterateNodes.mockImplementation(() => partial());
      expect(await client.findChildFolder('P', 'Water')).toBe('a');
      expect(await client.findChildFolder('P', 'Gas')).toBeNull();
    }));

  it('lets subclasses of ProtonDriveError (e.g. ServerError) propagate', () =>
    withClient(async (client) => {
      mockSdk.iterateFolderChildrenNodeUids.mockReturnValue(gen(['a']));
      async function* failing() {
        throw new sdkErrors.ServerError('401');
        yield node('a', 'folder', 'Water');
      }
      mockSdk.iterateNodes.mockReturnValue(failing());
      await expect(client.findChildFolder('P', 'Water')).rejects.toBeInstanceOf(sdkErrors.ServerError);
    }));
});
