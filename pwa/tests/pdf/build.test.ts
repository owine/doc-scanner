import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { buildSearchablePdf } from '../../src/pdf/build.js';
import type { OcrWord } from '../../src/scanner/types.js';

// happy-dom doesn't provide createImageBitmap; we use a small fixture JPEG
// stored as bytes in the test, then build a Blob.
const FIXTURE_PATH = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
function fixtureBlob(): Blob { return new Blob([readFileSync(FIXTURE_PATH)], { type: 'image/jpeg' }); }

const word = (text: string, x: number, y: number): OcrWord =>
  ({ text, x, y, w: 50, h: 20, confidence: 90 });

describe('buildSearchablePdf', () => {
  it('produces a valid 2-page PDF from 2 input pages', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'hello', ocrWords: [word('hello', 10, 10)] },
      { blob, ocrText: 'world', ocrWords: [word('world', 10, 10)] },
    ]);
    expect(pdfBlob.type).toBe('application/pdf');

    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it('embeds an image per page (image layer)', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'hi', ocrWords: [word('hi', 10, 10)] },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    // pdf-lib doesn't expose embedded images directly, but the file size
    // should exceed the bare-minimum PDF (~600 bytes); embedding a JPEG adds
    // at least the JPEG size (small fixture is ~700 bytes).
    expect(bytes.length).toBeGreaterThan(1000);
    expect(doc.getPageCount()).toBe(1);
  });

  it('skips pages with no ocrText (still embeds the image)', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: '', ocrWords: [] },
      { blob, ocrText: 'searchable', ocrWords: [word('searchable', 10, 10)] },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    // Both pages exist; no exception even when ocrWords is empty.
  });
});
