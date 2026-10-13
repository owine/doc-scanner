import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api.js';
import type { ApproveBody, DocumentView, FolderRef } from '../../documents/types.js';
import type { FoldersState } from '../../documents/use-folders.js';
import { anchorCandidates, combineCandidates } from './choose.js';
import { DocumentChooser, type ChooserMode } from './DocumentChooser.js';
import { FolderPicker } from './FolderPicker.js';
import { SOURCE_LABEL, confirmDiscard, folderLabel } from './labels.js';

export interface ReviewCardProps {
  doc: DocumentView;
  folders: FoldersState;
  onApprove: (body: ApproveBody) => Promise<void>;
  onDiscard: () => Promise<void>;
  /** Every card in review, and recently filed documents: what Combine with… and File with… offer. */
  review?: DocumentView[];
  filed?: DocumentView[];
  onCombine?: (ids: string[]) => Promise<void>;
  /** Re-analyze, or with an anchor id, File with. */
  onReanalyze?: (anchorId?: string) => Promise<void>;
}

const APPROVE_ERRORS: Record<string, string> = {
  unknown_folder: 'That folder no longer exists in Drive. Pick another.',
  excluded_folder: 'That folder is on your never-file-here list. Pick another.',
  folders_not_loaded: 'The folder list has not loaded from Drive yet. Try again in a moment.',
  name_required: 'Give the document a name.',
  folder_required: 'Pick a folder.',
  invalid_folder_name: 'That folder name has no usable characters. Pick another name.',
  not_found: 'This document no longer exists.',
  not_in_review: 'This document has already moved on.',
  conflict: 'This document has already moved on.',
};

/**
 * Sets autocorrect="off" as an attribute. iOS Safari has a boolean
 * `autocorrect` property, which Preact would set instead, and the string
 * "off" is truthy there: it would turn autocorrect on.
 */
function noAutocorrect(el: HTMLInputElement | null) {
  el?.setAttribute('autocorrect', 'off');
}

function sameFolder(a: FolderRef | null, b: FolderRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'existing') return b.kind === 'existing' && a.linkId === b.linkId;
  return b.kind === 'new' && a.parentLinkId === b.parentLinkId && a.name === b.name;
}

function bodyFolder(f: FolderRef): NonNullable<ApproveBody['folder']> {
  return f.kind === 'existing' ? { kind: 'existing', linkId: f.linkId } : { kind: 'new', parentLinkId: f.parentLinkId, name: f.name };
}

export function ReviewCard({ doc, folders, onApprove, onDiscard, review = [], filed = [], onCombine, onReanalyze }: ReviewCardProps) {
  const suggested = doc.analysis;
  const [name, setName] = useState(suggested?.name ?? '');
  const [folder, setFolder] = useState<FolderRef | null>(suggested?.folder ?? null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const wasPicking = useRef(false);
  const [menu, setMenu] = useState(false);
  const [choosing, setChoosing] = useState<ChooserMode | null>(null);
  const canCombine = !!onCombine && combineCandidates(doc, review).length > 0;
  const anchors = anchorCandidates(doc, review, filed);
  const canFileWith = anchors.review.length + anchors.filed.length > 0;

  const moreRef = useRef<HTMLButtonElement>(null);
  const wasChoosing = useRef(false);
  // Hand focus back to More when the chooser closes.
  useEffect(() => {
    if (wasChoosing.current && !choosing) moreRef.current?.focus();
    wasChoosing.current = !!choosing;
  }, [choosing]);

  // Hand focus back to Change when the picker closes, not to <body>.
  useEffect(() => {
    if (wasPicking.current && !picking) changeRef.current?.focus();
    wasPicking.current = picking;
  }, [picking]);

  async function approve() {
    if (!folder || !name.trim()) return;
    // Only what changed: the server files omitted fields as suggested.
    const body: ApproveBody = {};
    if (name.trim() !== suggested?.name) body.name = name.trim();
    if (!sameFolder(folder, suggested?.folder ?? null)) body.folder = bodyFolder(folder);
    setBusy(true);
    setError(null);
    try {
      await onApprove(body);
    } catch (err) {
      setError((err instanceof ApiError && err.code && APPROVE_ERRORS[err.code]) || 'Could not approve. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirmDiscard(doc)) return;
    setBusy(true);
    setError(null);
    try {
      await onDiscard();
    } catch {
      setError('Could not discard. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function reanalyze() {
    if (!onReanalyze) return;
    setBusy(true);
    setError(null);
    try {
      await onReanalyze();
    } catch {
      setError('Could not re-analyse. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article class="card review-card" aria-label={`Review ${suggested?.name ?? doc.originalName ?? 'document'}`}>
      {/* Hidden if it won't load (a signed-out session, a document filed meanwhile) rather than shown broken. */}
      {doc.hasThumbnail && (
        <img
          class="review-thumb"
          src={`/api/documents/${encodeURIComponent(doc.id)}/thumbnail`}
          alt="First page preview"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).hidden = true;
          }}
        />
      )}
      <p class="muted">
        {doc.originalName ?? 'Untitled'} · {SOURCE_LABEL[doc.source]}
      </p>
      <label class="field">
        <span class="field-label">Name</span>
        <input
          ref={noAutocorrect}
          value={name}
          autocapitalize="off"
          spellcheck={false}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="field" role="group" aria-labelledby={`folder-label-${doc.id}`}>
        <span class="field-label" id={`folder-label-${doc.id}`}>
          Folder
        </span>
        {picking ? (
          <FolderPicker
            folders={folders}
            allowNew
            onChoose={(f) => {
              setFolder(f);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <div class="folder-row">
            {folder ? <span>{folderLabel(folder)}</span> : <em class="muted">No folder suggested</em>}
            {folder?.kind === 'new' && <span class="badge">New folder</span>}
            <button ref={changeRef} class="btn btn-secondary btn-small" disabled={busy} onClick={() => setPicking(true)}>
              Change
            </button>
          </div>
        )}
      </div>
      {suggested && (
        <p class="muted">
          {Math.round(suggested.confidence * 100)}% confident{doc.reviewReason ? ` · ${doc.reviewReason}` : ''}
        </p>
      )}
      {doc.anchorName && <p class="muted">Filed with “{doc.anchorName}”</p>}
      {suggested?.rationale && <p class="rationale">{suggested.rationale}</p>}
      {doc.prepareNote && <p class="muted">{doc.prepareNote}</p>}
      {suggested?.contentSeen === false && <p class="muted">Analysed from the file's details only; its contents could not be read.</p>}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        <button class="btn" disabled={busy || !name.trim() || !folder} onClick={() => void approve()}>
          Approve
        </button>
        <button class="btn btn-secondary" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
        {onReanalyze && !doc.possiblyInDrive && (
          <button
            ref={moreRef}
            class="btn btn-secondary"
            aria-expanded={menu && !choosing}
            aria-controls={menu && !choosing ? `more-${doc.id}` : undefined}
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
      {menu && !choosing && onReanalyze && (
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
      {choosing && onReanalyze && (
        <DocumentChooser
          mode={choosing}
          current={doc}
          review={review}
          filed={filed}
          onCombine={async (ids) => {
            await onCombine?.(ids);
          }}
          onFileWith={(anchorId) => onReanalyze(anchorId)}
          onCancel={() => {
            setChoosing(null);
            setMenu(false);
          }}
        />
      )}
    </article>
  );
}
