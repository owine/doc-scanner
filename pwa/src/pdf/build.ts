import { PDFDocument } from '@cantoo/pdf-lib';

const PDF_PAGE_DPI = 144;
const PT_PER_PX = 72 / PDF_PAGE_DPI;

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
