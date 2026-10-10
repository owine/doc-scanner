import { logger } from '../logger.js';
import { errorName } from '../observability/error-name.js';
import type { DocumentStage } from '../observability/report.js';
import type { PipelineDeps, StageContext } from './deps.js';
import { InboxBlobMissingError } from './inbox-store.js';
import { analyzeStage } from './stages/analyze.js';
import { decideStage } from './stages/decide.js';
import { fileStage } from './stages/file.js';
import { prepareStage } from './stages/prepare.js';
import type { DocumentRow, DocumentState } from './types.js';

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30_000, 2 * 60_000];
const POLL_MS = 60_000;
const FOLDER_REFRESH_MS = 6 * 3600_000;
const PURGE_EVERY_MS = 3600_000;
const DISCARD_RETENTION_MS = 7 * 24 * 3600_000;
/** Safety valve: a drain never spins forever on a document that won't move. */
const MAX_STEPS_PER_DRAIN = 1000;
/** How far an unexpected worker error pushes the row it came from. */
const POSTPONE_MS = 10 * 60_000;

/** The wait before attempt `attempts + 1`: bounded by the table, ±20% jitter. */
function backoffMs(attempts: number): number {
  const base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.8 + 0.4 * Math.random()));
}

type Folder = NonNullable<DocumentRow['decision']>['folder'] | NonNullable<DocumentRow['analysis']>['folder'] | undefined;

function folderValues(f: Folder): string[] {
  if (!f) return [];
  return f.kind === 'new' ? [f.parentPath, f.name] : [f.path];
}

/** Everything in a failure report that could name the user's documents or folders. */
function sensitiveValues(doc: DocumentRow): string[] {
  const values = [
    doc.originalName,
    doc.decision?.name,
    doc.analysis?.name,
    ...folderValues(doc.decision?.folder),
    ...folderValues(doc.analysis?.folder),
  ];
  // '/' alone names nothing, and redacting it would mangle every path in the event.
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== '' && v !== '/'))];
}

function stageOf(state: DocumentState): DocumentStage {
  if (state === 'filing') return 'file';
  if (state === 'preparing') return 'prepare';
  return 'analyze';
}

/**
 * The single in-process worker. One document, one stage at a time; woken on
 * upload, on login and by a poll timer that picks up retries whose backoff
 * has passed. Working states are re-run after a crash, so there is no
 * separate recovery step.
 */
