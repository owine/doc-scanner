import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import { createTestDb } from '../helpers/test-db.js';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import type { DB } from '../../src/db.js';

// Same seam as client-upload.test.ts: stub ProtonDriveClient only, so the
// real DriveClient facade (and its failure reporting) runs against it.
const { mockSdk, sdkConfigs } = vi.hoisted(() => ({
  mockSdk: {
    getMyFilesRootFolder: vi.fn(),
    getAvailableName: vi.fn(),
    getFileUploader: vi.fn(),
    experimental: { getNodeUrl: vi.fn() },
  },
  sdkConfigs: [] as Array<{ httpClient: { fetchJson: (req: unknown) => Promise<Response> } }>,
}));

vi.mock('@protontech/drive-sdk', () => ({
  ProtonDriveClient: vi.fn(function (config: (typeof sdkConfigs)[number]) {
    sdkConfigs.push(config);
    return mockSdk;
  }),
  NullFeatureFlagProvider: vi.fn(),
  OpenPGPCryptoWithCryptoProxy: vi.fn(),
}));

const { DriveClient } = await import('../../src/drive/client.js');

const { events } = initRecordingSentry();

// Built at runtime so the value never appears in this file's source (the
// ContextLines integration attaches source lines around stack frames).
const nameCore = ['Tax', 'Return'].join(' ');
const docName = `${nameCore} ${Date.now()}.pdf`;

async function makeClient(db: DB, protonAuth?: ProtonAuth) {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'x@y.test' }], passphrase: 'p', format: 'object',
  });
  const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  return new DriveClient({
    db,
    encryptionKey: Buffer.alloc(32, 1).toString('base64'),
    appVersion: 'external-drive-docscanner@0.1.0',
    user: {
      primaryAddress: { email: 'x@y.test', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [{ email: 'x@y.test', addressId: 'a1', keys: [{ id: 'k1', key: decrypted }], primaryKeyIndex: 0 }],
    },
    session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'x@y.test' },
    protonAuth: protonAuth ?? new ProtonAuth(new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0')),
  });
}

function tagsOf(index: number): Record<string, unknown> | undefined {
  return events[index]?.tags as Record<string, unknown> | undefined;
}

describe('Drive failure reporting', () => {
  let db: DB;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    sdkConfigs.length = 0;
    ({ db, cleanup } = createTestDb());
    mockSdk.getMyFilesRootFolder.mockResolvedValue({ uid: 'root-uid', name: { ok: true, value: 'My files' } });
    mockSdk.getAvailableName.mockImplementation(async (_root: string, name: string) => name);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reports one event tagged upload when the upload itself fails', async () => {
    mockSdk.getFileUploader.mockResolvedValue({
      uploadFromStream: vi.fn().mockRejectedValue(new Error('block upload rejected')),
    });
    const client = await makeClient(db);

    await expect(client.uploadFile(docName, new Uint8Array([1, 2, 3]), 'application/pdf'))
      .rejects.toThrow('block upload rejected');
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'drive.operation': 'upload' });
    expect(events[0]?.exception?.values?.[0]?.value).toBe('block upload rejected');
  });

  it('reports one event tagged folder-lookup when the root folder cannot be resolved', async () => {
    mockSdk.getMyFilesRootFolder.mockRejectedValue(new Error('volume not found'));
    const client = await makeClient(db);

    await expect(client.uploadFile(docName, new Uint8Array([1]), 'application/pdf')).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'drive.operation': 'folder-lookup' });
  });

  it('redacts the exact document name, even unquoted with spaces', async () => {
    mockSdk.getFileUploader.mockRejectedValue(new Error(`draft for ${docName} already exists`));
    const client = await makeClient(db);

    await expect(client.uploadFile(docName, new Uint8Array([1]), 'application/pdf')).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(nameCore);
  });

  it('does not hand the file bytes to the reporter', async () => {
    const marker = `BYTES-${Math.random().toString(36).slice(2)}`;
    mockSdk.getFileUploader.mockRejectedValue(new Error('quota exceeded'));
    const client = await makeClient(db);

    await expect(client.uploadFile(docName, new TextEncoder().encode(marker), 'application/pdf')).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(marker);
  });

  it('reports one event tagged session-refresh when the token refresh fails', async () => {
    const protonAuth = new ProtonAuth(new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0'));
    vi.spyOn(protonAuth, 'refresh').mockRejectedValue(new Error('refresh token revoked'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"Code":401}', { status: 401 })));
    await makeClient(db, protonAuth);
    const httpClient = sdkConfigs[0]!.httpClient;

    const res = await httpClient.fetchJson({
      url: 'https://drive-api.proton.me/drive/shares', method: 'GET', headers: new Headers(), timeoutMs: 1000,
    });
    await flushEvents();

    // Behaviour is unchanged: the SDK still sees the original 401.
    expect(res.status).toBe(401);
    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'drive.operation': 'session-refresh' });
  });

  it('reports nothing when the upload succeeds', async () => {
    mockSdk.getFileUploader.mockResolvedValue({
      uploadFromStream: vi.fn().mockResolvedValue({
        completion: vi.fn().mockResolvedValue({ nodeUid: 'node-1', nodeRevisionUid: 'rev-1' }),
      }),
    });
    mockSdk.experimental.getNodeUrl.mockRejectedValue(new Error('no url'));
    const client = await makeClient(db);

    await client.uploadFile(docName, new Uint8Array([1]), 'application/pdf');
    await flushEvents();

    // Includes the swallowed getNodeUrl failure: it has a fallback, so it is
    // not a lost document and must not page anyone.
    expect(events).toHaveLength(0);
  });
});
