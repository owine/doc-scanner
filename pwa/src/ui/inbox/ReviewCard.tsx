import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api.js';
import type { ApproveBody, DocumentView, FolderRef } from '../../documents/types.js';
import type { FoldersState } from '../../documents/use-folders.js';
import { FolderPicker } from './FolderPicker.js';
import { SOURCE_LABEL, confirmDiscard, folderLabel } from './labels.js';

export interface ReviewCardProps {
  doc: DocumentView;
  folders: FoldersState;
  onApprove: (body: ApproveBody) => Promise<void>;
  onDiscard: () => Promise<void>;
}

const APPROVE_ERRORS: Record<string, string> = {
  unknown_folder: 'That folder no longer exists in Drive. Pick another.',
  folders_not_loaded: 'The folder list has not loaded from Drive yet. Try again in a moment.',
  name_required: 'Give the document a name.',
  folder_required: 'Pick a folder.',
  invalid_folder_name: 'That folder name has no usable characters. Pick another name.',
  not_found: 'This document no longer exists.',
  not_in_review: 'This document has already moved on.',
  conflict: 'This document has already moved on.',
};

function sameFolder(a: FolderRef | null, b: FolderRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'existing') return b.kind === 'existing' && a.linkId === b.linkId;
  return b.kind === 'new' && a.parentLinkId === b.parentLinkId && a.name === b.name;
}

function bodyFolder(f: FolderRef): NonNullable<ApproveBody['folder']> {
  return f.kind === 'existing' ? { kind: 'existing', linkId: f.linkId } : { kind: 'new', parentLinkId: f.parentLinkId, name: f.name };
}

export function ReviewCard({ doc, folders, onApprove, onDiscard }: ReviewCardProps) {
  const suggested = doc.analysis;
  const [name, setName] = useState(suggested?.name ?? '');
  const [folder, setFolder] = useState<FolderRef | null>(suggested?.folder ?? null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const wasPicking = useRef(false);

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

  return (
    <article class="card review-card" aria-label={`Review ${suggested?.name ?? doc.originalName ?? 'document'}`}>
      <p class="muted">
        {doc.originalName ?? 'Untitled'} · {SOURCE_LABEL[doc.source]}
      </p>
      <label class="field">
        <span class="field-label">Name</span>
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
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
      {suggested?.rationale && <p class="rationale">{suggested.rationale}</p>}
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
      </div>
    </article>
  );
}
