import { describe, it, expect, beforeEach } from 'vitest';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

const Q: Quad = { tl: {x:0,y:0}, tr: {x:100,y:0}, bl: {x:0,y:100}, br: {x:100,y:100} };

function blobOf(text: string): Blob { return new Blob([text], { type: 'image/jpeg' }); }

let store: ScansStore;

beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

describe('ScansStore', () => {
  it('createInProgress + appendPage + finish flow', async () => {
    const id = await store.createInProgress();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const ord = await store.appendPage(id, blobOf('p1'), Q);
    expect(ord).toBe(0);
    await store.appendPage(id, blobOf('p2'), Q);

    const beforeFinish = await store.findInProgress();
    expect(beforeFinish?.id).toBe(id);
    expect(beforeFinish?.pageCount).toBe(2);
    expect(beforeFinish?.thumbnailKey).toBeNull();

    await store.finish(id);
    const list = await store.listCompleted();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(id);
    expect(list[0]!.status).toBe('completed');
    expect(list[0]!.thumbnailKey).not.toBeNull();
    expect(await store.findInProgress()).toBeNull();
  });

  it('updatePage replaces blob + quad at ordinal', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.appendPage(id, blobOf('p2-old'), Q);
    const newQ: Quad = { ...Q, tl: { x: 10, y: 10 } };
    await store.updatePage(id, 1, blobOf('p2-new'), newQ);
    const pages = await store.getPages(id);
    expect(pages[1]!.quad.tl).toEqual({ x: 10, y: 10 });
    expect(await pages[1]!.blob.text()).toBe('p2-new');
  });

  it('delete cascades pages and thumbnail', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    await store.delete(id);
    expect(await store.listCompleted()).toEqual([]);
    expect(await store.getPages(id)).toEqual([]);
  });

  it('listCompleted is sorted by updatedAt desc', async () => {
    const a = await store.createInProgress();
    await store.appendPage(a, blobOf('a'), Q);
    await store.finish(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createInProgress();
    await store.appendPage(b, blobOf('b'), Q);
    await store.finish(b);

    const list = await store.listCompleted();
    expect(list.map((s) => s.id)).toEqual([b, a]);
  });

  it('only one in-progress scan at a time', async () => {
    const a = await store.createInProgress();
    const b = await store.createInProgress();
    const found = await store.findInProgress();
    expect(found?.id).toBe(b);
    expect(await store.getPages(a)).toEqual([]);
  });

  it('getThumbnailBlob returns the saved thumb', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    const list = await store.listCompleted();
    const thumb = await store.getThumbnailBlob(list[0]!.thumbnailKey!);
    expect(thumb).toBeInstanceOf(Blob);
  });

  // ---------- Phase 5: uploadStatus axis ----------

  it('new scans default to uploadStatus=idle, uploadError=null', async () => {
    const id = await store.createInProgress();
    const scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('idle');
    expect(scan?.uploadError).toBeNull();
  });

  it('legal transition idle → pending_classify succeeds', async () => {
    const id = await store.createInProgress();
    await store.setUploadStatus(id, 'pending_classify');
    expect((await store.getScan(id))?.uploadStatus).toBe('pending_classify');
  });

  it('illegal transition (idle → done) throws', async () => {
    const id = await store.createInProgress();
    await expect(store.setUploadStatus(id, 'done')).rejects.toThrow(/illegal uploadStatus transition/);
  });

  it('awaiting_confirm → pending_upload accepts finalName/finalFolderLinkId patch', async () => {
    const id = await store.createInProgress();
    await store.setUploadStatus(id, 'pending_classify');
    await store.setUploadStatus(id, 'awaiting_confirm');
    await store.setUploadStatus(id, 'pending_upload', {
      finalName: 'Tax 2026',
      finalFolderLinkId: 'f-tax',
    });
    const scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('pending_upload');
    expect(scan?.finalName).toBe('Tax 2026');
    expect(scan?.finalFolderLinkId).toBe('f-tax');
  });

  it('pending_upload → done writes driveNodeUid + driveWebUrl', async () => {
    const id = await store.createInProgress();
    await store.setUploadStatus(id, 'pending_classify');
    await store.setUploadStatus(id, 'awaiting_confirm');
    await store.setUploadStatus(id, 'pending_upload');
    await store.setUploadStatus(id, 'done', {
      driveNodeUid: 'node-abc',
      driveWebUrl: 'https://drive.proton.me/x/abc',
    });
    const scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('done');
    expect(scan?.driveNodeUid).toBe('node-abc');
    expect(scan?.driveWebUrl).toBe('https://drive.proton.me/x/abc');
  });

  it('setSuggestionAndOcr atomically transitions to awaiting_confirm with both fields', async () => {
    const id = await store.createInProgress();
    await store.setUploadStatus(id, 'pending_classify');
    await store.setSuggestionAndOcr(
      id,
      { suggestedName: 'Tax 2026', suggestedFolderLinkId: 'f-tax', confidence: 0.9, rationale: 'IRS' },
      [{ text: 'page 1', words: [] }],
    );
    const scan = await store.getScan(id);
    expect(scan?.uploadStatus).toBe('awaiting_confirm');
    expect(scan?.suggestion?.suggestedName).toBe('Tax 2026');
    expect(scan?.pageOcr?.length).toBe(1);
  });

  it('getPageBlobs returns page blobs in ordinal order', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.appendPage(id, blobOf('p2'), Q);
    await store.appendPage(id, blobOf('p3'), Q);
    const blobs = await store.getPageBlobs(id);
    expect(blobs.length).toBe(3);
    expect(await blobs[0]!.text()).toBe('p1');
    expect(await blobs[2]!.text()).toBe('p3');
  });

  it('setPdfBlob writes the pdfs row + links it on the scan atomically', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    const pdfBytes = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
    const pdfKey = await store.setPdfBlob(id, pdfBytes);
    expect(pdfKey).toMatch(/^[a-z0-9-]{8,}$/);

    const scan = await store.getScan(id);
    expect(scan?.pdfKey).toBe(pdfKey);
    const stored = await store.getPdf(pdfKey);
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe('%PDF-1.4 fake');
  });

  it('setPdfBlob throws (and inserts no orphaned pdfs row) if scan does not exist', async () => {
    const before = await (store as unknown as { d: { count(name: 'pdfs'): Promise<number> } }).d.count('pdfs');
    await expect(store.setPdfBlob('does-not-exist', new Blob(['%PDF']))).rejects.toThrow(/scan not found/);
    const after = await (store as unknown as { d: { count(name: 'pdfs'): Promise<number> } }).d.count('pdfs');
    expect(after).toBe(before);
  });

  it('setPdfBlob replaces a prior pdfKey (drops the old pdfs row)', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    const firstKey = await store.setPdfBlob(id, new Blob(['v1'], { type: 'application/pdf' }));
    const secondKey = await store.setPdfBlob(id, new Blob(['v2'], { type: 'application/pdf' }));
    expect(secondKey).not.toBe(firstKey);

    expect(await store.getPdf(firstKey)).toBeNull();
    const v2 = await store.getPdf(secondKey);
    expect(await v2!.text()).toBe('v2');
  });

  it('getCombinedOcrText concatenates non-empty page texts with double newlines', async () => {
    const id = await store.createInProgress();
    await store.setUploadStatus(id, 'pending_classify');
    await store.setSuggestionAndOcr(
      id,
      undefined,
      [
        { text: 'page 1 text', words: [] },
        { text: '', words: [] },
        { text: 'page 3 text', words: [] },
      ],
    );
    expect(await store.getCombinedOcrText(id)).toBe('page 1 text\n\npage 3 text');
  });

  it('appendPage propagates QuotaExceededError from the underlying transaction', async () => {
    const id = await store.createInProgress();
    // Wrap db.transaction so its put rejects with a synthetic quota error.
    const realTx = (store as any).db.transaction.bind((store as any).db);
    (store as any).db.transaction = (...args: any[]) => {
      const tx = realTx(...args);
      const realStore = tx.objectStore.bind(tx);
      tx.objectStore = (name: string) => {
        const os = realStore(name);
        if (name === 'pages') {
          os.put = () => Promise.reject(new DOMException('quota exceeded', 'QuotaExceededError'));
        }
        return os;
      };
      return tx;
    };
    await expect(store.appendPage(id, blobOf('p1'), Q)).rejects.toThrow(/quota/i);
    (store as any).db.transaction = realTx;
  });
});
