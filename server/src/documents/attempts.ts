import type { StageContext } from './deps.js';
import type { DocumentPatch, DocumentRow, DocumentState } from './types.js';

export const MAX_ATTEMPTS = 3;

/**
 * Every attempt this row was allowed began and none finished: the server
 * stopped mid-stage (killed for memory, a hang ended by a restart). Fixed
 * text, as it reaches the row and the failure report.
 */
export class StageDidNotFinishError extends Error {
  constructor() {
    super('the stage did not finish: the server stopped or ran out of memory while working on it');
    this.name = 'StageDidNotFinishError';
  }
}

/**
 * Counts this run as an attempt before the stage reads the document's bytes,
 * not after it fails: an input that kills or hangs the process never reaches
 * the worker's catch, and would otherwise run first again after every restart,
 * with no limit. A stage calls it once it is past the waits that read nothing
 * (no folder tree yet, no login), which must not use up attempts.
 *
 * The worker's recordFailure writes the same count again (attempts read before
 * the stage, plus one), so a failure it does catch is counted once; every
 * success transition resets attempts to 0.
 *
 * Throws StageDidNotFinishError when every attempt has been used, for the
 * worker to fail the row; returns false when a discard won the row.
 */
export function beginAttempt(doc: DocumentRow, ctx: StageContext, to: DocumentState, patch: DocumentPatch = {}): boolean {
  if (doc.attempts >= MAX_ATTEMPTS) throw new StageDidNotFinishError();
  return ctx.repo.transition(doc.id, doc.state, to, { ...patch, attempts: doc.attempts + 1 });
}
