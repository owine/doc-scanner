import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import type { DB } from '../../src/db.js';
import { DocumentDataUnreadableError, DocumentRepo } from '../../src/documents/repo.js';
import type { DocumentPatch, NewDocument } from '../../src/documents/types.js';

const KEY = Buffer.alloc(32, 5).toString('base64');

let cleanup: () => void = () => {};
afterEach(() => cleanup());

let clock = new Date('2026-10-10T12:00:00Z');
let db: DB;
function repo() {
  const t = createTestDb();
  cleanup = t.cleanup;
  db = t.db;
  clock = new Date('2026-10-10T12:00:00Z');
  return new DocumentRepo(t.db, new AtRestCipher(KEY, 'documents'), () => clock);
}

const doc = (over: Partial<NewDocument> = {}): NewDocument => ({
  source: 'picker',
  originalName: 'statement.pdf',
  mime: 'application/pdf',
  size: 10,
  sha256: 'a'.repeat(64),
  sourceContext: null,
  ...over,
});

describe('DocumentRepo', () => {
  it('inserts a received document with an increasing seq', () => {
    const r = repo();
    const a = r.insert(doc());
    const b = r.insert(doc({ sha256: 'b'.repeat(64) }));
    expect(a.state).toBe('received');
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('finds an active duplicate by sha256, ignoring discarded copies', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(r.findActiveBySha256(a.sha256)?.id).toBe(a.id);
    expect(r.transition(a.id, 'received', 'discarded', { discardedAt: clock })).toBe(true);
    expect(r.findActiveBySha256(a.sha256)).toBeNull();
  });

  it('transitions only from the expected state (compare-and-set)', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(r.transition(a.id, 'ready', 'filing')).toBe(false);
    expect(r.transition(a.id, 'received', 'analyzing')).toBe(true);
    expect(r.get(a.id)?.state).toBe('analyzing');
  });

  it('cancels a pending discard only while it is still pending', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(r.cancelDiscardRequest(a.id)).toBe(false); // nothing pending
    r.transition(a.id, 'received', 'analyzing');
    expect(r.requestDiscard(a.id)).toBe('requested');
    const before = r.get(a.id)!.seq;
    expect(r.cancelDiscardRequest(a.id)).toBe(true);
    expect(r.get(a.id)).toMatchObject({ state: 'analyzing', discardRequested: false });
    expect(r.get(a.id)!.seq).toBeGreaterThan(before);
    expect(r.transition(a.id, 'analyzing', 'preparing')).toBe(true);
    // Once applied, it is too late.
    expect(r.requestDiscard(a.id)).toBe('requested');
    expect(r.applyRequestedDiscard(a.id)).toBe(true);
    expect(r.cancelDiscardRequest(a.id)).toBe(false);
    expect(r.get(a.id)?.state).toBe('discarded');
  });

  it('never cancels on a discarded row, even with a stray flag', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'discarded', { discardedAt: clock, discardRequested: true }, { ignorePendingDiscard: true });
    expect(r.cancelDiscardRequest(a.id)).toBe(false);
    expect(r.get(a.id)).toMatchObject({ state: 'discarded', discardRequested: true });
  });

  it('refuses to move a working document on once a discard was requested', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'analyzing');
    expect(r.requestDiscard(a.id)).toBe('requested');
    expect(r.transition(a.id, 'analyzing', 'preparing')).toBe(false);
    expect(r.applyRequestedDiscard(a.id)).toBe(true);
    expect(r.get(a.id)?.state).toBe('discarded');
  });

  it('lets a completed filing win over a pending discard', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'filing');
    r.requestDiscard(a.id);
    expect(r.transition(a.id, 'filing', 'filed', { discardRequested: false }, { ignorePendingDiscard: true })).toBe(true);
    expect(r.get(a.id)).toMatchObject({ state: 'filed', discardRequested: false });
  });

  it('discards a resting document at once', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(r.requestDiscard(a.id)).toBe('discarded');
    expect(r.get(a.id)?.discardedAt).not.toBeNull();
    expect(r.requestDiscard(a.id)).toBe('not_allowed');
  });

  it('picks the next workable document whose retry time has come', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'received', { nextAttemptAt: new Date(clock.getTime() + 60_000) });
    expect(r.nextWorkable()).toBeNull();
    clock = new Date(clock.getTime() + 61_000);
    expect(r.nextWorkable()?.id).toBe(a.id);
  });

  it('still hands the worker a document whose discard arrived during a backoff', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'analyzing', { nextAttemptAt: new Date(clock.getTime() + 60_000) });
    r.requestDiscard(a.id);
    clock = new Date(clock.getTime() + 61_000);
    expect(r.nextWorkable()).toMatchObject({ id: a.id, discardRequested: true });
  });

  it('makes a working document due at once when its discard is requested', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'analyzing', { nextAttemptAt: new Date(clock.getTime() + 60_000) });
    expect(r.nextWorkable()).toBeNull();
    expect(r.requestDiscard(a.id)).toBe('requested');
    expect(r.nextWorkable()).toMatchObject({ id: a.id, discardRequested: true });
  });

  it('keeps the backoff of a filing whose upload may have happened when a discard is requested', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'filing', {
      nextAttemptAt: new Date(clock.getTime() + 60_000),
      filingTarget: { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' },
    });
    expect(r.requestDiscard(a.id)).toBe('requested');
    // The discard can't be applied to this row, so there is nothing to do sooner.
    expect(r.nextWorkable()).toBeNull();
  });

  it('never reuses a seq after the newest row is deleted', () => {
    const r = repo();
    const a = r.insert(doc());
    r.delete(a.id);
    const b = r.insert(doc({ sha256: 'b'.repeat(64) }));
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('round-trips JSON columns', () => {
    const r = repo();
    const a = r.insert(doc());
    const decision = { name: 'X', folder: { kind: 'existing' as const, linkId: 'L', path: '/Bills' } };
    r.transition(a.id, 'received', 'filing', { decision, filingTarget: { folderLinkId: 'L', name: 'X.pdf' } });
    expect(r.get(a.id)).toMatchObject({ decision, filingTarget: { folderLinkId: 'L', name: 'X.pdf' } });
  });

  it('lists documents changed since a seq', () => {
    const r = repo();
    const a = r.insert(doc());
    const cursor = a.seq;
    const b = r.insert(doc({ sha256: 'b'.repeat(64) }));
    r.transition(a.id, 'received', 'analyzing');
    const page = r.listChangedSince(cursor);
    expect(page.rows.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(page.cursor).toBe(r.get(a.id)!.seq);
    expect(r.listChangedSince(page.cursor)).toEqual({ rows: [], cursor: page.cursor });
  });

  it('wakes awaiting-login documents into filing', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'awaiting_login');
    expect(r.resumeAwaitingLogin()).toBe(1);
    expect(r.get(a.id)?.state).toBe('filing');
  });

  it('resets attempts when resuming after a login: waiting for one is not a failure', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'awaiting_login', { attempts: 2 });
    r.resumeAwaitingLogin();
    expect(r.get(a.id)).toMatchObject({ state: 'filing', attempts: 0 });
  });

  it('lists discarded documents older than a cutoff', () => {
    const r = repo();
    const a = r.insert(doc());
    r.requestDiscard(a.id);
    expect(r.discardedBefore(new Date(clock.getTime() - 1000))).toEqual([]);
    expect(r.discardedBefore(new Date(clock.getTime() + 1000))).toEqual([a.id]);
  });

  it('does not discard a filed row that carries a stale discard flag', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'filing');
    r.requestDiscard(a.id);
    r.transition(a.id, 'filing', 'filed', {}, { ignorePendingDiscard: true });
    expect(r.applyRequestedDiscard(a.id)).toBe(false);
    expect(r.get(a.id)?.state).toBe('filed');
  });

  it('does not discard a filing row whose upload may have happened', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'filing', { filingTarget: { folderLinkId: 'L', name: 'X.pdf' } });
    r.requestDiscard(a.id);
    expect(r.applyRequestedDiscard(a.id)).toBe(false);
    expect(r.get(a.id)?.state).toBe('filing');
  });

  it('discards a filing row that has no filing target yet', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'filing');
    r.requestDiscard(a.id);
    expect(r.applyRequestedDiscard(a.id)).toBe(true);
    expect(r.get(a.id)).toMatchObject({ state: 'discarded', discardRequested: false });
  });

  it('leaves a column alone when its patch value is undefined', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'analyzing', { error: 'boom' });
    r.transition(a.id, 'analyzing', 'received', { error: undefined });
    expect(r.get(a.id)?.error).toBe('boom');
  });

  it('throws on an unknown patch field', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(() => r.transition(a.id, 'received', 'analyzing', { bogus: 1 } as never)).toThrow('unknown patch field bogus');
  });

  it('rejects inherited keys in a patch', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(() => r.transition(a.id, 'received', 'analyzing', { toString: 1 } as never)).toThrow(/unknown patch field toString/);
  });

  it('reports a missing id as not_found', () => {
    expect(repo().requestDiscard('nope')).toBe('not_found');
  });

  it('leaves the row untouched when the compare-and-set fails', () => {
    const r = repo();
    const a = r.insert(doc());
    clock = new Date(clock.getTime() + 5000);
    expect(r.transition(a.id, 'ready', 'filing', { error: 'x', attempts: 3 })).toBe(false);
    expect(r.get(a.id)).toEqual(a);
  });

  it('bumps seq and updated_at on a successful transition', () => {
    const r = repo();
    const a = r.insert(doc());
    clock = new Date(clock.getTime() + 5000);
    r.transition(a.id, 'received', 'analyzing');
    const b = r.get(a.id)!;
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(b.updatedAt).toBe(clock.toISOString());
    expect(b.updatedAt).not.toBe(a.updatedAt);
  });

  it('accepts an array of from-states', () => {
    const r = repo();
    const a = r.insert(doc());
    expect(r.transition(a.id, ['ready', 'received'], 'analyzing')).toBe(true);
    expect(r.transition(a.id, ['ready', 'received'], 'preparing')).toBe(false);
  });

  it('keeps a working row requested when a discard is requested twice', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'analyzing');
    expect(r.requestDiscard(a.id)).toBe('requested');
    expect(r.requestDiscard(a.id)).toBe('requested');
    expect(r.get(a.id)).toMatchObject({ state: 'analyzing', discardRequested: true });
  });

  it('discards a resting row despite a stale flag', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'needs_review', { discardRequested: true });
    expect(r.requestDiscard(a.id)).toBe('discarded');
    expect(r.get(a.id)).toMatchObject({ state: 'discarded', discardRequested: false });
  });

  it('restores a discarded row to review when discardedAt is cleared', () => {
    const r = repo();
    const a = r.insert(doc());
    r.requestDiscard(a.id);
    expect(r.transition(a.id, 'discarded', 'needs_review', { discardedAt: null })).toBe(true);
    expect(r.get(a.id)).toMatchObject({ state: 'needs_review', discardedAt: null });
  });

  describe('metadata at rest', () => {
    // Fictional values, each containing a marker the raw row must never show.
    const MARK = 'Northwind';
    const named = (): NewDocument => doc({ originalName: `${MARK} Energy Sep 2026.pdf`, sourceContext: `Fwd: ${MARK} Energy statement` });
    const everything: DocumentPatch = {
      analysis: {
        name: `${MARK} Energy Sep 2026`,
        folder: { kind: 'existing', linkId: 'BILLS', path: `/Bills/${MARK} Energy` },
        confidence: 0.9,
        rationale: `A ${MARK} Energy bill.`,
        isDocument: true,
        contentSeen: true,
      },
      decision: { name: `${MARK} Energy Sep 2026`, folder: { kind: 'existing', linkId: 'BILLS', path: `/Bills/${MARK} Energy` } },
      filingTarget: { folderLinkId: 'BILLS', name: `${MARK} Energy Sep 2026.pdf` },
      filedName: `${MARK} Energy Sep 2026.pdf`,
      filedFolderPath: `/Bills/${MARK} Energy`,
      reviewReason: `analysis invalid: ${MARK}`,
      error: `upload of ${MARK} Energy Sep 2026.pdf failed`,
    };
    const rawRow = (id: string) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown>;
    const SEALED = ['original_name', 'source_context', 'analysis', 'decision', 'filing_target', 'filed_name', 'filed_folder_path', 'review_reason', 'error'];

    it('keeps no plaintext name, path or text in the raw row', () => {
      const r = repo();
      const a = r.insert(named());
      expect(r.transition(a.id, 'received', 'filing', everything)).toBe(true);
      const raw = rawRow(a.id);
      for (const [col, v] of Object.entries(raw)) {
        if (v === null || typeof v === 'number') continue;
        expect([col, Buffer.from(v as Uint8Array | string).includes(MARK)]).toEqual([col, false]);
      }
      for (const col of SEALED) expect([col, raw[col] instanceof Uint8Array]).toEqual([col, true]);
      // Duplicate lookup still works on the plaintext hash.
      expect(r.findActiveBySha256(a.sha256)?.id).toBe(a.id);
    });

    it('round-trips every sealed field', () => {
      const r = repo();
      const a = r.insert(named());
      r.transition(a.id, 'received', 'filing', everything);
      expect(r.get(a.id)).toMatchObject({ ...everything, originalName: `${MARK} Energy Sep 2026.pdf`, sourceContext: `Fwd: ${MARK} Energy statement` });
    });

    it('keeps NULL as NULL, so IS NULL checks still work', () => {
      const r = repo();
      const a = r.insert(doc({ originalName: null, sourceContext: null }));
      for (const col of SEALED) expect([col, rawRow(a.id)[col]]).toEqual([col, null]);
      r.transition(a.id, 'received', 'filing', { filingTarget: { folderLinkId: 'BILLS', name: 'x.pdf' } });
      r.requestDiscard(a.id);
      // filing_target IS NOT NULL: the upload may have happened, so the discard can't apply.
      expect(r.applyRequestedDiscard(a.id)).toBe(false);
      r.transition(a.id, 'filing', 'filing', { filingTarget: null }, { ignorePendingDiscard: true });
      expect(rawRow(a.id).filing_target).toBeNull();
      expect(r.applyRequestedDiscard(a.id)).toBe(true);
    });

    it('reads a pinned sealed value, so the row/column binding format stays stable', () => {
      const t = createTestDb();
      cleanup = t.cleanup;
      // Same blob as the pinned documents test in at-rest.test.ts.
      const pinned = Buffer.from('276BqljxoIgEgZg06wPFlGZVX2OMWEKEaKs/gjnLkwJHI9xS0WFN6tRW+5lc1tt3/j3wN2JSJ+O/', 'base64');
      t.db
        .prepare(
          `INSERT INTO documents (id, seq, created_at, updated_at, source, original_name, mime, size, sha256, state, next_attempt_at)
           VALUES ('doc-0001', 1, 't', 't', 'picker', ?, 'application/pdf', 10, 'abc', 'received', 't')`,
        )
        .run(pinned);
      const r = new DocumentRepo(t.db, new AtRestCipher(Buffer.alloc(32, 7).toString('base64'), 'documents'), () => clock);
      expect(r.get('doc-0001')).toMatchObject({ state: 'received', originalName: 'Northwind Energy Sep 2026.pdf' });
    });

    it('treats a value moved from another row as unreadable', () => {
      const r = repo();
      const a = r.insert(named());
      const b = r.insert(doc({ sha256: 'b'.repeat(64), originalName: 'other.pdf' }));
      db.prepare('UPDATE documents SET original_name = (SELECT original_name FROM documents WHERE id = ?) WHERE id = ?').run(a.id, b.id);
      expect(r.get(b.id)).toMatchObject({ state: 'failed', originalName: null, error: 'stored document details could not be decrypted' });
      expect(r.get(a.id)?.originalName).toBe(`${MARK} Energy Sep 2026.pdf`);
    });

    it('treats a value moved from another column as unreadable', () => {
      const r = repo();
      const a = r.insert(named());
      db.prepare('UPDATE documents SET source_context = original_name WHERE id = ?').run(a.id);
      expect(r.get(a.id)).toMatchObject({ state: 'failed', originalName: null, sourceContext: null });
    });

    it('quarantines an undecryptable row: sealed fields cleared, failed, discard flag dropped', () => {
      const r = repo();
      const a = r.insert(named());
      r.transition(a.id, 'received', 'filing', everything);
      r.requestDiscard(a.id);
      db.prepare('UPDATE documents SET decision = ? WHERE id = ?').run(new Uint8Array(40), a.id);
      const seqBefore = (rawRow(a.id).seq as number);
      const got = r.get(a.id)!;
      expect(got).toMatchObject({
        state: 'failed',
        discardRequested: false,
        originalName: null,
        analysis: null,
        decision: null,
        filingTarget: null,
        filedName: null,
      });
      expect(got.error).toMatch(/^stored document details could not be decrypted/);
      // Clients polling by seq see the change.
      expect(got.seq).toBeGreaterThan(seqBefore);
      for (const col of SEALED.filter((c) => c !== 'error')) expect([col, rawRow(a.id)[col]]).toEqual([col, null]);
    });

    it('keeps the upload warning when quarantining a row whose upload may have happened', () => {
      const r = repo();
      const a = r.insert(named());
      r.transition(a.id, 'received', 'filing', everything);
      db.prepare('UPDATE documents SET decision = ? WHERE id = ?').run(new Uint8Array(40), a.id);
      expect(r.get(a.id)).toMatchObject({
        state: 'failed',
        // Cleared rather than kept as a placeholder: a set target would block
        // discards and skip the auto-filed folder re-check on a retry.
        filingTarget: null,
        uploadUnverified: true,
        error: 'stored document details could not be decrypted; an upload may already have happened, so check Drive before retrying',
      });
    });

    it('does not flag an upload for a row that never had a filing target', () => {
      const r = repo();
      const a = r.insert(named());
      db.prepare('UPDATE documents SET original_name = ? WHERE id = ?').run(new Uint8Array(40), a.id);
      expect(r.get(a.id)).toMatchObject({ state: 'failed', uploadUnverified: false, error: 'stored document details could not be decrypted' });
    });

    it('reports each quarantine once, with nothing but the error type and column', () => {
      const t = createTestDb();
      cleanup = t.cleanup;
      db = t.db;
      const onUnreadable = vi.fn();
      const r = new DocumentRepo(t.db, new AtRestCipher(KEY, 'documents'), () => clock, onUnreadable);
      const a = r.insert(named());
      db.prepare('UPDATE documents SET original_name = ? WHERE id = ?').run(new Uint8Array(40), a.id);
      r.get(a.id);
      r.listChangedSince(0);
      r.get(a.id);
      expect(onUnreadable).toHaveBeenCalledTimes(1);
      const err = onUnreadable.mock.calls[0]![0] as Error & { column: string };
      expect(err).toBeInstanceOf(DocumentDataUnreadableError);
      expect(err.column).toBe('original_name');
      expect(err.message).not.toContain(MARK);
    });

    it('keeps a filed or discarded row in its state when quarantining it', () => {
      const r = repo();
      const a = r.insert(named());
      r.transition(a.id, 'received', 'filed', { filedName: 'x.pdf', driveNodeUid: 'NODE1' });
      db.prepare('UPDATE documents SET filed_name = ? WHERE id = ?').run(new Uint8Array(40), a.id);
      expect(r.get(a.id)).toMatchObject({ state: 'filed', filedName: null, driveNodeUid: 'NODE1' });
    });

    it('pages by the seqs as read, so a row quarantined at the end of a full page comes back next poll', () => {
      const r = repo();
      const ids = [0, 1, 2, 3].map((i) => r.insert(doc({ sha256: String(i).repeat(64) })).id);
      const lastOnPage = ids[2]!;
      const seqAsRead = r.get(lastOnPage)!.seq;
      db.prepare('UPDATE documents SET original_name = ? WHERE id = ?').run(new Uint8Array(40), lastOnPage);
      const first = r.listChangedSince(0, 3);
      expect(first.rows.map((d) => d.id)).toEqual(ids.slice(0, 3));
      // Not the quarantined row's new seq, which is past the unread fourth row.
      expect(first.cursor).toBe(seqAsRead);
      const second = r.listChangedSince(first.cursor, 3);
      expect(second.rows.map((d) => d.id)).toEqual([ids[3], lastOnPage]);
      expect(second.rows[1]).toMatchObject({ state: 'failed' });
    });

    it('never lets an undecryptable row block the work queue', () => {
      const r = repo();
      const bad = r.insert(named());
      clock = new Date(clock.getTime() + 1000);
      const good = r.insert(doc({ sha256: 'c'.repeat(64) }));
      db.prepare('UPDATE documents SET original_name = ? WHERE id = ?').run('plaintext from somewhere else', bad.id);
      expect(r.nextWorkable()?.id).toBe(good.id);
      expect(r.get(bad.id)?.state).toBe('failed');
    });

    it('lists changes past an undecryptable row', () => {
      const r = repo();
      const bad = r.insert(named());
      const good = r.insert(doc({ sha256: 'c'.repeat(64) }));
      db.prepare('UPDATE documents SET original_name = ? WHERE id = ?').run(new Uint8Array(3), bad.id);
      const { rows } = r.listChangedSince(0);
      expect(rows.map((d) => d.id).sort()).toEqual([bad.id, good.id].sort());
      expect(rows.find((d) => d.id === bad.id)?.state).toBe('failed');
    });
  });
});
