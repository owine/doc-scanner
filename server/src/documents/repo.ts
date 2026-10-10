import { randomBytes } from 'node:crypto';
import type { AtRestCipher } from '../crypto/at-rest.js';
import type { DB } from '../db.js';
import { logger } from '../logger.js';
import {
  DISCARDABLE_STATES,
  RESTING_STATES,
  WORKABLE_STATES,
  WORKING_STATES,
  type DocumentPatch,
  type DocumentRow,
  type DocumentState,
  type NewDocument,
} from './types.js';

/** ISO-8601 in UTC; sorts and compares correctly as text. */
const iso = (d: Date) => d.toISOString();

const COLUMN: Record<keyof DocumentPatch, string> = {
  reviewReason: 'review_reason',
  attempts: 'attempts',
  nextAttemptAt: 'next_attempt_at',
  error: 'error',
  analysis: 'analysis',
  preparedMime: 'prepared_mime',
  decision: 'decision',
  filingTarget: 'filing_target',
  filedName: 'filed_name',
  filedFolderPath: 'filed_folder_path',
  driveNodeUid: 'drive_node_uid',
  autoFiled: 'auto_filed',
  userEdited: 'user_edited',
  discardRequested: 'discard_requested',
  discardedAt: 'discarded_at',
};
const JSON_FIELDS = new Set<keyof DocumentPatch>(['analysis', 'decision', 'filingTarget']);

/**
 * Columns sealed at rest: everything that can hold a document's or folder's
 * name, a path, or text derived from the document. review_reason carries the
 * analyzer's schema-error detail and error any thrown message (a Drive error
 * can quote a name), so both are sealed too. The rest (ids, states, times,
 * MIME types, sizes, sha256 for duplicate lookup) stays plaintext: the SQL
 * filters and orders on it. A NULL stays NULL, so IS NULL checks still work.
 */
const SEALED_COLUMNS = [
  'original_name',
  'source_context',
  'review_reason',
  'error',
  'analysis',
  'decision',
  'filing_target',
  'filed_name',
  'filed_folder_path',
] as const;
type SealedColumn = (typeof SEALED_COLUMNS)[number];
const SEALED = new Set<string>(SEALED_COLUMNS);

/** What a quarantined row shows in place of its unreadable details. */
const UNREADABLE_TEXT = 'stored document details could not be decrypted';

/** A sealed column that would not open: the key changed, or the value was corrupted or moved. */
export class DocumentDataUnreadableError extends Error {
  constructor(readonly column: SealedColumn) {
    super(UNREADABLE_TEXT);
    this.name = 'DocumentDataUnreadableError';
  }
}

function toSql(key: keyof DocumentPatch, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (JSON_FIELDS.has(key)) return JSON.stringify(value);
  if (value instanceof Date) return iso(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number;
}

interface Raw {
  [col: string]: string | number | Uint8Array | null;
}

/** Opens a sealed column's value, or throws DocumentDataUnreadableError. */
type Unseal = (column: SealedColumn) => string | null;

function fromRow(r: Raw, unseal: Unseal): DocumentRow {
  const json = <T>(col: SealedColumn) => {
    const v = unseal(col);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      throw new DocumentDataUnreadableError(col);
    }
  };
  return {
    id: String(r.id),
    seq: Number(r.seq),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    source: r.source as DocumentRow['source'],
    originalName: unseal('original_name'),
    mime: String(r.mime),
    size: Number(r.size),
    sha256: String(r.sha256),
    sourceContext: unseal('source_context'),
    state: r.state as DocumentState,
    reviewReason: unseal('review_reason'),
    attempts: Number(r.attempts),
    nextAttemptAt: String(r.next_attempt_at),
    error: unseal('error'),
    analysis: json('analysis'),
    preparedMime: r.prepared_mime as string | null,
    decision: json('decision'),
    filingTarget: json('filing_target'),
    filedName: unseal('filed_name'),
    filedFolderPath: unseal('filed_folder_path'),
    driveNodeUid: r.drive_node_uid as string | null,
    autoFiled: r.auto_filed === 1,
    userEdited: r.user_edited === 1,
    discardRequested: r.discard_requested === 1,
    discardedAt: r.discarded_at as string | null,
  };
}

