import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, ANALYSIS, TREE } from './harness.js';
import { currentAnchorFolder, snapshotAnchor } from '../../src/documents/anchor.js';
import type { Anchor, DocumentPatch, DocumentState } from '../../src/documents/types.js';

let h: ReturnType<typeof makeHarness> | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function row(to: DocumentState, patch: DocumentPatch = {}) {
  h ??= makeHarness();
  const doc = h.add();
  h.repo.transition(doc.id, 'received', to, patch);
  return h.repo.get(doc.id)!;
}

const NEW = { kind: 'new' as const, parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Certified' };

describe('snapshotAnchor', () => {
  it('takes a filed document\'s name without extension and the folder it was filed in', () => {
    const a = row('filed', {
      filingTarget: { folderLinkId: 'BILLS', name: 'Certified letter.pdf' },
      filedName: 'Certified letter (1).pdf',
      filedFolderPath: '/Bills',
    });
    expect(snapshotAnchor(a)).toEqual({ documentId: a.id, name: 'Certified letter (1)', folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } });
  });

  it('refuses a filed document without its filing target', () => {
    expect(snapshotAnchor(row('filed', { filedName: 'x.pdf', filedFolderPath: '/Bills' }))).toBeNull();
  });

  it('takes a document in review\'s decision before its analysis', () => {
    expect(snapshotAnchor(row('needs_review', { analysis: ANALYSIS }))).toMatchObject({ name: ANALYSIS.name, folder: ANALYSIS.folder });
    const decided = row('needs_review', { analysis: ANALYSIS, decision: { name: 'Edited', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } } });
    expect(snapshotAnchor(decided)).toMatchObject({ name: 'Edited', folder: { kind: 'existing', linkId: 'ROOT', path: '/' } });
  });

  it('keeps a proposed new folder, and treats one already created as existing', () => {
    expect(snapshotAnchor(row('needs_review', { analysis: { ...ANALYSIS, folder: NEW } }))?.folder).toEqual(NEW);
    const created = row('needs_review', { analysis: ANALYSIS, decision: { name: 'n', folder: { ...NEW, createdLinkId: 'CERT' } } });
    expect(snapshotAnchor(created)?.folder).toEqual({ kind: 'existing', linkId: 'CERT', path: '/Bills/Certified' });
  });

  it('refuses one in review with no name or folder, and any other state', () => {
    expect(snapshotAnchor(row('needs_review'))).toBeNull();
    expect(snapshotAnchor(row('needs_review', { analysis: { ...ANALYSIS, folder: null } }))).toBeNull();
    expect(snapshotAnchor(row('received', { analysis: ANALYSIS }))).toBeNull();
    expect(snapshotAnchor(row('discarded', { analysis: ANALYSIS, discardedAt: new Date() }))).toBeNull();
  });
});

describe('currentAnchorFolder', () => {
  const anchor = (folder: Anchor['folder']): Anchor => ({ documentId: 'a', name: 'n', folder });
  const EXCLUDE = ['/Archive'];

  it('takes an existing folder\'s current path', () => {
    const renamed = TREE.map((f) => (f.linkId === 'BILLS' ? { ...f, path: '/Household/Bills' } : f));
    expect(currentAnchorFolder(anchor({ kind: 'existing', linkId: 'BILLS', path: '/Bills' }), renamed, EXCLUDE)).toEqual({
      kind: 'existing',
      linkId: 'BILLS',
      path: '/Household/Bills',
    });
  });

  it('is null for a folder that is gone or now never-file-here', () => {
    expect(currentAnchorFolder(anchor({ kind: 'existing', linkId: 'GONE', path: '/Gone' }), TREE, EXCLUDE)).toBeNull();
    expect(currentAnchorFolder(anchor({ kind: 'existing', linkId: 'ARCHIVE', path: '/Archive' }), TREE, EXCLUDE)).toBeNull();
  });

  it('checks a new folder by its parent, and where it would be', () => {
    expect(currentAnchorFolder(anchor(NEW), TREE, EXCLUDE)).toEqual(NEW);
    expect(currentAnchorFolder(anchor({ ...NEW, parentLinkId: 'GONE' }), TREE, EXCLUDE)).toBeNull();
    expect(currentAnchorFolder(anchor({ ...NEW, parentLinkId: 'ARCHIVE', parentPath: '/Archive' }), TREE, EXCLUDE)).toBeNull();
  });
});
