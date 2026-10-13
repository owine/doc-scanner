import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api.js';
import type { DocumentView } from '../../documents/types.js';
import { anchorCandidates, anchorFolder, combineCandidates, matches } from './choose.js';
import { displayName } from './labels.js';

export type ChooserMode = 'combine' | 'file-with';

export interface DocumentChooserProps {
  mode: ChooserMode;
  current: DocumentView;
  /** Every card in review (the current one included; it is left out here). */
  review: DocumentView[];
  /** Recently filed documents, offered by File with. */
  filed: DocumentView[];
  /** The card's one busy state: set while any request from the card is under way. */
  busy: boolean;
  /** Runs a request under the card's busy state. Resolves to the error it threw, or null; never rejects. */
  run: (fn: () => Promise<void>) => Promise<{ error: unknown } | null>;
  /** Called with every id to combine, the current card's first. */
  onCombine: (ids: string[]) => Promise<void>;
  onFileWith: (anchorId: string) => Promise<void>;
  onCancel: () => void;
}

/** The server combines 2 to 10 documents. */
const MAX_COMBINE = 10;

const REFUSAL: Record<string, string> = {
  encrypted: 'it is password-protected',
  signed: 'it is digitally signed',
  dynamic_form: 'it is a dynamic form that can’t be copied',
  unreadable: 'it could not be read',
  unsupported_type: 'it is not a PDF or photo',
};

function errorText(err: unknown, docs: readonly DocumentView[]): string {
  if (!(err instanceof ApiError)) return 'Could not reach the server. Try again.';
  switch (err.code) {
    case 'cannot_combine': {
      if (err.body.reason === 'too_large') return 'These documents are too large to combine.';
      const part = docs.find((d) => d.id === err.body.documentId);
      const why = REFUSAL[String(err.body.reason)] ?? 'it could not be read';
      return part ? `“${displayName(part)}” can’t be combined: ${why}.` : `One document can’t be combined: ${why}.`;
    }
    case 'possibly_in_drive':
      return 'This document may already be in Drive, so it can’t be changed.';
    case 'invalid_input':
      return 'Could not do that. Pick up to 10 documents and try again.';
    case 'invalid_anchor':
      return 'That document can’t be used. Pick another.';
    case 'conflict':
    case 'not_in_review':
    case 'not_found':
      return 'Something changed; the list is being updated.';
    default:
      return 'Could not do that. Try again.';
  }
}

/** Inline in the review card, like the folder picker: Combine with… or File with…. */
export function DocumentChooser({ mode, current, review, filed, busy, run, onCombine, onFileWith, onCancel }: DocumentChooserProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moved, setMoved] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => searchRef.current?.focus(), []);
  // Moving an item re-orders the DOM, which can drop focus: put it back on the button pressed.
  useLayoutEffect(() => {
    if (moved) moveButtons.current.get(moved)?.focus();
  }, [moved]);

  const all = [current, ...review, ...filed];
  const byId = new Map(all.map((d) => [d.id, d]));
  // A checked part may leave review while this is open (a poll, a refused combine): drop it from the selection.
  const offered = combineCandidates(current, review);
  const picked = chosen.filter((id) => offered.some((d) => d.id === id));
  const atCap = picked.length >= MAX_COMBINE - 1;
  const visible = offered.filter((d) => matches(d, query));
  const searching = query.trim() !== '';

  async function submit(fn: () => Promise<void>) {
    setError(null);
    const failed = await run(fn);
    if (failed) setError(errorText(failed.error, all));
  }

  function toggle(id: string) {
    setChosen(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  }
  function move(id: string, by: -1 | 1) {
    const i = picked.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= picked.length) return;
    const next = [...picked];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setChosen(next);
    // Position counts the pinned current card as 1.
    setAnnouncement(`${displayName(byId.get(id)!)} is now position ${j + 2}`);
    setMoved(`${id}:${by}`);
  }

  const row = (d: DocumentView) => (
    <>
      {displayName(d)}
      {anchorFolder(d) && <span class="muted"> · {anchorFolder(d)}</span>}
    </>
  );
  const anchors = anchorCandidates(current, review, filed);
  const anchorsIn = (docs: DocumentView[]) => docs.filter((d) => matches(d, query));
  const nothingToFileWith = anchors.review.length + anchors.filed.length === 0;
  const noAnchorMatches = anchorsIn(anchors.review).length + anchorsIn(anchors.filed).length === 0;
  const section = (title: string, docs: DocumentView[]) =>
    docs.length > 0 && (
      <>
        <h3>{title}</h3>
        <ul class="folder-results" role="list">
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" class="folder-result" disabled={busy} onClick={() => void submit(() => onFileWith(d.id))}>
                {row(d)}
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  const moveButton = (id: string, dir: -1 | 1, edge: boolean) => {
    const name = displayName(byId.get(id)!);
    return (
      <button
        type="button"
        ref={(el) => {
          if (el) moveButtons.current.set(`${id}:${dir}`, el);
          else moveButtons.current.delete(`${id}:${dir}`);
        }}
        class="btn btn-secondary btn-small btn-square"
        // aria-disabled, not disabled: focus stays on the button when an item reaches an edge.
        aria-disabled={edge ? 'true' : undefined}
        disabled={busy}
        aria-label={`Move ${name} ${dir < 0 ? 'up' : 'down'}`}
        onClick={() => move(id, dir)}
      >
        {dir < 0 ? '↑' : '↓'}
      </button>
    );
  };

  return (
    <div
      class="doc-chooser"
      role="group"
      aria-label={mode === 'combine' ? 'Combine with other documents' : 'File with another document'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.isComposing && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        ref={searchRef}
        type="search"
        aria-label="Search documents"
        placeholder="Search documents"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      <div role="alert">{error && <p class="error-text">{error}</p>}</div>

      {mode === 'combine' ? (
        <>
          <div role="status" class="visually-hidden">
            {announcement}
          </div>
          <ol class="folder-results" role="list" aria-label="Order">
            {[current.id, ...picked].map((id, i) => (
              <li key={id}>
                <span class="chooser-option">
                  {i + 1}. {displayName(byId.get(id)!)}
                </span>
                {i > 0 && (
                  <>
                    {moveButton(id, -1, i === 1)}
                    {moveButton(id, 1, i === picked.length)}
                  </>
                )}
              </li>
            ))}
          </ol>
          {atCap && <p class="muted">Up to {MAX_COMBINE} documents can be combined.</p>}
          {searching && visible.length === 0 && <p class="muted">No matching documents.</p>}
          {visible.length > 0 && (
            <ul class="folder-results" role="list" aria-label="Documents in review">
              {visible.map((d) => (
                <li key={d.id}>
                  <label class="chooser-option">
                    <input
                      type="checkbox"
                      checked={picked.includes(d.id)}
                      disabled={busy || (atCap && !picked.includes(d.id))}
                      onChange={() => toggle(d.id)}
                    />
                    <span>{row(d)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div class="actions">
            <button type="button" class="btn" disabled={busy || picked.length === 0} onClick={() => void submit(() => onCombine([current.id, ...picked]))}>
              Combine {picked.length + 1}
            </button>
            <button type="button" class="btn btn-secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {section('In review', anchorsIn(anchors.review))}
          {section('Recently filed', anchorsIn(anchors.filed))}
          {nothingToFileWith && !searching && <p class="muted">No documents to file with.</p>}
          {searching && noAnchorMatches && <p class="muted">No matching documents.</p>}
          <button type="button" class="btn btn-secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