const placeholders = (n: number) => Array(n).fill('?').join(', ');

/**
 * All SQL for `documents`. Every state change is a compare-and-set on the
 * current state, and a working document whose discard was requested can't
 * move on, so the API and the worker never overwrite each other.
 *
 * Names, paths and document-derived text are sealed with AES-GCM here and
 * nowhere else (see SEALED_COLUMNS), each value bound to its row id and
 * column. A row with a value that won't open is quarantined on read rather
 * than thrown, so it can't block the worker's queue or the inbox listing.
 */
export class DocumentRepo {
  constructor(
    private readonly db: DB,
    private readonly cipher: AtRestCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Associated data: a ciphertext opens only in the row and column it was sealed for. */
  private static aad(id: string, column: SealedColumn): Uint8Array {
    return new TextEncoder().encode(`${id}\u0000${column}`);
  }

  private seal(id: string, column: SealedColumn, value: string | number | null): Uint8Array | string | number | null {
    if (value === null) return null;
    return this.cipher.seal(new TextEncoder().encode(String(value)), DocumentRepo.aad(id, column));
  }

  private unsealer(r: Raw): Unseal {
    const id = String(r.id);
    return (column) => {
      const v = r[column];
      if (v === null || v === undefined) return null;
      // Plaintext text here was never written by this repo: as unreadable as a bad tag.
      if (!(v instanceof Uint8Array)) throw new DocumentDataUnreadableError(column);
      try {
        return this.cipher.open(v, DocumentRepo.aad(id, column)).toString('utf8');
      } catch {
        throw new DocumentDataUnreadableError(column);
      }
    };
  }

  /**
   * The row, decrypted. One that won't decrypt is quarantined first: its
   * sealed fields are cleared (they can't be recovered) and, unless it is
   * already filed or discarded, it becomes `failed` with a fixed error, so
   * the user can retry or discard it. Only the column name is logged.
   */
  private decode(r: Raw): DocumentRow {
    try {
      return fromRow(r, this.unsealer(r));
    } catch (err) {
      if (!(err instanceof DocumentDataUnreadableError)) throw err;
      const id = String(r.id);
      logger.warn({ documentId: id, column: err.column }, 'document details could not be decrypted; quarantining the row');
      this.quarantine(id, Number(r.seq));
      const again = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Raw | undefined;
      if (!again) throw err;
      return fromRow(again, this.unsealer(again));
    }
  }

  /** Compare-and-set on seq: only the version that was read is quarantined. */
  private quarantine(id: string, seq: number): void {
    const t = iso(this.now());
    this.db
      .prepare(
        `UPDATE documents SET ${SEALED_COLUMNS.filter((c) => c !== 'error').map((c) => `${c} = NULL`).join(', ')},
           error = ?, discard_requested = 0, seq = ?, updated_at = ?,
           state = CASE WHEN state IN ('filed', 'discarded') THEN state ELSE 'failed' END
         WHERE id = ? AND seq = ?`,
      )
      .run(this.seal(id, 'error', UNREADABLE_TEXT), this.nextSeq(), t, id, seq);
  }

  /** Never reuses a number, even after the row that held the highest one is purged. */
  private nextSeq(): number {
    const r = this.db.prepare('UPDATE document_seq SET value = value + 1 WHERE id = 1 RETURNING value').get() as { value: number };
    return r.value;
  }

  insert(d: NewDocument): DocumentRow {
    const id = randomBytes(12).toString('base64url');
    const t = iso(this.now());
    this.db
      .prepare(
        `INSERT INTO documents (id, seq, created_at, updated_at, source, original_name, mime, size, sha256,
                                source_context, state, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
      )
      .run(
        id,
        this.nextSeq(),
        t,
        t,
        d.source,
        this.seal(id, 'original_name', d.originalName),
        d.mime,
        d.size,
        d.sha256,
        this.seal(id, 'source_context', d.sourceContext),
        t,
      );
    return this.get(id)!;
  }

  get(id: string): DocumentRow | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Raw | undefined;
    return r ? this.decode(r) : null;
  }

  /** A document with these exact bytes that is anywhere but the discard pile. */
  findActiveBySha256(sha256: string): DocumentRow | null {
    const r = this.db
      .prepare(`SELECT * FROM documents WHERE sha256 = ? AND state != 'discarded' ORDER BY created_at DESC LIMIT 1`)
      .get(sha256) as Raw | undefined;
    return r ? this.decode(r) : null;
  }

  /**
   * Moves `id` from `from` to `to`, setting `patch`, only if it is still in
   * `from` and no discard is pending. Returns whether it moved.
   * `ignorePendingDiscard` is for the one transition that must win over a
   * discard: an upload that already completed (filing → filed).
   */
  transition(
    id: string,
    from: DocumentState | readonly DocumentState[],
    to: DocumentState,
    patch: DocumentPatch = {},
    opts: { ignorePendingDiscard?: boolean } = {},
  ): boolean {
    const froms = Array.isArray(from) ? from : [from];
    // `undefined` means "leave the column alone"; only an explicit null clears it.
    const entries = (Object.entries(patch) as [keyof DocumentPatch, unknown][]).filter(([, v]) => v !== undefined);
    for (const [k] of entries) if (!Object.hasOwn(COLUMN, k)) throw new Error(`unknown patch field ${k}`);
    const sets = ['state = ?', 'seq = ?', 'updated_at = ?', ...entries.map(([k]) => `${COLUMN[k]} = ?`)];
    const params = [
      to,
      this.nextSeq(),
      iso(this.now()),
      ...entries.map(([k, v]) => {
        const col = COLUMN[k];
        const plain = toSql(k, v);
        return SEALED.has(col) ? this.seal(id, col as SealedColumn, plain) : plain;
      }),
    ];
    const res = this.db
      .prepare(
        `UPDATE documents SET ${sets.join(', ')}
         WHERE id = ? AND state IN (${placeholders(froms.length)})${opts.ignorePendingDiscard ? '' : ' AND discard_requested = 0'}`,
      )
      .run(...params, id, ...froms);
    return Number(res.changes) === 1;
  }

  /** Discards a resting document now, or flags a working one for when its stage ends. */
  requestDiscard(id: string): 'discarded' | 'requested' | 'not_allowed' | 'not_found' {
    const doc = this.get(id);
    if (!doc) return 'not_found';
    if (RESTING_STATES.includes(doc.state)) {
      // A stale flag from an interrupted stage must not block discarding a resting document.
      return this.transition(id, doc.state, 'discarded', { discardedAt: this.now(), discardRequested: false }, { ignorePendingDiscard: true })
        ? 'discarded'
        : 'not_allowed';
    }
    if (WORKING_STATES.includes(doc.state)) {
      // Due now, so a document waiting out a retry backoff is discarded on the
      // worker's next step rather than after the backoff. Not a filing whose
      // upload may have happened: the discard can't apply to it, and making it
      // due would skip its upload backoff.
      const t = iso(this.now());
      this.db
        .prepare(
          `UPDATE documents SET discard_requested = 1, seq = ?, updated_at = ?,
             next_attempt_at = CASE WHEN state = 'filing' AND filing_target IS NOT NULL
                                    THEN next_attempt_at ELSE MIN(next_attempt_at, ?) END
           WHERE id = ?`,
        )
        .run(this.nextSeq(), t, t, id);
      return 'requested';
    }
    return 'not_allowed';
  }

  /**
   * Withdraws a pending discard (the user re-uploaded the document). A
   * compare-and-set: false when none is pending or it has already been
   * applied, in which case the caller treats the upload as new.
   */
  cancelDiscardRequest(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE documents SET discard_requested = 0, seq = ?, updated_at = ?
         WHERE id = ? AND discard_requested = 1 AND state != 'discarded'`,
      )
      .run(this.nextSeq(), iso(this.now()), id);
    return Number(res.changes) === 1;
  }

  /**
   * Called by the worker when a stage could not move on: honours a pending
   * discard. Refuses a filed row, and a filing row whose upload may already
   * have happened (filing_target is written just before the upload).
   */
  applyRequestedDiscard(id: string): boolean {
    const t = iso(this.now());
    const res = this.db
      .prepare(
        `UPDATE documents SET state = 'discarded', discard_requested = 0, discarded_at = ?, seq = ?, updated_at = ?
         WHERE id = ? AND discard_requested = 1
           AND state IN (${placeholders(DISCARDABLE_STATES.length)})
           AND NOT (state = 'filing' AND filing_target IS NOT NULL)`,
      )
      .run(t, this.nextSeq(), t, id, ...DISCARDABLE_STATES);
    return Number(res.changes) === 1;
  }

  /**
   * The workable document due soonest, if any is due now. Includes documents
   * with a pending discard: one that was waiting out a retry backoff when the
   * discard arrived has no running stage to apply it, so the worker must.
   */
  nextWorkable(): DocumentRow | null {
    const pick = this.db.prepare(
      `SELECT * FROM documents
       WHERE state IN (${placeholders(WORKABLE_STATES.length)}) AND next_attempt_at <= ?
       ORDER BY discard_requested DESC, next_attempt_at, created_at LIMIT 1`,
    );
    for (;;) {
      const r = pick.get(...WORKABLE_STATES, iso(this.now())) as Raw | undefined;
      if (!r) return null;
      const doc = this.decode(r);
      // A quarantined row is no longer workable: look again.
      if (WORKABLE_STATES.includes(doc.state)) return doc;
    }
  }

  /**
   * A page of documents changed after `seq`, and the cursor for the next
   * page. The cursor is the last seq as read, before decoding: quarantining
   * an unreadable row gives it a new seq above every other, and a cursor
   * taken from that would skip the rows not read yet. The quarantined row
   * comes back on the next page.
   */
  listChangedSince(seq: number, limit = 500): { rows: DocumentRow[]; cursor: number } {
    const raw = this.db
      .prepare('SELECT * FROM documents WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(seq, limit) as Raw[];
    const cursor = raw.length > 0 ? Number(raw[raw.length - 1]!.seq) : seq;
    return { rows: raw.map((r) => this.decode(r)), cursor };
  }

  /** On login: everything waiting for a session goes back to filing, due now. */
  resumeAwaitingLogin(): number {
    const ids = (this.db.prepare(`SELECT id FROM documents WHERE state = 'awaiting_login'`).all() as { id: string }[]).map((r) => r.id);
    let moved = 0;
    // attempts reset: waiting for a login is not a failed attempt.
    for (const id of ids) if (this.transition(id, 'awaiting_login', 'filing', { nextAttemptAt: this.now(), attempts: 0 })) moved++;
    return moved;
  }

  /**
   * Makes deferred work due now (e.g. analyses waiting for a folder tree).
   * Deliberately doesn't bump seq: next_attempt_at isn't shown to clients.
   */
  makeDueNow(state: DocumentState): void {
    this.db
      .prepare('UPDATE documents SET next_attempt_at = ? WHERE state = ? AND next_attempt_at > ?')
      .run(iso(this.now()), state, iso(this.now()));
  }

  discardedBefore(cutoff: Date): string[] {
    return (
      this.db
        .prepare(`SELECT id FROM documents WHERE state = 'discarded' AND discarded_at < ?`)
        .all(iso(cutoff)) as { id: string }[]
    ).map((r) => r.id);
  }

  /** Doesn't bump seq: it only purges rows discarded more than 7 days ago, which clients no longer track. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
}
