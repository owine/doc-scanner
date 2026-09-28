import { describe, it, expect, vi } from 'vitest';
import { FolderCache } from '../../src/drive/folder-cache.js';

// `name: null` stands in for a name the SDK could not decrypt.
interface FakeNode { uid: string; name: string | null; type: string; }

// drive-sdk >= 0.17 returns nodes unwrapped, with `name` itself a Result.
function toSdkNode(n: FakeNode) {
  return {
    uid: n.uid,
    type: n.type,
    name: n.name === null ? { ok: false as const, error: new Error('undecryptable') } : { ok: true as const, value: n.name },
  };
}

function fakeSdk(tree: Record<string, FakeNode[]>) {
  async function* iter(uid: string) {
    for (const child of tree[uid] ?? []) yield toSdkNode(child);
  }
  return {
    getMyFilesRootFolder: vi.fn().mockResolvedValue(toSdkNode({ uid: 'root', name: 'My Files', type: 'folder' })),
    iterateFolderChildren: iter,
  };
}

describe('FolderCache', () => {
  it('returns just the root path when no subfolders exist', async () => {
    const cache = new FolderCache(fakeSdk({}) as never);
    await cache.refresh();
    expect(cache.getTree()).toEqual([{ linkId: 'root', path: '/' }]);
  });

  it('returns root + two top-level folders in walk order', async () => {
    const cache = new FolderCache(fakeSdk({
      root: [
        { uid: 'f-tax', name: 'Tax', type: 'folder' },
        { uid: 'f-recipes', name: 'Recipes', type: 'folder' },
      ],
    }) as never);
    await cache.refresh();
    expect(cache.getTree()).toEqual([
      { linkId: 'root', path: '/' },
      { linkId: 'f-tax', path: '/Tax' },
      { linkId: 'f-recipes', path: '/Recipes' },
    ]);
  });

  it('walks nested folders depth-first, parent before children', async () => {
    const cache = new FolderCache(fakeSdk({
      root: [
        { uid: 'f-tax', name: 'Tax', type: 'folder' },
        { uid: 'f-recipes', name: 'Recipes', type: 'folder' },
      ],
      'f-tax': [
        { uid: 'f-2025', name: '2025', type: 'folder' },
        { uid: 'f-2026', name: '2026', type: 'folder' },
      ],
      'f-2025': [{ uid: 'f-q1', name: 'Q1', type: 'folder' }],
    }) as never);
    await cache.refresh();
    expect(cache.getTree()).toEqual([
      { linkId: 'root', path: '/' },
      { linkId: 'f-tax', path: '/Tax' },
      { linkId: 'f-2025', path: '/Tax/2025' },
      { linkId: 'f-q1', path: '/Tax/2025/Q1' },
      { linkId: 'f-2026', path: '/Tax/2026' },
      { linkId: 'f-recipes', path: '/Recipes' },
    ]);
  });

  it('skips files (type !== "folder") at every level', async () => {
    const cache = new FolderCache(fakeSdk({
      root: [
        { uid: 'f-tax', name: 'Tax', type: 'folder' },
        { uid: 'file-readme', name: 'README.md', type: 'file' },
      ],
      'f-tax': [
        { uid: 'file-w2', name: 'W2.pdf', type: 'file' },
        { uid: 'f-2026', name: '2026', type: 'folder' },
      ],
    }) as never);
    await cache.refresh();
    expect(cache.getTree()).toEqual([
      { linkId: 'root', path: '/' },
      { linkId: 'f-tax', path: '/Tax' },
      { linkId: 'f-2026', path: '/Tax/2026' },
    ]);
  });

  it('skips a folder with an undecryptable name, along with its subtree', async () => {
    const cache = new FolderCache(fakeSdk({
      root: [
        { uid: 'f-bad', name: null, type: 'folder' },
        { uid: 'f-tax', name: 'Tax', type: 'folder' },
      ],
      'f-bad': [{ uid: 'f-hidden', name: 'Hidden', type: 'folder' }],
    }) as never);
    await cache.refresh();
    expect(cache.getTree()).toEqual([
      { linkId: 'root', path: '/' },
      { linkId: 'f-tax', path: '/Tax' },
    ]);
  });

  it('refresh() replaces (not appends) on second call', async () => {
    const sdk1 = fakeSdk({
      root: [{ uid: 'f-old', name: 'OldFolder', type: 'folder' }],
    });
    const cache = new FolderCache(sdk1 as never);
    await cache.refresh();
    expect(cache.getTree()).toHaveLength(2);

    // Re-point the same cache instance at a different tree shape.
    const sdk2 = fakeSdk({
      root: [
        { uid: 'f-new1', name: 'New1', type: 'folder' },
        { uid: 'f-new2', name: 'New2', type: 'folder' },
      ],
    });
    (cache as unknown as { sdk: typeof sdk2 }).sdk = sdk2;
    await cache.refresh();

    expect(cache.getTree()).toEqual([
      { linkId: 'root', path: '/' },
      { linkId: 'f-new1', path: '/New1' },
      { linkId: 'f-new2', path: '/New2' },
    ]);
  });
});
