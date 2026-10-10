import type { StageContext } from '../deps.js';
import type { DocumentRow } from '../types.js';

/**
 * Slice 1: files the original as-is. Slice 3 replaces this with OCR
 * (ocrmypdf), photo-to-PDF and thumbnails, writing the result to the inbox's
 * `prepared` blob; filing already prefers that blob when it exists.
 */
export async function prepareStage(doc: DocumentRow, ctx: StageContext): Promise<void> {
  if (!ctx.repo.transition(doc.id, 'preparing', 'ready', { preparedMime: doc.mime })) {
    ctx.repo.applyRequestedDiscard(doc.id);
  }
}
