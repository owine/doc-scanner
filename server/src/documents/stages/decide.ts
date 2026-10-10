import type { Analysis } from '../../analyze/types.js';
import { isUnderAny } from '../../drive/folder-tree.js';
import { logger } from '../../logger.js';
import type { EffectiveSettings } from '../../settings/settings-store.js';
import type { StageContext } from '../deps.js';
import type { DocumentRow } from '../types.js';

/**
 * Why this analysis can't be filed without the user, or null when it can:
 * the folder is an existing one outside the never-file-here list, the model's
 * confidence clears the threshold, and auto-filing is on (spec §1). The
 * switch is checked last so the reason names what the user would have to fix.
 * Reasons never contain document or folder names.
 */
export function reviewReason(a: Analysis | null, s: EffectiveSettings): string | null {
  if (!a) return 'no analysis';
  if (a.folder === null) return 'no folder chosen';
  if (a.folder.kind === 'new') return 'new folder proposed';
  if (isUnderAny(a.folder.path, s.excludePaths)) return 'folder is on the never-file-here list';
  if (a.confidence < s.autoFileThreshold) {
    return `confidence ${a.confidence.toFixed(3)} is below ${s.autoFileThreshold.toFixed(2)}`;
  }
  if (!s.autoFileEnabled) return 'auto-filing is off';
  return null;
}

export function decideStage(doc: DocumentRow, ctx: StageContext): void {
  const a = doc.analysis;
  const reason = reviewReason(a, ctx.settings.get());
  const moved =
    reason === null && a && a.folder
      ? ctx.repo.transition(doc.id, 'ready', 'filing', {
          decision: { name: a.name, folder: a.folder },
          autoFiled: true,
          nextAttemptAt: ctx.now(),
          attempts: 0,
          error: null,
        })
      : ctx.repo.transition(doc.id, 'ready', 'needs_review', { reviewReason: reason, attempts: 0, error: null });
  if (moved) logger.info({ documentId: doc.id, outcome: reason === null ? 'auto-filed' : 'review', reason }, 'document decided');
  else ctx.repo.applyRequestedDiscard(doc.id);
}
