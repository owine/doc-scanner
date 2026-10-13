import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DocumentView } from '../../documents/types.js';
import { anchorCandidates, combineCandidates } from './choose.js';
import { DocumentChooser, type ChooserMode } from './DocumentChooser.js';

export interface MoreActionsProps {
  doc: DocumentView;
  /** Every card in review, and recently filed documents: what Combine with… and File with… offer. */
  review: DocumentView[];
  filed: DocumentView[];
  /** The card's one busy state, and the wrapper that sets it around a request. */
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<{ error: unknown } | null>;
  onCombine?: ((ids: string[]) => Promise<void>) | undefined;
  /** Re-analyze, or with an anchor id, File with. */
  onReanalyze: (anchorId?: string) => Promise<void>;
  /** A plain Re-analyse failed. */
  onReanalyzeError: (error: unknown) => void;
  /** The card's own buttons, shown before More in the same row. */
  children?: ComponentChildren;
}

/**
 * The actions row of a review card, with a More button and what it opens:
 * Combine with…, File with… and Re-analyse. The server refuses all three for a
 * document that may already be in Drive, so such a card gets no More button.
 */
export function MoreActions({ doc, review, filed, busy, run, onCombine, onReanalyze, onReanalyzeError, children }: MoreActionsProps) {
  const [menu, setMenu] = useState(false);
  const [choosing, setChoosing] = useState<ChooserMode | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const wasChoosing = useRef(false);

  // Hand focus back to More when the chooser closes.
  useEffect(() => {
    if (wasChoosing.current && !choosing) moreRef.current?.focus();
    wasChoosing.current = !!choosing;
  }, [choosing]);

  const enabled = !doc.possiblyInDrive;
  const canCombine = !!onCombine && combineCandidates(doc, review).length > 0;
  const anchors = anchorCandidates(doc, review, filed);
  const canFileWith = anchors.review.length + anchors.filed.length > 0;
  const showMenu = enabled && menu && !choosing;

  async function reanalyze() {
    const failed = await run(() => onReanalyze());
    if (failed) onReanalyzeError(failed.error);
  }

  return (
    <>
      <div class="actions">
        {children}
        {enabled && (
          <button
            ref={moreRef}
            class="btn btn-secondary"
            aria-expanded={showMenu}
            aria-controls={showMenu ? `more-${doc.id}` : undefined}
            disabled={busy}
            onClick={() => {
              setMenu((m) => !m);
              setChoosing(null);
            }}
          >
            <span aria-hidden="true">⋯ </span>More
          </button>
        )}
      </div>
      {showMenu && (
        <div class="actions" id={`more-${doc.id}`}>
          {canCombine && (
            <button class="btn btn-secondary btn-small" disabled={busy} onClick={() => setChoosing('combine')}>
              Combine with…
            </button>
          )}
          {canFileWith && (
            <button class="btn btn-secondary btn-small" disabled={busy} onClick={() => setChoosing('file-with')}>
              File with…
            </button>
          )}
          <button class="btn btn-secondary btn-small" disabled={busy} onClick={() => void reanalyze()}>
            Re-analyse
          </button>
        </div>
      )}
      {enabled && choosing && (
        <DocumentChooser
          mode={choosing}
          current={doc}
          review={review}
          filed={filed}
          busy={busy}
          run={run}
          onCombine={onCombine ?? (async () => {})}
          onFileWith={(anchorId) => onReanalyze(anchorId)}
          onCancel={() => {
            setChoosing(null);
            setMenu(false);
          }}
        />
      )}
    </>
  );
}