export class DocumentWorker {
  private readonly ctx: StageContext;
  private draining: Promise<void> | null = null;
  private again = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly d: PipelineDeps) {
    this.ctx = { ...d, refreshFolderCache: () => this.refreshFolderCache() };
  }

  /**
   * Runs stages until nothing is due. Concurrent calls share one drain.
   * Never rejects: callers fire it and forget.
   */
  wake(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          for (let i = 0; i < MAX_STEPS_PER_DRAIN && (await this.guardedStep()); i++);
        } while (this.again);
      } finally {
        // Same tick as the last `again` check: a wake() after it starts a new
        // drain instead of joining one that is already over.
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /**
   * step() with a backstop: an unexpected error is logged (its type only) and
   * the row it came from, if any, is postponed, so one bad row can neither
   * crash the drain nor spin it.
   */
  private async guardedStep(): Promise<boolean> {
    let doc: DocumentRow | null = null;
    try {
      doc = this.d.repo.nextWorkable();
      if (!doc) return false;
      await this.step(doc);
      return true;
    } catch (err) {
      logger.error({ documentId: doc?.id, errName: errorName(err) }, 'document worker step failed');
      if (!doc) return false;
      this.postpone(doc.id);
      return true;
    }
  }

  /** Pushes a row's next attempt out; best effort. */
  private postpone(id: string): void {
    try {
      const state = this.d.repo.get(id)?.state;
      if (!state) return;
      // Only next_attempt_at changes, so it is safe past a pending discard
      // (the flag stays, and the worker applies it when the row is due).
      this.d.repo.transition(id, state, state, { nextAttemptAt: new Date(this.d.now().getTime() + POSTPONE_MS) }, { ignorePendingDiscard: true });
    } catch (err) {
      logger.error({ documentId: id, errName: errorName(err) }, 'could not postpone document');
    }
  }

  /** One stage for `doc`, the most overdue document. */
  private async step(doc: DocumentRow): Promise<void> {
    // A discard that arrived while this document waited out a backoff (or
    // before a crash). An upload that may already have happened is finished
    // instead: it can't be taken back.
    if (doc.discardRequested && !(doc.state === 'filing' && doc.filingTarget)) {
      this.d.repo.applyRequestedDiscard(doc.id);
      return;
    }
    try {
      switch (doc.state) {
        case 'received':
        case 'analyzing':
          await analyzeStage(doc, this.ctx);
          break;
        case 'preparing':
          await prepareStage(doc, this.ctx);
          break;
        case 'ready':
          decideStage(doc, this.ctx);
          break;
        case 'filing':
          await fileStage(doc, this.ctx);
          break;
      }
    } catch (err) {
      this.retryOrFail(doc, err);
    }
  }

  /**
   * Errors reach GlitchTip via d.report with the document's names redacted;
   * stages must never throw errors that embed document content (the analyzer's
   * unusable answers become review reasons, not thrown errors).
   * Never throws: if the failure can't be recorded, the row is postponed.
   */
  private retryOrFail(doc: DocumentRow, err: unknown): void {
    try {
      this.recordFailure(doc, err);
    } catch (recordErr) {
      logger.error({ documentId: doc.id, errName: errorName(recordErr) }, 'could not record document failure');
      this.postpone(doc.id);
    }
  }

  private recordFailure(doc: DocumentRow, err: unknown): void {
    // A missing inbox blob can never come back: fail now instead of retrying.
    const attempts = err instanceof InboxBlobMissingError ? MAX_ATTEMPTS : doc.attempts + 1;
    const error = err instanceof Error ? err.message : String(err);
    // The stage may have moved the row (received → analyzing) before throwing.
    const current = this.d.repo.get(doc.id);
    const state = current?.state ?? doc.state;
    const stage = stageOf(state);
    // An upload may already have happened once filing_target is set: a pending
    // discard must not win here (the repo refuses it anyway), so retry or fail
    // the filing regardless of the flag. The user can discard from `failed`.
    const opts = { ignorePendingDiscard: state === 'filing' && !!current?.filingTarget };
    // The error's type only: a message could quote a document or folder name.
    // The message itself is kept in the row, for the user's own inbox view.
    logger.warn(
      { documentId: doc.id, stage, attempts, errName: errorName(err) },
      'document stage failed',
    );
    if (attempts >= MAX_ATTEMPTS) {
      // discardRequested cleared: a failed document is resting, discardable on request.
      if (this.d.repo.transition(doc.id, state, 'failed', { attempts, error, discardRequested: false }, opts)) {
        try {
          this.d.report(err, stage, sensitiveValues(doc));
        } catch (reportErr) {
          // The row is already failed; reporting is best effort.
          logger.error({ documentId: doc.id, errName: errorName(reportErr) }, 'could not report document failure');
        }
      } else {
        this.d.repo.applyRequestedDiscard(doc.id);
      }
      return;
    }
    const nextAttemptAt = new Date(this.d.now().getTime() + backoffMs(attempts));
    if (!this.d.repo.transition(doc.id, state, state, { attempts, error, nextAttemptAt }, opts)) {
      this.d.repo.applyRequestedDiscard(doc.id);
    }
  }

  private refreshing: Promise<void> | null = null;

  /**
   * Re-walks Drive and caches the tree. A no-op without a live session.
   * Concurrent callers (login, the timer, several deferred analyses) share
   * one walk in flight.
   */
  refreshFolderCache(): Promise<void> {
    this.refreshing ??= (async () => {
      const live = this.d.liveSession();
      if (!live) return;
      const tree = await live.driveClient.walkFolderTree();
      this.d.folderCache.save(tree, this.d.now());
      logger.info({ folders: tree.length }, 'folder cache refreshed');
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** After a login: fresh tree, then everything that was waiting. */
  async onLogin(): Promise<void> {
    this.d.repo.resumeAwaitingLogin();
    try {
      await this.refreshFolderCache();
    } catch (err) {
      logger.warn({ errName: errorName(err) }, 'folder cache refresh after login failed');
    }
    this.d.repo.makeDueNow('received');
    await this.wake();
  }

  purgeDiscarded(): void {
    for (const id of this.d.repo.discardedBefore(new Date(this.d.now().getTime() - DISCARD_RETENTION_MS))) {
      this.d.inbox.deleteAll(id);
      this.d.repo.delete(id);
    }
    // Orphans: blobs whose row is gone (a failed intake) or already filed (a
    // crash between the filed transition and the inbox delete). The trust
    // boundary promises no document data outlives its filing.
    for (const id of this.d.inbox.listIds()) {
      const row = this.d.repo.get(id);
      if (!row || row.state === 'filed') this.d.inbox.deleteAll(id);
    }
  }

  /** Starts the timers and a first drain. A no-op if already started. */
  start(): void {
    if (this.timers.length > 0) return;
    // Through a promise chain so a synchronous throw (purgeDiscarded) is caught too.
    const run = (fn: () => unknown) =>
      void Promise.resolve()
        .then(fn)
        .catch((err: unknown) => logger.warn({ errName: errorName(err) }, 'worker timer failed'));
    const every = (ms: number, fn: () => unknown) => {
      const t = setInterval(() => run(fn), ms);
      t.unref();
      this.timers.push(t);
    };
    every(POLL_MS, () => this.wake());
    every(FOLDER_REFRESH_MS, () => this.refreshFolderCache());
    every(PURGE_EVERY_MS, () => this.purgeDiscarded());
    run(() => this.purgeDiscarded());
    void this.wake();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
