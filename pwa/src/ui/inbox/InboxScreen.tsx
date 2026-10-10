import type { ComponentChildren } from 'preact';
import { documentsApi, type DocumentsApi } from '../../documents/api.js';
import { groupDocuments } from '../../documents/group.js';
import { useDocuments, type DocumentSync } from '../../documents/sync.js';
import type { ApproveBody, DocumentView } from '../../documents/types.js';
import { useFolders } from '../../documents/use-folders.js';
import { DiscardedRow, FailedRow, FiledRow, WaitingRow } from './DocumentRows.js';
import { confirmDiscard } from './labels.js';
import { ReviewCard } from './ReviewCard.js';

export interface InboxScreenProps {
  sync: DocumentSync;
  documents?: DocumentsApi;
  now?: () => Date;
  onScan: () => void;
  onSavedScans: () => void;
  onSettings: () => void;
  onSignInAgain: () => void;
}

function Section({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return (
    <section aria-labelledby={`h-${id}`}>
      <h2 id={`h-${id}`}>{title}</h2>
      <ul class="doc-list">{children}</ul>
    </section>
  );
}

export function InboxScreen({
  sync,
  documents = documentsApi,
  now = () => new Date(),
  onScan,
  onSavedScans,
  onSettings,
  onSignInAgain,
}: InboxScreenProps) {
  const { docs, loaded, error } = useDocuments(sync);
  const folders = useFolders(documents);
  const g = groupDocuments(docs, now());

  const approve = async (id: string, body: ApproveBody) => sync.upsert(await documents.approve(id, body));
  // Read the document back: a poll already in flight may predate the discard.
  const discard = async (id: string) => {
    await documents.discard(id);
    // The discard has happened; failing to read it back must not report it as failed.
    try {
      sync.upsert(await documents.get(id));
    } catch {
      void sync.poll();
    }
  };
  // Rows outside the review card confirm here; the card confirms itself.
  const confirmedDiscard = async (d: DocumentView) => {
    if (confirmDiscard(d)) await discard(d.id);
  };
  const restore = async (id: string) => sync.upsert(await documents.restore(id));
  const retry = async (id: string) => sync.upsert(await documents.retry(id));

  return (
    <main class="inbox">
      <header class="inbox-header">
        <h1>Inbox</h1>
        <div class="actions">
          <button class="btn" onClick={onScan}>
            Scan
          </button>
          <button class="btn btn-secondary" onClick={onSettings}>
            Settings
          </button>
        </div>
      </header>

      {Boolean(error) && loaded && (
        <p class="warn" role="status">
          Can't reach the server. Showing what was last loaded.
        </p>
      )}
      {g.awaitingLogin > 0 && (
        <div class="warn" role="status">
          {g.awaitingLogin === 1 ? '1 document is' : `${g.awaitingLogin} documents are`} waiting to be filed. Sign in again to
          give the server access to Drive.{' '}
          <button class="btn btn-secondary btn-small" onClick={onSignInAgain}>
            Sign in again
          </button>
        </div>
      )}

      <section aria-labelledby="h-review">
        <h2 id="h-review">Needs review{g.review.length ? ` (${g.review.length})` : ''}</h2>
        {!loaded ? (
          <p class="muted">Loading…</p>
        ) : g.review.length === 0 ? (
          <p class="muted">Nothing to review.</p>
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

      <footer class="inbox-footer">
        <button class="btn btn-secondary" onClick={onSavedScans}>
          Saved scans
        </button>
      </footer>
    </main>
  );
}
