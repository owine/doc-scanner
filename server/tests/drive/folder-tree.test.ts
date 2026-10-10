import { describe, it, expect } from 'vitest';
import { NodeType } from '@protontech/drive-sdk';
import { toFolderContexts, walkFolderTree, type TreeSdk } from '../../src/drive/folder-tree.js';

interface FakeNode {
  uid: string;
  parent: string;
  type: NodeType;
  name: string | null;
  modified?: string;
  trashed?: boolean;
}

function fakeSdk(nodes: FakeNode[]): TreeSdk {
  const byUid = new Map(nodes.map((n) => [n.uid, n]));
  const toEntity = (n: FakeNode) => ({
    uid: n.uid,
    type: n.type,
    name: n.name === null ? { ok: false, error: new Error('undecryptable') } : { ok: true, value: n.name },
    modificationTime: new Date(n.modified ?? '2026-01-01'),
    trashTime: n.trashed ? new Date() : undefined,
    mediaType: n.type === NodeType.File ? 'application/pdf' : undefined,
  });
  return {
    getMyFilesRootFolder: async () => toEntity({ uid: 'root', parent: '', type: NodeType.Folder, name: 'root' }),
    async *iterateFolderChildrenNodeUids(parent: string) {
      for (const n of nodes) if (n.parent === parent) yield n.uid;
    },
    async *iterateNodes(uids: string[]) {
      for (const uid of uids) yield toEntity(byUid.get(uid)!);
    },
  } as unknown as TreeSdk;
}

const nodes: FakeNode[] = [
  { uid: 'bills', parent: 'root', type: NodeType.Folder, name: 'Bills' },
  { uid: 'f1', parent: 'root', type: NodeType.File, name: 'loose.pdf' },
  { uid: 'northwind', parent: 'bills', type: NodeType.Folder, name: 'Northwind Energy' },
  { uid: 'c1', parent: 'northwind', type: NodeType.File, name: 'Northwind Energy Jul 2026.pdf', modified: '2026-07-05' },
  { uid: 'c2', parent: 'northwind', type: NodeType.File, name: 'Northwind Energy Sep 2026.pdf', modified: '2026-09-05' },
  { uid: 'c3', parent: 'northwind', type: NodeType.File, name: 'Northwind Energy Aug 2026.pdf', modified: '2026-08-05' },
  { uid: 'gone', parent: 'northwind', type: NodeType.File, name: 'trashed.pdf', trashed: true },
  { uid: 'secret', parent: 'root', type: NodeType.Folder, name: null },
  { uid: 's1', parent: 'secret', type: NodeType.File, name: 'inside.pdf' },
];

describe('walkFolderTree', () => {
  it('returns folders depth-first with their files, skipping trashed and undecryptable nodes', async () => {
    const tree = await walkFolderTree(fakeSdk(nodes));
    expect(tree.map((f) => f.path)).toEqual(['/', '/Bills', '/Bills/Northwind Energy']);
    expect(tree[0].files.map((f) => f.name)).toEqual(['loose.pdf']);
    expect(tree[2].files.map((f) => f.uid).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('toFolderContexts', () => {
  it('lists the most recent names first, without extensions', async () => {
    const ctx = toFolderContexts(await walkFolderTree(fakeSdk(nodes)), { perFolder: 2 });
    expect(ctx.find((f) => f.path === '/Bills/Northwind Energy')?.recentNames).toEqual(['Northwind Energy Sep 2026', 'Northwind Energy Aug 2026']);
  });

  it('hides excluded files so a document never sees its own name', async () => {
    const ctx = toFolderContexts(await walkFolderTree(fakeSdk(nodes)), { excludeFileUids: new Set(['c2']) });
    expect(ctx.find((f) => f.path === '/Bills/Northwind Energy')?.recentNames).toEqual(['Northwind Energy Aug 2026', 'Northwind Energy Jul 2026']);
  });
});
