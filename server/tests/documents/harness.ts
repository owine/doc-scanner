import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { DocumentRepo } from '../../src/documents/repo.js';
import { InboxStore } from '../../src/documents/inbox-store.js';
import { FolderCacheStore } from '../../src/drive/folder-cache-store.js';
import { SettingsStore, type EffectiveSettings } from '../../src/settings/settings-store.js';
import type { StageContext } from '../../src/documents/deps.js';
import type { Analysis, AnalyzeOutcome } from '../../src/analyze/types.js';
import type { LiveSession } from '../../src/auth/live-session.js';
import type { TreeFolder } from '../../src/drive/folder-tree.js';

export const KEY = Buffer.alloc(32, 9).toString('base64');

export const TREE: TreeFolder[] = [
  { linkId: 'ROOT', path: '/', files: [] },
  { linkId: 'BILLS', path: '/Bills', files: [{ uid: 'f1', name: 'Northwind Energy Aug 2026.pdf', modified: new Date('2026-08-05') }] },
  { linkId: 'ARCHIVE', path: '/Archive', files: [] },
];

export const ANALYSIS: Analysis = {
  name: 'Northwind Energy Sep 2026',
  folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' },
  confidence: 0.92,
  rationale: 'A monthly utility bill.',
  isDocument: true,
  textSnippet: 'Northwind Energy statement September 2026',
};

export const okOutcome = (analysis: Analysis = ANALYSIS): AnalyzeOutcome => ({
  status: 'ok',
  analysis,
  model: 'claude-haiku-5-5',
  usage: { input_tokens: 100, output_tokens: 10 } as AnalyzeOutcome['usage'],
  stopReason: 'end_turn',
});

export function fakeDrive() {
  return {
    uploadFile: vi.fn().mockResolvedValue({ nodeUid: 'NODE1', driveUrl: 'https://drive.example/NODE1', name: 'Northwind Energy Sep 2026.pdf' }),
    findChildFolder: vi.fn().mockResolvedValue(null),
    createFolder: vi.fn().mockResolvedValue('NEWFOLDER'),
    findFileBySha1: vi.fn().mockResolvedValue(null),
    walkFolderTree: vi.fn().mockResolvedValue(TREE),
  };
}

export function makeHarness(opts: { settings?: Partial<EffectiveSettings>; withTree?: boolean } = {}) {
  const { db, cleanup: dbCleanup } = createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
  let clock = new Date('2026-10-10T12:00:00Z');
  const now = () => clock;
  const repo = new DocumentRepo(db, now);
  const inbox = new InboxStore(join(dir, 'inbox'), new AtRestCipher(KEY, 'inbox'));
  const folderCache = new FolderCacheStore(db, new AtRestCipher(KEY, 'folder-cache'));
  if (opts.withTree !== false) folderCache.save(TREE, clock);
  const settings = new SettingsStore(db, {
    model: 'claude-haiku-5-5',
    effort: 'medium',
    autoFileThreshold: 0.8,
    autoFileEnabled: true,
    excludePaths: ['/Archive'],
    ...opts.settings,
  });
  const analyze = vi.fn().mockResolvedValue(okOutcome());
  const drive = fakeDrive();
  let live: LiveSession | undefined = { sid: 's', driveClient: drive } as unknown as LiveSession;
  const report = vi.fn();
  const refreshFolderCache = vi.fn().mockResolvedValue(undefined);

  const ctx: StageContext = {
    db,
    repo,
    inbox,
    settings,
    folderCache,
    analyzerFor: () => ({ analyze }),
    liveSession: () => live,
    now,
    report,
    refreshFolderCache,
  };

  return {
    ctx,
    db,
    repo,
    inbox,
    analyze,
    drive,
    report,
    refreshFolderCache,
    setLive: (l: LiveSession | undefined) => (live = l),
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    /** A received document with its bytes in the inbox. */
    add(bytes = new TextEncoder().encode('Northwind Energy statement'), mime = 'text/plain') {
      const doc = repo.insert({ source: 'picker', originalName: 'statement.txt', mime, size: bytes.length, sha256: String(Math.random()), sourceContext: null });
      inbox.put(doc.id, 'original', bytes);
      return doc;
    },
    cleanup() {
      dbCleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
