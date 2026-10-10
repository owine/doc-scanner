import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { buildDocumentContent, MAX_FILE_BYTES } from '../../src/analyze/content.js';
import { preparePdf, MAX_ANALYZED_PAGES } from '../../src/analyze/pdf.js';
import { normaliseImage } from '../../src/analyze/image.js';

async function pdfWithPages(n: number, opts: { encrypt?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  // Owner password only, the way e-signature services lock a contract.
  if (opts.encrypt) doc.encrypt({ ownerPassword: 'owner', userPassword: '' });
  return doc.save();
}

function solidImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })[format]().toBuffer();
}

describe('preparePdf', () => {
  it('sends a short PDF unchanged', async () => {
    const bytes = await pdfWithPages(3);
    const out = await preparePdf(bytes);
    expect(out).toMatchObject({ kind: 'readable', totalPages: 3, sentPages: 3 });
    if (out.kind === 'readable') expect(out.bytes).toBe(bytes);
  });

  it('cuts a long PDF down to its first pages', async () => {
    const out = await preparePdf(await pdfWithPages(MAX_ANALYZED_PAGES + 5));
    expect(out).toMatchObject({ kind: 'readable', totalPages: 25, sentPages: MAX_ANALYZED_PAGES });
    if (out.kind === 'readable') {
      expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(MAX_ANALYZED_PAGES);
    }
  });

  it('sends an encrypted PDF unchanged at any length, since its pages cannot be trimmed', async () => {
    const bytes = await pdfWithPages(MAX_ANALYZED_PAGES + 5, { encrypt: true });
    const out = await preparePdf(bytes);
    expect(out).toEqual({ kind: 'readable', encrypted: true, bytes });
  });

  it('never walks the page tree of an encrypted PDF', async () => {
    // Real e-signed PDFs keep the page tree in encrypted object streams, and
    // pdf-lib throws on them ("Expected instance of PDFDict"); a PDF it
    // encrypts itself doesn't reproduce that, so simulate the throw.
    const bytes = await pdfWithPages(2, { encrypt: true });
    const spy = vi.spyOn(PDFDocument.prototype, 'getPageCount').mockImplementation(() => {
      throw new Error('Expected instance of PDFDict, but got instance of undefined');
    });
    try {
      const out = await preparePdf(bytes);
      expect(out.kind).toBe('readable');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a corrupt PDF instead of throwing', async () => {
    expect(await preparePdf(new TextEncoder().encode('not a pdf'))).toEqual({ kind: 'unreadable', reason: 'corrupt' });
  });
});

describe('normaliseImage', () => {
  it('passes a small PNG through and labels it as PNG', async () => {
    const png = new Uint8Array(await solidImage(100, 50, 'png'));
    const out = await normaliseImage(png);
    expect(out.mediaType).toBe('image/png');
    expect(out.bytes).toBe(png);
  });

  it('re-encodes other formats and oversized images to JPEG within 1568 px', async () => {
    const out = await normaliseImage(new Uint8Array(await solidImage(4000, 1000, 'webp')));
    expect(out.mediaType).toBe('image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(1568);
  });
});

describe('buildDocumentContent', () => {
  it('wraps a PDF as a native document block and notes truncation', async () => {
    const out = await buildDocumentContent(await pdfWithPages(22), 'application/pdf');
    expect(out.blocks[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
    expect(out.note).toBe('showing the first 20 of 22 pages');
  });

  it('sends no file content for a PDF over the size budget', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    // An unreferenced, uncompressed stream: a few pages that are huge on disk.
    doc.context.register(doc.context.stream(new Uint8Array(MAX_FILE_BYTES + 1)));
    const out = await buildDocumentContent(await doc.save(), 'application/pdf');
    expect(out.blocks).toEqual([]);
    expect(out.note).toContain('too large');
    expect(out.mayBeUnopenable).toBeFalsy();
  });

  it('falls back to metadata for an undecodable image', async () => {
    const out = await buildDocumentContent(new Uint8Array([1, 2, 3]), 'image/heic');
    expect(out.blocks).toEqual([]);
    expect(out.note).toContain('could not be decoded');
  });

  it('inlines plain text', async () => {
    const out = await buildDocumentContent(new TextEncoder().encode('hello'), 'text/plain');
    expect(out.blocks).toEqual([{ type: 'text', text: '<document>\nhello\n</document>' }]);
  });

  it('sends nothing for an unreadable type', async () => {
    const out = await buildDocumentContent(new Uint8Array(4), 'application/zip');
    expect(out.blocks).toEqual([]);
    expect(out.note).toContain('only its metadata');
  });
});
