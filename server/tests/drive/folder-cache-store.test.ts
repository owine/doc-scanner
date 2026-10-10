import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { FolderCacheStore } from '../../src/drive/folder-cache-store.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe('FolderCacheStore', () => {
  it('keeps only each folder\'s five most recent files, and only their uid, name and date', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    const files = Array.from({ length: 8 }, (_, i) => ({
      uid: `F${i}`,
      name: `Statement ${i}.pdf`,
      mediaType: 'application/pdf',
      size: 100,
      modified: new Date(Date.UTC(2026, 0, i + 1)),
    }));
    s.save([{ linkId: 'L', path: '/Bills', files }], new Date());
    const kept = s.load()!.tree[0].files;
    expect(kept.map((f) => f.uid)).toEqual(['F7', 'F6', 'F5', 'F4', 'F3']);
    expect(Object.keys(kept[0]).sort()).toEqual(['modified', 'name', 'uid']);
  });

  it('records a filing in the cached folder, so the next document sees the name', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    s.save([{ linkId: 'L', path: '/Bills', files: [] }], new Date());
    s.recordFiled('L', { uid: 'N1', name: 'Northwind Energy Oct 2026.pdf', modified: new Date('2026-10-10T00:00:00Z') });
    s.recordFiled('MISSING', { uid: 'N2', name: 'x.pdf', modified: new Date() });
    expect(s.load()!.tree[0].files.map((f) => f.name)).toEqual(['Northwind Energy Oct 2026.pdf']);
  });

  it('adds a newly created folder with its filed file, keeping paths sorted', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    const walked = new Date('2026-10-01T00:00:00Z');
    s.save([{ linkId: 'R', path: '/', files: [] }, { linkId: 'L', path: '/Bills', files: [] }, { linkId: 'T', path: '/Tax', files: [] }], walked);
    const file = { uid: 'N1', name: 'Water Sep 2026.pdf', modified: new Date('2026-10-10T00:00:00Z') };
    s.addFolder({ linkId: 'W', path: '/Bills/Water' }, file);
    const cached = s.load()!;
    expect(cached.tree.map((f) => f.path)).toEqual(['/', '/Bills', '/Bills/Water', '/Tax']);
    expect(cached.tree[2]).toEqual({ linkId: 'W', path: '/Bills/Water', files: [file] });
    expect(cached.walkedAt).toEqual(walked);
    // Already there (a walk found it first): the file is recorded, the folder not duplicated.
    s.addFolder({ linkId: 'W', path: '/Bills/Water' }, { ...file, uid: 'N2', name: 'Water Oct 2026.pdf' });
    expect(s.load()!.tree.filter((f) => f.linkId === 'W')[0]!.files.map((f) => f.uid)).toEqual(['N2', 'N1']);
  });

  it('adds nothing when no tree is cached yet', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    s.addFolder({ linkId: 'W', path: '/Bills/Water' }, { uid: 'N1', name: 'x.pdf', modified: new Date() });
    expect(s.load()).toBeNull();
  });

  it('round-trips the tree, encrypted, with dates restored', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    expect(s.load()).toBeNull();
    const tree = [{ linkId: 'L', path: '/Bills', files: [{ uid: 'F', name: 'Northwind Energy Sep 2026.pdf', modified: new Date('2026-09-05T00:00:00Z') }] }];
    s.save(tree, new Date('2026-10-10T00:00:00Z'));
    const raw = t.db.prepare('SELECT encrypted_tree FROM folder_cache').get() as { encrypted_tree: Uint8Array };
    expect(Buffer.from(raw.encrypted_tree).includes('Northwind')).toBe(false);
    const loaded = s.load()!;
    expect(loaded.tree[0].files[0].modified).toBeInstanceOf(Date);
    expect(loaded.tree[0].files[0].modified.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(loaded.walkedAt.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('treats a cache sealed with another key as absent and removes it', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const other = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 9).toString('base64'), 'folder-cache'));
    other.save([{ linkId: 'L', path: '/Bills', files: [] }], new Date());
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    expect(s.load()).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM folder_cache').get()).toEqual({ n: 0 });
  });

  it('keeps one entry when the same uid is filed twice', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    s.save([{ linkId: 'L', path: '/Bills', files: [] }], new Date());
    s.recordFiled('L', { uid: 'N1', name: 'a.pdf', modified: new Date('2026-10-10T00:00:00Z') });
    s.recordFiled('L', { uid: 'N1', name: 'a.pdf', modified: new Date('2026-10-10T00:00:00Z') });
    expect(s.load()!.tree[0].files).toHaveLength(1);
  });

  it('evicts the oldest file when filing into a full folder', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    const files = Array.from({ length: 5 }, (_, i) => ({ uid: `F${i}`, name: `s${i}.pdf`, modified: new Date(Date.UTC(2026, 0, i + 1)) }));
    s.save([{ linkId: 'L', path: '/Bills', files }], new Date());
    s.recordFiled('L', { uid: 'N', name: 'new.pdf', modified: new Date('2026-10-10T00:00:00Z') });
    expect(s.load()!.tree[0].files.map((f) => f.uid)).toEqual(['N', 'F4', 'F3', 'F2', 'F1']);
  });

  it('keeps the walk time when a filing is recorded', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    s.save([{ linkId: 'L', path: '/Bills', files: [] }], new Date('2026-10-01T00:00:00Z'));
    s.recordFiled('L', { uid: 'N', name: 'a.pdf', modified: new Date() });
    expect(s.load()!.walkedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('ranks a file with an invalid date last instead of failing', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const s = new FolderCacheStore(t.db, new AtRestCipher(Buffer.alloc(32, 4).toString('base64'), 'folder-cache'));
    const files = Array.from({ length: 5 }, (_, i) => ({ uid: `F${i}`, name: `s${i}.pdf`, modified: new Date(Date.UTC(2026, 0, i + 1)) }));
    files.push({ uid: 'BAD', name: 'bad.pdf', modified: new Date('nope') });
    s.save([{ linkId: 'L', path: '/Bills', files }], new Date());
    expect(s.load()!.tree[0].files.map((f) => f.uid)).toEqual(['F4', 'F3', 'F2', 'F1', 'F0']);
  });
});
