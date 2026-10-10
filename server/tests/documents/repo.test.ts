import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { DocumentRepo } from '../../src/documents/repo.js';
import type { NewDocument } from '../../src/documents/types.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

let clock = new Date('2026-10-10T12:00:00Z');
function repo() {
  const t = createTestDb();
  cleanup = t.cleanup;
  clock = new Date('2026-10-10T12:00:00Z');
  return new DocumentRepo(t.db, () => clock);
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
    expect(r.listChangedSince(cursor).map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('wakes awaiting-login documents into filing', () => {
    const r = repo();
    const a = r.insert(doc());
    r.transition(a.id, 'received', 'awaiting_login');
    expect(r.resumeAwaitingLogin()).toBe(1);
    expect(r.get(a.id)?.state).toBe('filing');
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
});
