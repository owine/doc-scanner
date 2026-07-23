import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import { createTestDb } from '../helpers/test-db.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import type { DB } from '../../src/db.js';

// Stub only ProtonDriveClient so we can drive uploadFile deterministically;
// everything else the real DriveClient wires (crypto module, feature flags)
// comes from the actual SDK. This test lives in its own file so the module
// mock does not weaken client.test.ts's real-construction check.
const { mockSdk } = vi.hoisted(() => ({
  mockSdk: {
    getMyFilesRootFolder: vi.fn(),
    getAvailableName: vi.fn(),
    getFileUploader: vi.fn(),
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

describe('DriveClient.uploadFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSdk.getMyFilesRootFolder.mockResolvedValue({
      uid: 'root-uid',
      name: { ok: true, value: 'My files' },
    });
    // Simulate a name collision: the SDK hands back a de-duplicated name.
    mockSdk.getAvailableName.mockResolvedValue('scan (1).pdf');
    mockSdk.getFileUploader.mockResolvedValue({
      uploadFromStream: vi.fn().mockResolvedValue({
        completion: vi.fn().mockResolvedValue({ nodeUid: 'node-1', nodeRevisionUid: 'rev-1' }),
      }),
    });
    mockSdk.experimental.getNodeUrl.mockResolvedValue('https://drive.proton.me/node-1');
  });

  it('resolves a collision-free name and uploads under it', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      const result = await client.uploadFile('scan.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');

      expect(mockSdk.getAvailableName).toHaveBeenCalledWith('root-uid', 'scan.pdf');
      expect(mockSdk.getFileUploader).toHaveBeenCalledWith(
        'root-uid',
        'scan (1).pdf',
        expect.anything(),
      );
      expect(result.name).toBe('scan (1).pdf');
    } finally {
      cleanup();
    }
  });

  it('sends the SHA-1 of the exact bytes plus size and media type', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      const bytes = new TextEncoder().encode('hello world');
      await client.uploadFile('doc.pdf', bytes, 'application/pdf');

      const metadata = mockSdk.getFileUploader.mock.calls[0]![2] as {
        expectedSha1: string;
        expectedSize: number;
        mediaType: string;
      };
      expect(metadata.expectedSha1).toBe(createHash('sha1').update(bytes).digest('hex'));
      expect(metadata.expectedSize).toBe(bytes.byteLength);
      expect(metadata.mediaType).toBe('application/pdf');
    } finally {
      cleanup();
    }
  });

  it('returns the uploaded node uid and its drive url', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      const result = await client.uploadFile('doc.pdf', new Uint8Array([9]), 'application/pdf');

      expect(result.nodeUid).toBe('node-1');
      expect(result.driveUrl).toBe('https://drive.proton.me/node-1');
      expect(mockSdk.experimental.getNodeUrl).toHaveBeenCalledWith('node-1');
    } finally {
      cleanup();
    }
  });

  it('falls back to a constructed url when getNodeUrl throws', async () => {
    mockSdk.experimental.getNodeUrl.mockRejectedValue(new Error('no url'));
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      const result = await client.uploadFile('doc.pdf', new Uint8Array([9]), 'application/pdf');
      expect(result.driveUrl).toBe('https://drive.proton.me/node-1');
    } finally {
      cleanup();
    }
  });
});
