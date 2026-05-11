import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';

const PDF_PAGE_DPI = 144;
const PT_PER_PX = 72 / PDF_PAGE_DPI;

/**
 * One OCR word with normalised (0-1) bounding-box coordinates relative to
 * the page image. Origin is top-left (image convention); the renderer
 * flips to PDF's bottom-left origin internally.
 *
 * `confidence` is optional — Haiku vision (Phase 5) doesn't return it.
 * Tesseract output (legacy) did; existing callers can keep passing it.
 */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
}

export interface PageInput {
  blob: Blob;
  ocrText: string;
  ocrWords: OcrWord[];
}

/**
 * Assembles a searchable PDF: each input page becomes a PDF page with the
 * source image as the visible layer and per-word invisible text drawn at
 * the OCR-detected positions. An empty pages array yields a valid 0-page
 * PDF (does not throw).
 *
 * Non-ASCII words (e.g., CJK, accented chars) are skipped in the text
 * layer rather than crashing — Helvetica (the only font we embed) doesn't
 * cover them, and shipping a Unicode font is overkill for a single-user
 * doc-scanner. The image layer still contains the full visible content.
 */
export async function buildSearchablePdf(pages: PageInput[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const page of pages) {
    const bytes = new Uint8Array(await page.blob.arrayBuffer());
    const image = await doc.embedJpg(bytes);
    // Page sized in points to match image at PDF_PAGE_DPI.
    const widthPt = image.width * PT_PER_PX;
    const heightPt = image.height * PT_PER_PX;
    const pdfPage = doc.addPage([widthPt, heightPt]);

    pdfPage.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });

    // Invisible text layer. Word coords are normalised 0-1 with top-left
    // origin; PDF origin is bottom-left. Multiply by page dims directly
    // (no need to round-trip through pixel coords).
    for (const w of page.ocrWords) {
      const xPt = w.x * widthPt;
      const yPt = heightPt - (w.y + w.h) * heightPt;
      const sizePt = Math.max(4, w.h * heightPt);
      try {
        pdfPage.drawText(w.text, {
          x: xPt, y: yPt, size: sizePt, font, color: rgb(0, 0, 0), opacity: 0,
        });
      } catch {
        // pdf-lib throws on glyphs the embedded font can't encode (non-ASCII
        // for Helvetica). Skip silently — image layer still has the word.
      }
    }
  }

  const out = await doc.save();
  // PR-8 fix: `new Blob([out.buffer])` includes the entire ArrayBuffer
  // extent (which can exceed `out.byteLength`, leaving trailing garbage
  // that some strict PDF readers / upload SDKs reject). `out.slice()`
  // produces a fresh Uint8Array backed by an exact-fit ArrayBuffer (also
  // satisfies TS strictness about ArrayBufferLike vs ArrayBuffer).
  return new Blob([out.slice()], { type: 'application/pdf' });
}
