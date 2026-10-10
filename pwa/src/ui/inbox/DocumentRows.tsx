import { useState } from 'preact/hooks';
import { DISCARD_RETENTION_MS } from '../../documents/group.js';
import type { DocumentView } from '../../documents/types.js';
import { WAITING_LABEL, displayName, safeDriveUrl } from './labels.js';

function ActionButton({ label, onClick, secondary = false }: { label: string; onClick: () => Promise<void>; secondary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function run() {
    setBusy(true);
    setFailed(false);
    try {
      await onClick();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button class={secondary ? 'btn btn-secondary btn-small' : 'btn btn-small'} disabled={busy} onClick={() => void run()}>
      {failed ? `${label} (failed, try again)` : label}
    </button>
  );
}

export function WaitingRow({ doc, onDiscard }: { doc: DocumentView; onDiscard: () => Promise<void> }) {
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name">{displayName(doc)}</div>
        <div class="muted">{doc.discardRequested ? 'Discarding…' : (WAITING_LABEL[doc.state] ?? doc.state)}</div>
      </div>
      {/* A working document's discard is applied when its current step ends.
          Not while an upload is under way: the server files it regardless. */}
      {!doc.discardRequested && !(doc.state === 'filing' && doc.possiblyInDrive) && (
        <ActionButton label="Discard" onClick={onDiscard} secondary />
      )}
    </li>
  );
}

export function FiledRow({ doc }: { doc: DocumentView }) {
  const url = safeDriveUrl(doc.filed?.driveUrl);
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name">{displayName(doc)}</div>
        <div class="muted">{doc.filed?.folderPath ?? ''}</div>
      </div>
      <span class={doc.autoFiled ? 'chip chip-auto' : 'chip'}>{doc.autoFiled ? 'auto' : doc.userEdited ? 'you edited' : 'you approved'}</span>
      {url && (
        <a class="btn btn-secondary btn-small" href={url} target="_blank" rel="noopener noreferrer">
          Open in Drive
        </a>
      )}
    </li>
  );
}

export function FailedRow({ doc, onRetry, onDiscard }: { doc: DocumentView; onRetry: () => Promise<void>; onDiscard: () => Promise<void> }) {
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name">{displayName(doc)}</div>
        <div class="error-text">{doc.error ?? 'Failed'}</div>
      </div>
      <ActionButton label="Retry" onClick={onRetry} />
      <ActionButton label="Discard" onClick={onDiscard} secondary />
    </li>
  );
}

export function DiscardedRow({ doc, now, onRestore }: { doc: DocumentView; now: Date; onRestore: () => Promise<void> }) {
  const left = doc.discardedAt ? Date.parse(doc.discardedAt) + DISCARD_RETENTION_MS - now.getTime() : 0;
  const days = Math.max(1, Math.ceil(left / 86_400_000));
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name">{displayName(doc)}</div>
        <div class="muted">Deleted in {days} {days === 1 ? 'day' : 'days'}</div>
      </div>
      <ActionButton label="Restore" onClick={onRestore} secondary />
    </li>
  );
}
