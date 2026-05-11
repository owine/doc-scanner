import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { buildSearchablePdf, type OcrWord } from '../../src/pdf/build.js';

// happy-dom doesn't provide createImageBitmap; we use a small fixture JPEG
// stored as bytes in the test, then build a Blob.
const FIXTURE_PATH = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
function fixtureBlob(): Blob { return new Blob([readFileSync(FIXTURE_PATH)], { type: 'image/jpeg' }); }

// Phase 5: word coords are normalised 0-1 (Haiku output shape).
const word = (text: string, x: number, y: number): OcrWord =>
  ({ text, x, y, w: 0.1, h: 0.04 });

describe('buildSearchablePdf', () => {
  it('produces a valid 2-page PDF from 2 input pages', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'hello', ocrWords: [word('hello', 0.1, 0.05)] },
      { blob, ocrText: 'world', ocrWords: [word('world', 0.2, 0.05)] },
    ]);
    expect(pdfBlob.type).toBe('application/pdf');

    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it('embeds an image per page (image layer)', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'hi', ocrWords: [word('hi', 0.1, 0.05)] },
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
      { blob, ocrText: 'searchable', ocrWords: [word('searchable', 0.1, 0.05)] },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    // Both pages exist; no exception even when ocrWords is empty.
  });

  // PR-8 sourcery #5: empty + non-ASCII coverage.

  it('returns a parseable PDF for an empty pages array (does not throw)', async () => {
    const pdfBlob = await buildSearchablePdf([]);
    expect(pdfBlob.type).toBe('application/pdf');
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    // pdf-lib may emit a default page on load round-trip; we don't care
    // about the exact count, only that the bytes parse as a valid PDF.
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it('does not throw on words containing non-ASCII (accents + CJK) — PDF still loads', async () => {
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      {
        blob,
        ocrText: 'café 中文',
        ocrWords: [
          word('café', 0.1, 0.05),
          word('中文', 0.3, 0.05),
          word('hello', 0.5, 0.05),
        ],
      },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  // PR-8 sourcery #4b: Blob bytes match saved bytes (no trailing ArrayBuffer
  // tail). This is the regression test for `new Blob([out])` vs `[out.buffer]`.

  it('Blob ends with %%EOF marker (no trailing ArrayBuffer tail)', async () => {
    // The PR-8 #4b bug surfaced when `new Blob([out.buffer])` included
    // unused ArrayBuffer extent. Real PDFs end with `%%EOF` followed by
    // an optional newline. With the bug, the Blob would have trailing
    // zeros after the EOF marker. We assert the last few bytes are EOF.
    const blob = fixtureBlob();
    const pdfBlob = await buildSearchablePdf([
      { blob, ocrText: 'x', ocrWords: [word('x', 0.1, 0.05)] },
    ]);
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    // Read the last 8 bytes as text — should contain "%%EOF" with optional
    // trailing newlines.
    const tail = new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - 8)));
    expect(tail).toMatch(/%%EOF\s*$/);
  });
});
