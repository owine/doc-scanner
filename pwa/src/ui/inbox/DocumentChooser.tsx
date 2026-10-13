import { useEffect, useRef, useState } from 'preact/hooks';
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
  /** Called with every id to combine, the current card's first. */
  onCombine: (ids: string[]) => Promise<void>;
  onFileWith: (anchorId: string) => Promise<void>;
  onCancel: () => void;
}

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
    case 'conflict':
    case 'not_in_review':
    case 'invalid_anchor':
    case 'not_found':
      return 'Something changed; the list has been refreshed.';
    default:
      return 'Could not do that. Try again.';
  }
}

/** Inline in the review card, like the folder picker: Combine with… or File with…. */
export function DocumentChooser({ mode, current, review, filed, onCombine, onFileWith, onCancel }: DocumentChooserProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);

  const all = [current, ...review, ...filed];
  const byId = new Map(all.map((d) => [d.id, d]));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err, all));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }
  function move(id: string, by: -1 | 1) {
    setChosen((c) => {
      const i = c.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const next = [...c];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  const row = (d: DocumentView) => (
    <>
      {displayName(d)}
      {anchorFolder(d) && <span class="muted"> · {anchorFolder(d)}</span>}
    </>
  );
  const anchors = anchorCandidates(current, review, filed);
  const section = (title: string, docs: DocumentView[]) =>
    docs.length > 0 && (
      <>
        <h4>{title}</h4>
        <ul class="folder-results">
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" class="folder-result" disabled={busy} onClick={() => void run(() => onFileWith(d.id))}>
                {row(d)}
              </button>
            </li>
          ))}
        </ul>
      </>
    );

  return (
    <div class="doc-chooser" role="group" aria-label={mode === 'combine' ? 'Combine with other documents' : 'File with another document'}>
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
          <ol class="folder-results chooser-order" aria-label="Page order">
            {[current.id, ...chosen].map((id, i) => {
              const d = byId.get(id)!;
              return (
                <li key={id}>
                  <span class="chooser-option">
                    {i + 1}. {displayName(d)}
                  </span>
                  {i > 0 && (
                    <>
                      <button type="button" class="btn btn-secondary btn-small btn-square" disabled={i === 1} aria-label={`Move ${displayName(d)} up`} onClick={() => move(id, -1)}>
                        ↑
                      </button>
                      <button type="button" class="btn btn-secondary btn-small btn-square" disabled={i === chosen.length} aria-label={`Move ${displayName(d)} down`} onClick={() => move(id, 1)}>
                        ↓
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          <ul class="folder-results" aria-label="Documents in review">
            {combineCandidates(current, review)
              .filter((d) => matches(d, query))
              .map((d) => (
                <li key={d.id}>
                  <label class="chooser-option">
                    <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => toggle(d.id)} />
                    <span>{row(d)}</span>
                  </label>
                </li>
              ))}
          </ul>
          <div class="actions">
            <button type="button" class="btn" disabled={busy || chosen.length === 0} onClick={() => void run(() => onCombine([current.id, ...chosen]))}>
              Combine {chosen.length + 1}
            </button>
            <button type="button" class="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {section('In review', anchors.review.filter((d) => matches(d, query)))}
          {section('Recently filed', anchors.filed.filter((d) => matches(d, query)))}
          <button type="button" class="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
