import { describe, it, expect } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { combineParts } from '../../src/documents/combine.js';

const MAX = 50 * 1024 * 1024;

async function pdf(sizes: number[], opts: { encrypt?: boolean } = {}): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const s of sizes) d.addPage([s, s]);
  if (opts.encrypt) d.encrypt({ ownerPassword: 'owner', userPassword: '' });
  return d.save();
}

const widths = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));
const part = (id: string, bytes: Uint8Array, mime = 'application/pdf') => ({ id, bytes, mime });

describe('combineParts', () => {
  it('copies every page, in the order given', async () => {
    const out = await combineParts([part('b', await pdf([200, 210])), part('a', await pdf([100]))], MAX);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(await widths(out.pdf)).toEqual([200, 210, 100]);
  });

  it('reads a PDF from its header on, as the preparation tools do', async () => {
    const body = await pdf([100]);
    const junk = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, ...body]);
    const out = await combineParts([part('a', junk), part('b', await pdf([150]))], MAX);
    expect(out.kind).toBe('ok');
  });

  it('makes a photo one page, upright, with its long edge the height of A4', async () => {
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const out = await combineParts([part('a', await pdf([100])), part('b', png, 'image/png')], MAX);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const page = (await PDFDocument.load(out.pdf)).getPage(1);
    expect(Math.round(page.getWidth())).toBe(842);
    expect(Math.round(page.getHeight())).toBe(421);
  });

  it('refuses an encrypted PDF, naming the part', async () => {
    const out = await combineParts([part('a', await pdf([100])), part('locked', await pdf([100], { encrypt: true }))], MAX);
    expect(out).toEqual({ kind: 'refused', documentId: 'locked', reason: 'encrypted' });
  });

  it('refuses a corrupt PDF or one with no header', async () => {
    const corrupt = new TextEncoder().encode('%PDF-1.7 this is not a pdf');
    expect(await combineParts([part('a', await pdf([100])), part('bad', corrupt)], MAX)).toEqual({ kind: 'refused', documentId: 'bad', reason: 'unreadable' });
    const noHeader = new TextEncoder().encode('hello');
    expect(await combineParts([part('x', noHeader), part('a', await pdf([100]))], MAX)).toEqual({ kind: 'refused', documentId: 'x', reason: 'unreadable' });
  });

  it('refuses a type that has no pages', async () => {
    const out = await combineParts([part('a', await pdf([100])), part('t', new TextEncoder().encode('notes'), 'text/plain')], MAX);
    expect(out).toEqual({ kind: 'refused', documentId: 't', reason: 'unsupported_type' });
  });

  it('refuses an image sharp may not decode here', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const out = await combineParts([part('a', await pdf([100])), part('s', svg, 'image/svg+xml')], MAX);
    expect(out).toMatchObject({ kind: 'refused', documentId: 's' });
  });

  it('reports a result over the size limit', async () => {
    expect(await combineParts([part('a', await pdf([100])), part('b', await pdf([100]))], 10)).toEqual({ kind: 'too_large' });
  });
});
