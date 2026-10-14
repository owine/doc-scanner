import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError, type ProtonState, type StatusResponse } from '../../api.js';
import type { UnlockClient } from '../../auth/flows.js';
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
import { sendScanToInbox, useDeviceScans } from '../../uploads/scans.js';
import { DeviceScanRow, UploadRow } from './UploadRows.js';
import { LockedBanner } from './LockedBanner.js';

/** The passkey nudge, once dismissed, stays dismissed on this device. */
const NUDGE_DISMISSED_KEY = 'docscanner.passkeyNudgeDismissed';

function nudgeDismissed(): boolean {
  try {
    return localStorage.getItem(NUDGE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

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
  /** From GET /api/auth/status. `locked` shows the unlock banner (passkey-unlock spec §3). */
  proton?: ProtonState;
  passkeys?: number;
  onUnlocked?: (status: StatusResponse) => void;
  /** An unlock refusal changed the server's state (spec §3): the app reads its status again. */
  onStatusChanged?: () => void;
  /** Opens the sign-in-to-Proton screen; defaults to onSignInAgain. */
  onSignInToProton?: () => void;
  /** After a Proton login in header mode with no passkey yet. */
  showPasskeyNudge?: boolean;
  /** Defaults to onSettings, where passkeys are added. */
  onAddPasskey?: () => void;
  /** The nudge was dismissed (stored on this device too, where storage allows). */
  onNudgeDismissed?: () => void;
  /** Focus the heading on arrival: the control that had focus is gone (passkey-unlock spec §3, Cancel). */
  focusHeading?: boolean;
  unlockClient?: UnlockClient;
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
  scans,
  proton = 'live',
  passkeys = 0,
  onUnlocked = () => {},
  onStatusChanged = () => {},
  onSignInToProton = onSignInAgain,
  showPasskeyNudge = false,
  onAddPasskey = onSettings,
  onNudgeDismissed = () => {},
  focusHeading = false,
  unlockClient,
}: InboxScreenProps) {
  const { docs, loaded, error } = useDocuments(sync);
  const pending = useUploads(uploads);
  const device = useDeviceScans(scans, uploads);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [nudgeHidden, setNudgeHidden] = useState(nudgeDismissed);
  const dismissNudge = () => {
    try {
      localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
    } catch {
      // Storage refused (private browsing): dismissed until the next visit.
    }
    setNudgeHidden(true);
    onNudgeDismissed();
  };
  const headingRef = useRef<HTMLHeadingElement>(null);
  // On arrival only, before paint.
  useLayoutEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, []);
  // The queue keeps why a send failed (uploads.buildErrorOf): the row
  // unmounts while its scan is claimed, and Done in App sends scans too.
  const sendScan = async (id: string) => {
    try {
      await sendScanToInbox(scans, uploads, id);
    } catch (e) {
      console.error('could not send scan', (e as Error)?.name);
    }
  };
  const addFiles = useCallback(
    (files: ArrayLike<File> | null | undefined) => {
      const chosen = Array.from(files ?? []);
      if (chosen.length === 0) return;
      setAddError(null);
      uploads.add(chosen.map((f) => ({ blob: f, name: f.name, source: 'picker' as const }))).catch((e: unknown) => {
        // The error's name only: the files' names stay on this device.
        console.error('could not add files', (e as Error)?.name);
        setAddError("Some files couldn't be added.");
      });
    },
    [uploads],
  );
  // The add error stays until the queue next changes: a later add, or an upload finishing.
  useEffect(() => {
    let seen = uploads.list();
    return uploads.subscribe(() => {
      if (uploads.list() === seen) return; // a progress tick, or the connection
      seen = uploads.list();
      setAddError(null);
    });
  }, [uploads]);
  // The whole window takes dropped files while the inbox shows, margins
  // included: a drop the page doesn't take makes the browser open the file.
  // A layout effect: Preact 11 runs useEffect cleanups after paint, so the
  // listeners would outlive the inbox and take a drop meant for another screen.
  useLayoutEffect(() => {
    const carriesFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    // dragenter and dragleave fire for every element crossed. Counting them
    // tells when the drag has left the window: WebKit's relatedTarget is null.
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return; // text dragged into a field keeps its default
      e.preventDefault(); // allows the drop
      setDragging(true);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(e.dataTransfer?.files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [addFiles]);
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
  // A refusal for a stale list (a part moved on, an anchor went away) asks
  // for fresh data; the chooser still says what happened.
  const refreshIfStale = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) void sync.poll();
  };
  const combine = async (ids: string[]) => {
    try {
      sync.upsert(await documents.combine(ids));
    } catch (err) {
      refreshIfStale(err);
      throw err;
    }
    // The parts are discarded now: read them back so they leave review.
    await Promise.all(ids.map(readBack));
  };
  const reanalyze = async (id: string, anchorId?: string) => {
    try {
      sync.upsert(await documents.reanalyze(id, anchorId));
    } catch (err) {
      refreshIfStale(err);
      throw err;
    }
  };

  return (
    <main class="inbox">
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
        <h1 ref={headingRef} tabIndex={-1}>
          Inbox
        </h1>
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
        {proton === 'locked' ? (
          // Replaces the sign-in banner below: nothing can be filed until the keys are back.
          <LockedBanner
            passkeys={passkeys}
            onUnlocked={onUnlocked}
            onStatusChanged={onStatusChanged}
            onSignIn={onSignInToProton}
            {...(unlockClient ? { client: unlockClient } : {})}
          />
        ) : (
          // Live, yet documents wait: the session's tokens died inside it.
          g.awaitingLogin > 0 && (
            <div class="warn">
              {g.awaitingLogin === 1 ? '1 document is' : `${g.awaitingLogin} documents are`} waiting to be filed. Sign in again to
              give the server access to Drive.{' '}
              <button class="btn btn-secondary btn-small" onClick={onSignInAgain}>
                Sign in again
              </button>
            </div>
          )
        )}
      </div>

      {showPasskeyNudge && !nudgeHidden && (
        <div class="card nudge" role="note">
          <p>Add a passkey so a server restart doesn’t need your Proton password.</p>
          <div class="actions">
            <button class="btn btn-small" onClick={onAddPasskey}>
              Add passkey
            </button>
            <button class="btn btn-secondary btn-small" onClick={dismissNudge}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <Section id="uploading" title="Uploading">
          {pending.map((item) => <UploadRow key={item.id} item={item} queue={uploads} />)}
        </Section>
      )}

      {device.scans.length > 0 && (
        <section aria-labelledby="h-device">
          <h2 id="h-device">Scans on this device</h2>
          <p class="muted">Scans not sent yet. Send them or delete them.</p>
          <ul class="doc-list" role="list">
            {device.scans.map((s) => (
              <DeviceScanRow
                key={s.id}
                scan={s}
                onSend={() => sendScan(s.id)}
                error={uploads.buildErrorOf(s.id)}
                onDelete={async () => {
                  await scans.delete(s.id);
                  await device.reload();
                }}
              />
            ))}
          </ul>
        </section>
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
            <ReviewCard
              key={d.id}
              doc={d}
              folders={folders}
              review={g.review}
              filed={g.filed}
              onApprove={(b) => approve(d.id, b)}
              onDiscard={() => discard(d.id)}
              onCombine={combine}
              onReanalyze={(anchorId) => reanalyze(d.id, anchorId)}
            />
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
