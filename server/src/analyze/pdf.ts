import { PDFDocument } from '@cantoo/pdf-lib';

export const MAX_ANALYZED_PAGES = 20;

export type PdfForAnalysis =
  | { kind: 'readable'; bytes: Uint8Array; totalPages: number; sentPages: number }
  | { kind: 'unreadable'; reason: 'encrypted' | 'corrupt' };

/**
 * Bounds what the analyzer sends for a PDF. A document of up to
 * MAX_ANALYZED_PAGES pages goes unchanged; a longer one is cut down to its
 * first pages, which is where the issuer, title and date almost always are.
 * Encrypted and unparseable PDFs are reported rather than sent, since the API
 * rejects them.
 */
export async function preparePdf(bytes: Uint8Array): Promise<PdfForAnalysis> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { kind: 'unreadable', reason: 'corrupt' };
  }
  if (doc.isEncrypted) return { kind: 'unreadable', reason: 'encrypted' };

  const totalPages = doc.getPageCount();
  if (totalPages <= MAX_ANALYZED_PAGES) {
    return { kind: 'readable', bytes, totalPages, sentPages: totalPages };
  }
  const head = await PDFDocument.create();
  const pages = await head.copyPages(doc, [...Array(MAX_ANALYZED_PAGES).keys()]);
  for (const page of pages) head.addPage(page);
  return {
    kind: 'readable',
    bytes: await head.save(),
    totalPages,
    sentPages: MAX_ANALYZED_PAGES,
  };
}
