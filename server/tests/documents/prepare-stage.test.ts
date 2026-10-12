import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, ANALYSIS } from './harness.js';
import { prepareStage } from '../../src/documents/stages/prepare.js';
import { InboxBlobMissingError } from '../../src/documents/inbox-store.js';
import { ToolMissingError, ToolTimeoutError } from '../../src/prepare/run.js';
import { ToolFailedError } from '../../src/prepare/tools.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h.cleanup());

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const THUMB = enc('thumb-jpeg');

/** A document in `preparing` with its original in the inbox. */
function preparing(mime: string, bytes = enc('original bytes'), isDocument = true) {
  const doc = h.add(bytes, mime);
  h.repo.transition(doc.id, 'received', 'preparing', { analysis: { ...ANALYSIS, isDocument } });
  return h.repo.get(doc.id)!;
}

describe('prepareStage', () => {
  it('keeps a born-digital PDF and thumbnails the original', async () => {
    h = makeHarness();
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', preparedMime: 'application/pdf', prepareNote: null, hasThumbnail: true });
    expect(dec(h.prepare.thumbnail.mock.calls[0]![0])).toBe('original bytes');
    expect(dec(h.inbox.get(doc.id, 'thumbnail'))).toBe('thumb-jpeg');
  });

  it('stores an OCRed PDF and thumbnails it', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'ocred', pdf: enc('B') });
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('B');
    expect(h.repo.get(doc.id)?.preparedMime).toBe('application/pdf');
    expect(dec(h.prepare.thumbnail.mock.calls[0]![0])).toBe('B');
  });

  it('files a protected PDF as it is, with no note', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'protected' });
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', prepareNote: null });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('turns a document photo into a searchable PDF', async () => {
    h = makeHarness();
    h.prepare.imageToPdf.mockResolvedValue(enc('IMGPDF'));
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'ocred', pdf: enc('OCR') });
    const doc = preparing('image/jpeg');
    await prepareStage(doc, h.ctx);
    expect(h.prepare.imageToPdf).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/jpeg');
    expect(dec(h.prepare.ocrPdf.mock.calls[0]![0])).toBe('IMGPDF');
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('OCR');
    expect(h.repo.get(doc.id)?.preparedMime).toBe('application/pdf');
  });

  it('keeps the plain image PDF of a photo OCR found nothing in', async () => {
    h = makeHarness();
    h.prepare.imageToPdf.mockResolvedValue(enc('IMGPDF'));
    const doc = preparing('image/png');
    await prepareStage(doc, h.ctx);
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('IMGPDF');
    expect(h.repo.get(doc.id)?.preparedMime).toBe('application/pdf');
  });

  it('leaves an ordinary photo alone', async () => {
    h = makeHarness();
    const doc = preparing('image/jpeg', enc('x'), false);
    await prepareStage(doc, h.ctx);
    expect(h.prepare.imageToPdf).not.toHaveBeenCalled();
    expect(h.prepare.ocrPdf).not.toHaveBeenCalled();
    expect(h.prepare.thumbnail).toHaveBeenCalledOnce();
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)?.preparedMime).toBe('image/jpeg');
  });

  it('does not OCR an Office or text file, and records no thumbnail it could not make', async () => {
    h = makeHarness();
    const doc = preparing('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await prepareStage(doc, h.ctx);
    expect(h.prepare.ocrPdf).not.toHaveBeenCalled();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', hasThumbnail: false });
    expect(h.inbox.has(doc.id, 'thumbnail')).toBe(false);
  });

  it.each([
    [new ToolMissingError('ocrmypdf is not installed'), 'Filed without a text layer: OCR is not installed on this server.'],
    [new ToolTimeoutError('ocrmypdf took longer than 300000 ms'), 'Filed without a text layer: OCR took too long.'],
    [new ToolFailedError('ocrmypdf exited 2'), 'Filed without a text layer: OCR failed.'],
    [new Error('anything else'), 'Filed without a text layer: OCR failed.'],
  ])('files the original with a note when OCR throws %s', async (err, note) => {
    h = makeHarness();
    h.prepare.ocrPdf.mockRejectedValue(err);
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', preparedMime: 'application/pdf', prepareNote: note });
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.report.mock.calls[0]![1]).toBe('prepare');
  });

  it('still files the original when reporting the fallback fails', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockRejectedValue(new ToolTimeoutError('slow'));
    h.report.mockImplementation(() => {
      throw new Error('reporter down');
    });
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', prepareNote: 'Filed without a text layer: OCR took too long.' });
  });

  it('removes blobs an earlier, crashed run left', async () => {
    h = makeHarness();
    const doc = preparing('text/plain');
    h.inbox.put(doc.id, 'prepared', enc('stale'));
    h.inbox.put(doc.id, 'thumbnail', enc('stale'));
    await prepareStage(doc, h.ctx);
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.inbox.has(doc.id, 'thumbnail')).toBe(false);
  });

  it('ignores a thumbnail failure', async () => {
    h = makeHarness();
    h.prepare.thumbnail.mockRejectedValue(new Error('boom'));
    const doc = preparing('application/pdf');
    await prepareStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', hasThumbnail: false });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('applies a discard requested while it worked, and drops what it prepared', async () => {
    h = makeHarness();
    h.prepare.ocrPdf.mockResolvedValue({ kind: 'ocred', pdf: enc('B') });
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const doc = preparing('application/pdf');
    h.repo.requestDiscard(doc.id);
    await prepareStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
    expect(h.inbox.has(doc.id, 'prepared')).toBe(false);
    expect(h.inbox.has(doc.id, 'thumbnail')).toBe(false);
    expect(h.inbox.has(doc.id, 'original')).toBe(true); // restorable
  });

  it('prepares a document whose analysis was unusable', async () => {
    h = makeHarness();
    h.prepare.thumbnail.mockResolvedValue(THUMB);
    const pdf = h.add(enc('pdf bytes'), 'application/pdf');
    h.repo.transition(pdf.id, 'received', 'preparing', { reviewReason: 'analysis refusal: declined' });
    await prepareStage(h.repo.get(pdf.id)!, h.ctx);
    expect(h.prepare.ocrPdf).toHaveBeenCalledOnce();
    expect(h.repo.get(pdf.id)).toMatchObject({ state: 'ready', hasThumbnail: true, reviewReason: 'analysis refusal: declined' });
    const photo = h.add(enc('jpeg bytes'), 'image/jpeg');
    h.repo.transition(photo.id, 'received', 'preparing', { reviewReason: 'analysis refusal: declined' });
    await prepareStage(h.repo.get(photo.id)!, h.ctx);
    expect(h.prepare.imageToPdf).not.toHaveBeenCalled(); // isDocument is unknown
  });

  it('never re-prepares a document that may already be in Drive', async () => {
    h = makeHarness();
    const doc = preparing('image/jpeg');
    // As after a filing that set its target, failed, and was discarded and restored.
    h.inbox.put(doc.id, 'prepared', enc('UPLOADED'));
    h.inbox.put(doc.id, 'thumbnail', THUMB);
    h.repo.transition(doc.id, 'preparing', 'preparing', {
      filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' },
      preparedMime: 'application/pdf',
      prepareNote: null,
      hasThumbnail: true,
    });
    await prepareStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.prepare.ocrPdf).not.toHaveBeenCalled();
    expect(h.prepare.imageToPdf).not.toHaveBeenCalled();
    expect(h.prepare.thumbnail).not.toHaveBeenCalled();
    expect(dec(h.inbox.get(doc.id, 'prepared'))).toBe('UPLOADED');
    expect(dec(h.inbox.get(doc.id, 'thumbnail'))).toBe('thumb-jpeg');
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', preparedMime: 'application/pdf', prepareNote: null, hasThumbnail: true });
  });

  it('throws when the original is missing, so the worker fails it as before', async () => {
    h = makeHarness();
    const doc = preparing('application/pdf');
    h.inbox.deleteAll(doc.id);
    await expect(prepareStage(doc, h.ctx)).rejects.toBeInstanceOf(InboxBlobMissingError);
  });
});
