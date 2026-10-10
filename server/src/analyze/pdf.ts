import { PDFDocument } from '@cantoo/pdf-lib';

export const MAX_ANALYZED_PAGES = 20;

export type PdfForAnalysis =
  | { kind: 'readable'; bytes: Uint8Array; totalPages: number; sentPages: number; encrypted: false }
  // Page count unknown: an encrypted PDF's page tree often sits in encrypted
  // object streams that pdf-lib can't parse.
  | { kind: 'readable'; bytes: Uint8Array; encrypted: true }
  | { kind: 'unreadable'; reason: 'corrupt' };

/**
 * Bounds what the analyzer sends for a PDF. A document of up to
 * MAX_ANALYZED_PAGES pages goes unchanged; a longer one is cut down to its
 * first pages, which is where the issuer, title and date almost always are.
 *
 * Encrypted PDFs go unchanged whatever their length: e-signature services
 * lock contracts with an owner password that restricts editing, not
 * opening, so Claude reads them fine, but pdf-lib can't copy their pages to
 * trim them. One that truly needs a password to open is rejected by the API;
 * the analyzer then retries without it.
 */
export async function preparePdf(bytes: Uint8Array): Promise<PdfForAnalysis> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { kind: 'unreadable', reason: 'corrupt' };
  }
  // Checked before anything walks the page tree, which throws on many
  // encrypted files (found on a real e-signed contract in the model eval).
  if (doc.isEncrypted) return { kind: 'readable', bytes, encrypted: true };
  const totalPages = doc.getPageCount();
  if (totalPages <= MAX_ANALYZED_PAGES) {
    return { kind: 'readable', bytes, totalPages, sentPages: totalPages, encrypted: false };
  }
  const head = await PDFDocument.create();
  const pages = await head.copyPages(doc, [...Array(MAX_ANALYZED_PAGES).keys()]);
  for (const page of pages) head.addPage(page);
  return { kind: 'readable', bytes: await head.save(), totalPages, sentPages: MAX_ANALYZED_PAGES, encrypted: false };
}
