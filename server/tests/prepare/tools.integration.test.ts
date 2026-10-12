import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { createPrepareTools } from '../../src/prepare/tools.js';

const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const available = has('ocrmypdf') && has('img2pdf') && has('gs');

async function textPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Northwind Energy', { x: 56, y: 720, size: 28, font });
  page.drawText('Electricity Bill - September 2026', { x: 56, y: 680, size: 18, font });
  return doc.save();
}

describe.skipIf(!available)('PrepareTools (real binaries)', () => {
  const tools = createPrepareTools();
  let born: Uint8Array;
  let scanJpeg: Uint8Array;

  beforeAll(async () => {
    born = await textPdf();
    // A page image of that text, as a phone would capture it (Ghostscript renders Letter at 1275 px).
    scanJpeg = (await tools.thumbnail(born, 'application/pdf', { width: 1275 }))!;
  });

  it('leaves a born-digital PDF unchanged', async () => {
    expect(await tools.ocrPdf(born)).toEqual({ kind: 'unchanged' });
  });

  it('adds a text layer to an image-only PDF', async () => {
    const imageOnly = await tools.imageToPdf(scanJpeg, 'image/jpeg');
    const r = await tools.ocrPdf(imageOnly);
    expect(r.kind).toBe('ocred');
  });

  it('turns a PNG photo into a PDF', async () => {
    const png = await sharp(scanJpeg).png().toBuffer();
    const pdf = await tools.imageToPdf(new Uint8Array(png), 'image/png');
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('makes JPEG thumbnails of PDFs and images', async () => {
    const t1 = await tools.thumbnail(born, 'application/pdf');
    const t2 = await tools.thumbnail(scanJpeg, 'image/jpeg');
    for (const t of [t1, t2]) {
      const meta = await sharp(t!).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeLessThanOrEqual(400);
    }
    expect(await tools.thumbnail(new TextEncoder().encode('not a picture'), 'text/plain')).toBeNull();
  });
});
