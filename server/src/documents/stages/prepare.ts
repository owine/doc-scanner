import { logger } from '../../logger.js';
import { errorName } from '../../observability/error-name.js';
import { ToolMissingError, ToolTimeoutError } from '../../prepare/run.js';
import { ToolFailedError } from '../../prepare/tools.js';
import type { StageContext } from '../deps.js';
import type { DocumentRow } from '../types.js';

/** Photos of documents become PDFs; these are the image types worth converting. */
const DOCUMENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/gif', 'image/bmp']);

/**
 * What a fallback report carries: the tools' own errors as they are (their
 * messages are fixed text: a tool name, an exit code, a time limit), anything
 * else by its type alone, under a fixed message, since a library's message
 * could quote what it read.
 */
function reportable(err: unknown): Error {
  if (err instanceof ToolMissingError || err instanceof ToolTimeoutError || err instanceof ToolFailedError) return err;
  const fixed = new Error('preparation failed');
  fixed.name = errorName(err);
  return fixed;
}

function fallbackNote(err: unknown, step: 'photo' | 'ocr'): string {
  // The tools come together: img2pdf missing means OCR is missing too.
  if (err instanceof ToolMissingError) return 'No text layer: OCR is not installed on this server.';
  if (step === 'photo') return 'Could not turn the photo into a PDF.';
  if (err instanceof ToolTimeoutError) return 'No text layer: OCR took too long.';
  return 'No text layer: OCR failed.';
}

/**
 * Spec §4: image-only PDFs and document photos become searchable PDFs; the
 * result goes to the inbox's `prepared` blob, which filing sends instead of
 * the original. A failure here never costs the document: the original is
 * filed, with a note. Then a first-page thumbnail for the review card.
 */
export async function prepareStage(doc: DocumentRow, ctx: StageContext): Promise<void> {
  if (doc.filingTarget) {
    // An upload may already have happened (a filing that set its target, then
    // failed, and was discarded and restored). OCR and img2pdf don't produce
    // the same bytes twice, so preparing again would make filing's SHA-1
    // lookup miss that upload and file a duplicate. Keep what was prepared.
    if (!ctx.repo.transition(doc.id, 'preparing', 'ready', { attempts: 0, error: null })) ctx.repo.applyRequestedDiscard(doc.id);
    return;
  }
  // Forget the last run's result before this one writes any blob: the row
  // then describes a prepared blob or thumbnail only once the run that made
  // it has finished. A run that dies part-way (crash, then discard and
  // restore) leaves blobs that nothing will file or serve.
  if (!ctx.repo.transition(doc.id, 'preparing', 'preparing', { preparedMime: null, prepareNote: null, hasThumbnail: false })) {
    ctx.repo.applyRequestedDiscard(doc.id);
    return;
  }
  const original = ctx.inbox.get(doc.id, 'original'); // a missing original is a real failure: the worker retries it
  let prepared: { bytes: Uint8Array; mime: string } | null = null;
  let note: string | null = null;
  let step: 'photo' | 'ocr' = 'ocr';

  try {
    if (doc.mime === 'application/pdf') {
      const r = await ctx.prepare.ocrPdf(original);
      if (r.kind === 'ocred') prepared = { bytes: r.pdf, mime: 'application/pdf' };
    } else if (DOCUMENT_IMAGE_TYPES.has(doc.mime) && doc.analysis?.isDocument) {
      step = 'photo';
      const pdf = await ctx.prepare.imageToPdf(original, doc.mime);
      step = 'ocr';
      const r = await ctx.prepare.ocrPdf(pdf);
      prepared = { bytes: r.kind === 'ocred' ? r.pdf : pdf, mime: 'application/pdf' };
    }
  } catch (err) {
    prepared = null;
    note = fallbackNote(err, step);
    logger.warn({ documentId: doc.id, errName: errorName(err) }, 'document preparation fell back to the original');
    try {
      // Tagged as a fallback: the document carries on. Nothing to redact:
      // the reported error carries no name or document text.
      ctx.report(reportable(err), 'prepare', [], { outcome: 'fallback' });
    } catch {
      // Reporting is best effort; the original is filed either way.
    }
  }

  let thumbnail: Uint8Array | null = null;
  try {
    thumbnail = await ctx.prepare.thumbnail(prepared?.bytes ?? original, prepared?.mime ?? doc.mime);
  } catch (err) {
    logger.warn({ documentId: doc.id, errName: errorName(err) }, 'could not make a thumbnail');
  }

  // A crashed earlier run may have left blobs this run doesn't want.
  if (prepared) ctx.inbox.put(doc.id, 'prepared', prepared.bytes);
  else ctx.inbox.remove(doc.id, 'prepared');
  if (thumbnail) ctx.inbox.put(doc.id, 'thumbnail', thumbnail);
  else ctx.inbox.remove(doc.id, 'thumbnail');

  const moved = ctx.repo.transition(doc.id, 'preparing', 'ready', {
    preparedMime: prepared?.mime ?? doc.mime,
    prepareNote: note,
    hasThumbnail: thumbnail !== null,
    attempts: 0,
    error: null,
  });
  if (!moved) {
    // A discard won: drop this run's result, so a restored document never
    // files a prepared blob its row doesn't describe.
    ctx.inbox.remove(doc.id, 'prepared');
    ctx.inbox.remove(doc.id, 'thumbnail');
    ctx.repo.applyRequestedDiscard(doc.id);
  }
}
