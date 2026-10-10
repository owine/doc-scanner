import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { ServerError } from '@protontech/drive-sdk';
import { makeHarness, ANALYSIS } from './harness.js';
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
    expect(JSON.parse(audit.detail)).toMatchObject({ documentId: doc.id, driveNodeUid: 'NODE1', autoFiled: true });
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
});
