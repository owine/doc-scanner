import { PDFDocument } from '@cantoo/pdf-lib';
import sharp, { type OutputInfo } from 'sharp';
import { pdfFromHeader, SHARP_FORMATS } from '../prepare/tools.js';

/** A photo's page: its long edge is A4's height, in points. */
const PAGE_LONG_EDGE_PT = 842;
/** Photos are downscaled to this long edge first: about 200 dpi on that page. */
const MAX_IMAGE_EDGE_PX = 2339;

export type CombineRefusal = 'encrypted' | 'unreadable' | 'unsupported_type';

export interface CombinePart {
  id: string;
  bytes: Uint8Array;
  mime: string;
}

export type CombineResult =
  | { kind: 'ok'; pdf: Uint8Array }
  | { kind: 'refused'; documentId: string; reason: CombineRefusal }
  | { kind: 'too_large' };

/**
 * Spec §2: one PDF from the parts, in order. A PDF's pages are copied (read
 * from its `%PDF-` header on, like the preparation tools); a photo becomes
 * one page, upright and flattened onto white. An encrypted PDF can't have
 * its pages copied, and other types have no pages: those are refused,
 * naming the part, so the user can leave it out.
 */
export async function combineParts(parts: readonly CombinePart[], maxBytes: number): Promise<CombineResult> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const refusal =
      part.mime === 'application/pdf'
        ? await addPdf(out, part.bytes)
        : part.mime.startsWith('image/')
          ? await addImage(out, part.bytes)
          : 'unsupported_type';
    if (refusal) return { kind: 'refused', documentId: part.id, reason: refusal };
  }
  const pdf = await out.save();
  return pdf.byteLength > maxBytes ? { kind: 'too_large' } : { kind: 'ok', pdf };
}

async function addPdf(out: PDFDocument, bytes: Uint8Array): Promise<CombineRefusal | null> {
  const body = pdfFromHeader(bytes);
  if (!body) return 'unreadable';
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(body, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return 'unreadable';
  }
  if (src.isEncrypted) return 'encrypted';
  try {
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  } catch {
    return 'unreadable';
  }
  return null;
}

async function addImage(out: PDFDocument, bytes: Uint8Array): Promise<CombineRefusal | null> {
  let format: string | undefined;
  try {
    ({ format } = await sharp(bytes).metadata());
  } catch {
    return 'unreadable';
  }
  if (!format || !SHARP_FORMATS.has(format)) return 'unsupported_type';
  let jpeg: { data: Buffer; info: OutputInfo };
  try {
    jpeg = await sharp(bytes)
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    return 'unreadable';
  }
  const image = await out.embedJpg(jpeg.data);
  const scale = PAGE_LONG_EDGE_PT / Math.max(jpeg.info.width, jpeg.info.height);
  const width = jpeg.info.width * scale;
  const height = jpeg.info.height * scale;
  out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  return null;
}
