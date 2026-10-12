import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { buildImagePdf } from '../../src/pdf/build.js';

// happy-dom doesn't provide createImageBitmap; we use a small fixture JPEG
// stored as bytes in the test, then build a Blob.
const FIXTURE_PATH = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
function fixtureBlob(): Blob { return new Blob([readFileSync(FIXTURE_PATH)], { type: 'image/jpeg' }); }

describe('buildImagePdf', () => {
  it('makes one page per image, sized to the image at 144 dpi', async () => {
    const jpg = fixtureBlob();
    const pdf = await buildImagePdf([jpg, jpg]);
    expect(pdf.type).toBe('application/pdf');
    const doc = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(2 * 0.5); // 2×1 px at 72/144 pt per px
    expect(height).toBeCloseTo(1 * 0.5);
  });

  it('builds the same bytes from the same pages, whenever it runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
      const first = new Uint8Array(await (await buildImagePdf([fixtureBlob()])).arrayBuffer());
      vi.setSystemTime(new Date('2026-10-13T17:30:00Z'));
      const second = new Uint8Array(await (await buildImagePdf([fixtureBlob()])).arrayBuffer());
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an empty scan', async () => {
    await expect(buildImagePdf([])).rejects.toThrow(/no pages/);
  });
});
