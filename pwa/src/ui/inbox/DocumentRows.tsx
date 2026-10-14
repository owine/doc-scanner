import { useState } from 'preact/hooks';
import { DISCARD_RETENTION_MS } from '../../documents/group.js';
import type { DocumentView } from '../../documents/types.js';
import { StateDot } from './StateDot.js';
import { WAITING_LABEL, displayName, safeDriveUrl } from './labels.js';

const nameId = (doc: DocumentView) => `doc-name-${doc.id}`;

function ActionButton({
  label,
  describedBy,
  onClick,
  secondary = false,
}: {
  label: string;
  describedBy: string;
  onClick: () => Promise<void>;
  secondary?: boolean;
}) {
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
    <button class={secondary ? 'btn btn-secondary btn-small' : 'btn btn-small'} disabled={busy} aria-describedby={describedBy} onClick={() => void run()}>
      {failed ? `${label} (failed, try again)` : label}
    </button>
  );
}

export function WaitingRow({ doc, onDiscard }: { doc: DocumentView; onDiscard: () => Promise<void> }) {
  return (
    <li class="doc-row">
      <StateDot state="work" />
      <div class="doc-main">
        <div class="doc-name" id={nameId(doc)}>{displayName(doc)}</div>
        <div class="muted">{doc.discardRequested ? 'Discarding…' : (WAITING_LABEL[doc.state] ?? doc.state)}</div>
        {doc.anchorName && <div class="muted">Paired with “{doc.anchorName}”</div>}
      </div>
      {/* A working document's discard is applied when its current step ends.
          Not while an upload is under way: the server files it regardless. */}
      {!doc.discardRequested && !(doc.state === 'filing' && doc.possiblyInDrive) && (
        <ActionButton label="Discard" describedBy={nameId(doc)} onClick={onDiscard} secondary />
      )}
    </li>
  );
}

export function FiledRow({ doc }: { doc: DocumentView }) {
  const url = safeDriveUrl(doc.filed?.driveUrl);
  return (
    <li class="doc-row">
      <StateDot state="ok" />
      <div class="doc-main">
        <div class="doc-name" id={nameId(doc)}>{displayName(doc)}</div>
        <div class="muted">{doc.filed?.folderPath ?? ''}</div>
        {doc.prepareNote && <div class="muted">{doc.prepareNote}</div>}
      </div>
      <span class={doc.autoFiled ? 'chip chip-auto' : 'chip'}>{doc.autoFiled ? 'auto' : doc.userEdited ? 'you edited' : 'you approved'}</span>
      {url && (
        <a class="btn btn-secondary btn-small" href={url} target="_blank" rel="noopener noreferrer" aria-describedby={nameId(doc)}>
          Open in Drive
        </a>
      )}
    </li>
  );
}

export function FailedRow({ doc, onRetry, onDiscard }: { doc: DocumentView; onRetry: () => Promise<void>; onDiscard: () => Promise<void> }) {
  return (
    <li class="doc-row">
      <StateDot state="bad" />
      <div class="doc-main">
        <div class="doc-name" id={nameId(doc)}>{displayName(doc)}</div>
        <div class="error-text">{doc.error ?? 'Failed'}</div>
      </div>
      <ActionButton label="Retry" describedBy={nameId(doc)} onClick={onRetry} />
      <ActionButton label="Discard" describedBy={nameId(doc)} onClick={onDiscard} secondary />
    </li>
  );
}

export function DiscardedRow({ doc, now, onRestore }: { doc: DocumentView; now: Date; onRestore: () => Promise<void> }) {
  const left = doc.discardedAt ? Date.parse(doc.discardedAt) + DISCARD_RETENTION_MS - now.getTime() : 0;
  const days = Math.max(1, Math.ceil(left / 86_400_000));
  return (
    <li class="doc-row">
      <StateDot state="idle" />
      <div class="doc-main">
        <div class="doc-name" id={nameId(doc)}>{displayName(doc)}</div>
        <div class="muted">
          {doc.combinedInto ? 'Combined into another document · ' : ''}Deleted in {days} {days === 1 ? 'day' : 'days'}
        </div>
      </div>
      <ActionButton label="Restore" describedBy={nameId(doc)} onClick={onRestore} secondary />
    </li>
  );
}
