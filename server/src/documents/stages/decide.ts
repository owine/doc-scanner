import type { Analysis } from '../../analyze/types.js';
import type { EffectiveSettings } from '../../settings/settings-store.js';
import type { StageContext } from '../deps.js';
import type { DocumentRow } from '../types.js';

/**
 * Why this analysis can't be filed without the user, or null when it can:
 * auto-filing is on, the folder is an existing one, and the model's
 * confidence clears the threshold (spec §1).
 */
export function reviewReason(a: Analysis | null, s: EffectiveSettings): string | null {
  if (!a) return 'no analysis';
  if (!s.autoFileEnabled) return 'auto-filing is off';
  if (a.folder === null) return 'no folder chosen';
  if (a.folder.kind === 'new') return 'new folder proposed';
  if (a.confidence < s.autoFileThreshold) {
    return `confidence ${a.confidence.toFixed(2)} is below ${s.autoFileThreshold.toFixed(2)}`;
  }
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
        })
      : ctx.repo.transition(doc.id, 'ready', 'needs_review', { reviewReason: reason });
  if (!moved) ctx.repo.applyRequestedDiscard(doc.id);
}
