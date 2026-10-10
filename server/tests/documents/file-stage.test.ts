import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ServerError } from '@protontech/drive-sdk';
import { makeHarness, ANALYSIS, TREE } from './harness.js';
import { fileStage } from '../../src/documents/stages/file.js';
import { FolderNameTakenError } from '../../src/drive/client.js';
import type { Decision } from '../../src/documents/types.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h.cleanup());

const EXISTING: Decision = { name: ANALYSIS.name, folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } };
const NEW: Decision = { name: 'Water Sep 2026', folder: { kind: 'new', parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water' } };

function filingDoc(decision: Decision, extra: Parameters<typeof h.repo.transition>[3] = {}) {
  const doc = h.add(new TextEncoder().encode('statement bytes'), 'application/pdf');
  h.repo.transition(doc.id, 'received', 'filing', { decision, analysis: ANALYSIS, preparedMime: 'application/pdf', autoFiled: true, ...extra });
  return h.repo.get(doc.id)!;
}

describe('fileStage', () => {
  it('waits for a login when there is no live session', async () => {
    h = makeHarness();
    h.setLive(undefined);
    const doc = filingDoc(EXISTING);
    await fileStage(doc, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('awaiting_login');
  });

  it('uploads into the chosen folder, records it, and deletes the inbox copy', async () => {
    h = makeHarness();
    const doc = filingDoc(EXISTING);
    await fileStage(doc, h.ctx);
    expect(h.drive.uploadFile).toHaveBeenCalledWith('Northwind Energy Sep 2026.pdf', expect.any(Uint8Array), 'application/pdf', {
      parentFolderUid: 'BILLS',
    });
    expect(h.repo.get(doc.id)).toMatchObject({
      state: 'filed',
      filedName: 'Northwind Energy Sep 2026.pdf',
      filedFolderPath: '/Bills',
      driveNodeUid: 'NODE1',
    });
    expect(h.inbox.has(doc.id, 'original')).toBe(false);
    const audit = h.db.prepare(`SELECT detail FROM audit_log WHERE event = 'document_filed'`).get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ documentId: doc.id, driveNodeUid: 'NODE1', autoFiled: true, confidence: 0.92 });
    // v1 records no filing history (it would be plaintext outside the encrypted stores).
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM classification_history').get() as { n: number }).n).toBe(0);
    const bills = h.ctx.folderCache.load()!.tree.find((f) => f.linkId === 'BILLS')!;
    expect(bills.files[0]!.name).toBe('Northwind Energy Sep 2026.pdf');
  });

  it('creates an approved new folder once, saving its uid before uploading', async () => {
    h = makeHarness();
    const doc = filingDoc(NEW);
    await fileStage(doc, h.ctx);
    expect(h.drive.findChildFolder).toHaveBeenCalledWith('BILLS', 'Water');
    expect(h.drive.createFolder).toHaveBeenCalledWith('BILLS', 'Water');
    expect(h.refreshFolderCache).toHaveBeenCalled();
    expect(h.drive.uploadFile.mock.calls[0][3]).toEqual({ parentFolderUid: 'NEWFOLDER' });
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', filedFolderPath: '/Bills/Water' });
  });

  it('reuses a same-named folder instead of creating a duplicate', async () => {
    h = makeHarness();
    h.drive.findChildFolder.mockResolvedValue('EXISTINGWATER');
    await fileStage(filingDoc(NEW), h.ctx);
    expect(h.drive.createFolder).not.toHaveBeenCalled();
    expect(h.drive.uploadFile.mock.calls[0][3]).toEqual({ parentFolderUid: 'EXISTINGWATER' });
  });

  it('sends the document to review when a file already owns the new folder\'s name', async () => {
    h = makeHarness();
    h.drive.createFolder.mockRejectedValue(new FolderNameTakenError('SOMEFILE'));
    const doc = filingDoc(NEW);
    await fileStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review' });
    expect(h.repo.get(doc.id)?.reviewReason).toContain('already uses');
    expect(h.drive.uploadFile).not.toHaveBeenCalled();
  });

  it('after a crash mid-upload, finds the file it already uploaded instead of uploading twice', async () => {
    h = makeHarness();
    const sha1 = createHash('sha1').update(new TextEncoder().encode('statement bytes')).digest('hex');
    h.drive.findFileBySha1.mockResolvedValue({ uid: 'NODE0', name: 'Northwind Energy Sep 2026.pdf' });
    const doc = filingDoc(EXISTING, { filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' } });
    await fileStage(doc, h.ctx);
    expect(h.drive.findFileBySha1).toHaveBeenCalledWith('BILLS', sha1);
    expect(h.drive.uploadFile).not.toHaveBeenCalled();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', driveNodeUid: 'NODE0' });
  });

  it('waits for a login when the Proton session has expired', async () => {
    h = makeHarness();
    const expired = Object.defineProperty(new ServerError('unauthorised'), 'statusCode', { value: 401 });
    h.drive.uploadFile.mockRejectedValue(expired);
    const doc = filingDoc(EXISTING);
    await fileStage(doc, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('awaiting_login');
  });

  it('lets other upload errors propagate for the worker to retry', async () => {
    h = makeHarness();
    h.drive.uploadFile.mockRejectedValue(new Error('network down'));
    await expect(fileStage(filingDoc(EXISTING), h.ctx)).rejects.toThrow('network down');
  });

  it('a completed upload wins over a discard requested during it', async () => {
    h = makeHarness();
    const doc = filingDoc(EXISTING);
    h.drive.uploadFile.mockImplementation(async () => {
      h.repo.requestDiscard(doc.id);
      return { nodeUid: 'NODE1', driveUrl: '', name: 'Northwind Energy Sep 2026.pdf' };
    });
    await fileStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', discardRequested: false });
  });

  it('honours a discard requested while the new folder was being created', async () => {
    h = makeHarness();
    const doc = filingDoc(NEW);
    h.drive.createFolder.mockImplementation(async () => {
      expect(h.repo.requestDiscard(doc.id)).toBe('requested');
      return 'NEWFOLDER';
    });
    await fileStage(doc, h.ctx);
    expect(h.drive.uploadFile).not.toHaveBeenCalled();
    // The folder stays in Drive; a later filing into it finds it by name.
    expect(h.repo.get(doc.id)).toMatchObject({
      state: 'discarded',
      filingTarget: null,
      decision: { folder: { kind: 'new', createdLinkId: 'NEWFOLDER' } },
    });
  });

  it('honours a discard requested while looking for an existing folder of that name', async () => {
    h = makeHarness();
    const doc = filingDoc(NEW);
    h.drive.findChildFolder.mockImplementation(async () => {
      h.repo.requestDiscard(doc.id);
      return 'EXISTINGWATER';
    });
    await fileStage(doc, h.ctx);
    expect(h.drive.uploadFile).not.toHaveBeenCalled();
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('refreshes the folder cache for a new folder only after the upload', async () => {
    h = makeHarness();
    const order: string[] = [];
    h.drive.uploadFile.mockImplementation(async () => {
      order.push('upload');
      return { nodeUid: 'NODE1', driveUrl: '', name: 'Water Sep 2026.pdf' };
    });
    h.refreshFolderCache.mockImplementation(async () => {
      order.push('refresh');
    });
    const doc = filingDoc(NEW);
    await fileStage(doc, h.ctx);
    expect(order).toEqual(['upload', 'refresh']);
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('once a target for this folder is set, finishes the filing despite a pending discard', async () => {
    h = makeHarness();
    const doc = filingDoc(EXISTING, { filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' } });
    h.repo.requestDiscard(doc.id);
    await fileStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.drive.findFileBySha1).toHaveBeenCalled();
    expect(h.drive.uploadFile).toHaveBeenCalled();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', discardRequested: false });
  });

  describe('re-checking an auto-filed folder before uploading', () => {
    it('sends the document to review when the folder is gone', async () => {
      h = makeHarness();
      h.ctx.folderCache.save(TREE.filter((f) => f.linkId !== 'BILLS'), h.ctx.now());
      const doc = filingDoc(EXISTING);
      await fileStage(doc, h.ctx);
      expect(h.drive.uploadFile).not.toHaveBeenCalled();
      expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'suggested folder no longer available' });
    });

    it('sends the document to review when the folder is now on the never-file-here list', async () => {
      h = makeHarness();
      // Moved into /Archive while the document waited for a login.
      h.ctx.folderCache.save(
        TREE.map((f) => (f.linkId === 'BILLS' ? { ...f, path: '/Archive/Bills' } : f)),
        h.ctx.now(),
      );
      const doc = filingDoc(EXISTING);
      await fileStage(doc, h.ctx);
      expect(h.drive.uploadFile).not.toHaveBeenCalled();
      expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'folder is on the never-file-here list' });
    });

    it('walks the tree first when no folder cache is loaded', async () => {
      h = makeHarness({ withTree: false });
      h.refreshFolderCache.mockImplementation(async () => h.ctx.folderCache.save(TREE, h.ctx.now()));
      const doc = filingDoc(EXISTING);
      await fileStage(doc, h.ctx);
      expect(h.refreshFolderCache).toHaveBeenCalled();
      expect(h.repo.get(doc.id)?.state).toBe('filed');
    });

    it('leaves a user-approved folder alone: it was checked at approval', async () => {
      h = makeHarness();
      h.ctx.folderCache.save(TREE.filter((f) => f.linkId !== 'BILLS'), h.ctx.now());
      const doc = filingDoc(EXISTING, { autoFiled: false });
      await fileStage(doc, h.ctx);
      expect(h.repo.get(doc.id)?.state).toBe('filed');
    });

    it('does not re-check once a filing target is set: the upload may have happened', async () => {
      h = makeHarness();
      h.ctx.folderCache.save(TREE.filter((f) => f.linkId !== 'BILLS'), h.ctx.now());
      h.drive.findFileBySha1.mockResolvedValue({ uid: 'NODE0', name: 'Northwind Energy Sep 2026.pdf' });
      const doc = filingDoc(EXISTING, { filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' } });
      await fileStage(doc, h.ctx);
      expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', driveNodeUid: 'NODE0' });
    });
  });

  it('ignores a filing target left by an earlier decision for another folder', async () => {
    h = makeHarness();
    const doc = filingDoc(
      { name: ANALYSIS.name, folder: { kind: 'existing', linkId: 'ARCHIVE', path: '/Archive' } },
      { filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' } },
    );
    await fileStage(doc, h.ctx);
    expect(h.drive.findFileBySha1).not.toHaveBeenCalled();
    expect(h.drive.uploadFile.mock.calls[0][3]).toEqual({ parentFolderUid: 'ARCHIVE' });
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', filedFolderPath: '/Archive' });
  });

  it('with no session, parks a discard-pending document whose upload may have happened', async () => {
    h = makeHarness();
    h.setLive(undefined);
    const doc = filingDoc(EXISTING, { filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' } });
    h.repo.requestDiscard(doc.id);
    await fileStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'awaiting_login', discardRequested: false });
  });

  it('with no session, applies a pending discard when nothing was uploaded yet', async () => {
    h = makeHarness();
    h.setLive(undefined);
    const doc = filingDoc(EXISTING);
    h.repo.requestDiscard(doc.id);
    await fileStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('has saved the filing target and the created folder before the upload starts', async () => {
    h = makeHarness();
    const doc = filingDoc(NEW);
    let seen: ReturnType<typeof h.repo.get> = null;
    h.drive.uploadFile.mockImplementation(async () => {
      seen = h.repo.get(doc.id);
      return { nodeUid: 'NODE1', driveUrl: '', name: 'Water Sep 2026.pdf' };
    });
    await fileStage(doc, h.ctx);
    expect(seen).toMatchObject({
      filingTarget: { folderLinkId: 'NEWFOLDER', name: 'Water Sep 2026.pdf' },
      decision: { folder: { kind: 'new', createdLinkId: 'NEWFOLDER' } },
    });
  });

  it('a re-run after the folder was created neither looks it up nor creates it again', async () => {
    h = makeHarness();
    const created: Decision = {
      name: 'Water Sep 2026',
      folder: { kind: 'new', parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water', createdLinkId: 'NEWFOLDER' },
    };
    const doc = filingDoc(created);
    await fileStage(doc, h.ctx);
    expect(h.drive.findChildFolder).not.toHaveBeenCalled();
    expect(h.drive.createFolder).not.toHaveBeenCalled();
    expect(h.drive.uploadFile.mock.calls[0][3]).toEqual({ parentFolderUid: 'NEWFOLDER' });
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filed', filedFolderPath: '/Bills/Water' });
  });

  it('files the document even when the folder-cache refresh and update fail', async () => {
    h = makeHarness();
    h.refreshFolderCache.mockRejectedValue(new Error('walk failed'));
    vi.spyOn(h.ctx.folderCache, 'recordFiled').mockImplementation(() => {
      throw new Error('cache broken');
    });
    const doc = filingDoc(NEW);
    await fileStage(doc, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('filed');
    expect(h.inbox.has(doc.id, 'original')).toBe(false);
  });

  it('never throws into the retry path once the document is filed', async () => {
    h = makeHarness();
    vi.spyOn(h.ctx.inbox, 'deleteAll').mockImplementation(() => {
      throw new Error('disk error');
    });
    const doc = filingDoc(EXISTING);
    await expect(fileStage(doc, h.ctx)).resolves.toBeUndefined();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('keeps the inbox copy when the document left filing before it could be marked filed', async () => {
    h = makeHarness();
    const doc = filingDoc(EXISTING);
    h.drive.uploadFile.mockImplementation(async () => {
      h.db.prepare(`UPDATE documents SET state = 'needs_review' WHERE id = ?`).run(doc.id);
      return { nodeUid: 'NODE1', driveUrl: '', name: 'Northwind Energy Sep 2026.pdf' };
    });
    await fileStage(doc, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('needs_review');
    expect(h.inbox.has(doc.id, 'original')).toBe(true);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event = 'document_filed'`).get()).toMatchObject({ n: 0 });
  });

  it('uploads with the type of the blob it actually sends', async () => {
    h = makeHarness();
    const doc = h.add(new TextEncoder().encode('photo bytes'), 'image/jpeg');
    // A prepared type is recorded, but no prepared blob exists: the original goes up as itself.
    h.repo.transition(doc.id, 'received', 'filing', { decision: EXISTING, analysis: ANALYSIS, preparedMime: 'application/pdf' });
    await fileStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.drive.uploadFile).toHaveBeenCalledWith('Northwind Energy Sep 2026.jpg', expect.any(Uint8Array), 'image/jpeg', {
      parentFolderUid: 'BILLS',
    });
  });
});
