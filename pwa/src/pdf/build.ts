import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import type { OcrWord } from '../scanner/types.js';

const PDF_PAGE_DPI = 144;
const PT_PER_PX = 72 / PDF_PAGE_DPI;

export interface PageInput {
  blob: Blob;
  ocrText: string;
  ocrWords: OcrWord[];
}

/** Assembles a searchable PDF: each input page becomes a PDF page with the
 *  source image as the visible layer and per-word invisible text drawn at
 *  the OCR-detected positions. */
export async function buildSearchablePdf(pages: PageInput[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');

  for (const page of pages) {
    const bytes = new Uint8Array(await page.blob.arrayBuffer());
    const image = await doc.embedJpg(bytes);
    // Page sized in points to match image at PDF_PAGE_DPI
    const widthPt = image.width * PT_PER_PX;
    const heightPt = image.height * PT_PER_PX;
    const pdfPage = doc.addPage([widthPt, heightPt]);

    pdfPage.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });

    // Invisible text layer. Word boxes are in image pixels with origin top-left;
    // PDF origin is bottom-left. Convert.
    for (const w of page.ocrWords) {
      const xPt = w.x * PT_PER_PX;
      const yPt = heightPt - (w.y + w.h) * PT_PER_PX;
      const sizePt = Math.max(4, w.h * PT_PER_PX);
      pdfPage.drawText(w.text, {
        x: xPt,
        y: yPt,
        size: sizePt,
        font,
        color: rgb(0, 0, 0),
        opacity: 0,
      });
    }
  }

  const out = await doc.save();
  return new Blob([out.buffer as ArrayBuffer], { type: 'application/pdf' });
}

/**
 * An image-only PDF: each page is one scanned JPEG, with no text layer.
 * The server adds the text layer (spec §4, slice 3).
 */
export async function buildImagePdf(pages: readonly Blob[]): Promise<Blob> {
  if (pages.length === 0) throw new Error('a scan with no pages has nothing to build');
  // No creation or modification dates, so the same pages always make the same
  // bytes, and the server's duplicate check (sha256) catches a scan sent twice.
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const blob of pages) {
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const widthPt = image.width * PT_PER_PX;
    const heightPt = image.height * PT_PER_PX;
    doc.addPage([widthPt, heightPt]).drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  const out = await doc.save();
  return new Blob([out.buffer as ArrayBuffer], { type: 'application/pdf' });
}
