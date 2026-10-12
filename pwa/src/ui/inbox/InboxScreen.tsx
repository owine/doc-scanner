import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api.js';
import { documentsApi, type DocumentsApi } from '../../documents/api.js';
import { groupDocuments } from '../../documents/group.js';
import { useDocuments, type DocumentSync } from '../../documents/sync.js';
import type { ApproveBody, DocumentView } from '../../documents/types.js';
import { useFolders } from '../../documents/use-folders.js';
import { DiscardedRow, FailedRow, FiledRow, WaitingRow } from './DocumentRows.js';
import { confirmDiscard } from './labels.js';
import { ReviewCard } from './ReviewCard.js';
import type { ScansStore } from '../../scanner/scans-store.js';
import { useUploads, type UploadQueue } from '../../uploads/queue.js';
import { UploadRow } from './UploadRows.js';

export interface InboxScreenProps {
  sync: DocumentSync;
  /** Must be stable across renders: the folder list reloads whenever it changes. */
  documents?: DocumentsApi;
  now?: () => Date;
  onScan: () => void;
  onSettings: () => void;
  onSignInAgain: () => void;
  /** Must be stable across renders, like `documents`. */
  uploads: UploadQueue;
  /** Must be stable. Task 6 lists its finished scans; the inbox shares App's open. */
  scans: ScansStore;
}

function Section({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return (
    <section aria-labelledby={`h-${id}`}>
      <h2 id={`h-${id}`}>{title}</h2>
      <ul class="doc-list" role="list">{children}</ul>
    </section>
  );
}

export function InboxScreen({
  sync,
  documents = documentsApi,
  now = () => new Date(),
  onScan,
  onSettings,
  onSignInAgain,
  uploads,
}: InboxScreenProps) {
  const { docs, loaded, error } = useDocuments(sync);
  const pending = useUploads(uploads);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addFiles = (files: ArrayLike<File> | null | undefined) => {
    const chosen = Array.from(files ?? []);
    if (chosen.length === 0) return;
    setAddError(null);
    uploads.add(chosen.map((f) => ({ blob: f, name: f.name, source: 'picker' as const }))).catch((e: unknown) => {
      // The error's name only: the files' names stay on this device.
      console.error('could not add files', (e as Error)?.name);
      setAddError("Couldn't add the files. Try again.");
    });
  };
  // A coarse clock. The server purges discarded documents without bumping their
  // seq, so the change feed never removes them; the day counts need it too.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const folders = useFolders(documents);
  const g = groupDocuments(docs, now());

  // Read the document back: a poll already in flight may predate the action.
  // Failing to read it back must not report the action as failed.
  const readBack = async (id: string) => {
    try {
      sync.upsert(await documents.get(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        sync.remove(id);
        return;
      }
      // Best effort: this may join a poll already in flight, which can predate the change.
      void sync.poll();
    }
  };
  // A 409 means the document already moved on (another device, or the worker):
  // show where it is now. A 404 means it is gone (purged). Either way the action
  // is not reported as failed.
  const handleRefused = async (id: string, err: unknown) => {
    if (err instanceof ApiError && err.status === 404) {
      sync.remove(id);
      return;
    }
    if (!(err instanceof ApiError && err.status === 409)) throw err;
    await readBack(id);
  };
  // A refused approval is still reported, so a card that stays (the read-back
  // failed, or was older than the refusal) says the document moved on.
  const approve = async (id: string, body: ApproveBody) => {
    try {
      sync.upsert(await documents.approve(id, body));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await readBack(id);
      throw err;
    }
  };
  const act = async (id: string, run: () => Promise<DocumentView | null>) => {
    try {
      const doc = await run();
      if (doc) sync.upsert(doc);
    } catch (err) {
      await handleRefused(id, err);
    }
  };
  const discard = async (id: string) => {
    let done = false;
    await act(id, async () => {
      await documents.discard(id);
      done = true;
      return null;
    });
    if (done) await readBack(id);
  };
  // Rows outside the review card confirm here; the card confirms itself.
  const confirmedDiscard = async (d: DocumentView) => {
    if (confirmDiscard(d)) await discard(d.id);
  };
  const restore = (id: string) => act(id, () => documents.restore(id));
  const retry = (id: string) => act(id, () => documents.retry(id));

  return (
    <main
      class="inbox"
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault(); // allows the drop
        setDragging(true);
      }}
      onDragLeave={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !e.currentTarget.contains(to)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer?.files);
      }}
    >
      {dragging && (
        <div class="drop-overlay" aria-hidden="true">
          Drop files to add them
        </div>
      )}
      <input
        type="file"
        multiple
        ref={fileInput}
        class="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const input = e.currentTarget;
          addFiles(input.files);
          input.value = ''; // so choosing the same file again still fires change
        }}
      />
      <header class="inbox-header">
        <h1>Inbox</h1>
        <div class="actions">
          <button class="btn btn-secondary" onClick={() => fileInput.current?.click()}>
            Add
          </button>
          <button class="btn" onClick={onScan}>
            Scan
          </button>
          <button class="btn btn-secondary" onClick={onSettings}>
            Settings
          </button>
        </div>
      </header>

      {/* Always rendered: a live region added together with its text is often not announced. */}
      <div role="status">
        {addError && <p class="warn">{addError}</p>}
        {Boolean(error) && loaded && (
          <p class="warn">
            {docs.length > 0 ? "Can't reach the server. Showing what was last loaded." : "Can't reach the server."}
          </p>
        )}
        {g.awaitingLogin > 0 && (
          <div class="warn">
            {g.awaitingLogin === 1 ? '1 document is' : `${g.awaitingLogin} documents are`} waiting to be filed. Sign in again to
            give the server access to Drive.{' '}
            <button class="btn btn-secondary btn-small" onClick={onSignInAgain}>
              Sign in again
            </button>
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <Section id="uploading" title="Uploading">
          {pending.map((item) => <UploadRow key={item.id} item={item} queue={uploads} />)}
        </Section>
      )}

      <section aria-labelledby="h-review">
        <h2 id="h-review">Needs review{g.review.length ? ` (${g.review.length})` : ''}</h2>
        {!loaded ? (
          <p class="muted">Loading…</p>
        ) : g.review.length === 0 ? (
          // With nothing loaded, the banner above says the server is unreachable.
          error && docs.length === 0 ? null : (
            <p class="muted">Nothing to review.</p>
          )
        ) : (
          g.review.map((d) => (
            <ReviewCard key={d.id} doc={d} folders={folders} onApprove={(b) => approve(d.id, b)} onDiscard={() => discard(d.id)} />
          ))
        )}
      </section>

      {g.waiting.length > 0 && (
        <Section id="waiting" title="In progress">
          {g.waiting.map((d) => <WaitingRow key={d.id} doc={d} onDiscard={() => confirmedDiscard(d)} />)}
        </Section>
      )}
      {g.failed.length > 0 && (
        <Section id="failed" title="Failed">
          {g.failed.map((d) => (
            <FailedRow key={d.id} doc={d} onRetry={() => retry(d.id)} onDiscard={() => confirmedDiscard(d)} />
          ))}
        </Section>
      )}
      {g.filed.length > 0 && (
        <Section id="filed" title="Recently filed">
          {g.filed.map((d) => <FiledRow key={d.id} doc={d} />)}
        </Section>
      )}
      {g.discarded.length > 0 && (
        <Section id="discarded" title="Discarded">
          {g.discarded.map((d) => <DiscardedRow key={d.id} doc={d} now={now()} onRestore={() => restore(d.id)} />)}
        </Section>
      )}
    </main>
  );
}
