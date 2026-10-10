import type Anthropic from '@anthropic-ai/sdk';
import { normaliseImage, UndecodableImageError } from './image.js';
import { preparePdf } from './pdf.js';

const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/json']);
const MAX_TEXT_CHARS = 100_000;

export interface DocumentContent {
  blocks: Anthropic.ContentBlockParam[];
  /** Tells the model what it is (or isn't) seeing, when that isn't obvious. */
  note: string | null;
  /**
   * An encrypted PDF went in as-is; if the API can't open it, the analyzer
   * retries with metadata only.
   */
  mayBeUnopenable?: boolean;
}

/** What to send instead when the API can't open the document. */
export const UNOPENABLE: DocumentContent = {
  blocks: [],
  note: 'the PDF is password-protected and its content could not be read',
};

/**
 * Turns the raw file into the content blocks Claude reads. PDFs go in as
 * native document blocks, images as vision input, text as text. Anything the
 * model can't read contributes no blocks, and the note says so, leaving the
 * filename and arrival metadata to decide.
 */
export async function buildDocumentContent(bytes: Uint8Array, mimeType: string): Promise<DocumentContent> {
  if (mimeType === 'application/pdf') {
    const pdf = await preparePdf(bytes);
    if (pdf.kind === 'unreadable') {
      return { blocks: [], note: 'the PDF is corrupt and its content could not be read' };
    }
    return {
      blocks: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf.bytes).toString('base64') },
        },
      ],
      note:
        !pdf.encrypted && pdf.sentPages < pdf.totalPages
          ? `showing the first ${pdf.sentPages} of ${pdf.totalPages} pages`
          : null,
      mayBeUnopenable: pdf.encrypted,
    };
  }

  if (mimeType.startsWith('image/')) {
    try {
      const img = await normaliseImage(bytes);
      return {
        blocks: [
          {
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: Buffer.from(img.bytes).toString('base64') },
          },
        ],
        note: null,
      };
    } catch (err) {
      if (!(err instanceof UndecodableImageError)) throw err;
      return { blocks: [], note: 'the image could not be decoded, so its content is not shown' };
    }
  }

  if (TEXT_TYPES.has(mimeType)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const truncated = text.length > MAX_TEXT_CHARS;
    return {
      blocks: [{ type: 'text', text: `<document>\n${text.slice(0, MAX_TEXT_CHARS)}\n</document>` }],
      note: truncated ? `the text is truncated to its first ${MAX_TEXT_CHARS} characters` : null,
    };
  }

  return { blocks: [], note: 'this file type cannot be read, so only its metadata is available' };
}
