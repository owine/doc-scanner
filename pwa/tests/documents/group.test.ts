import { describe, it, expect } from 'vitest';
import { groupDocuments, RECENT_FILED_LIMIT } from '../../src/documents/group.js';
import { makeDoc } from './fixtures.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('groupDocuments', () => {
  it('puts each state in its section', () => {
    const docs = [
      makeDoc({ state: 'needs_review' }),
      makeDoc({ state: 'received' }),
      makeDoc({ state: 'analyzing' }),
      makeDoc({ state: 'filing' }),
      makeDoc({ state: 'awaiting_login' }),
      makeDoc({ state: 'filed' }),
      makeDoc({ state: 'failed' }),
      makeDoc({ state: 'discarded', discardedAt: daysAgo(1) }),
    ];
    const g = groupDocuments(docs, NOW);
    expect(g.review).toHaveLength(1);
    expect(g.waiting.map((d) => d.state)).toEqual(['received', 'analyzing', 'filing', 'awaiting_login']);
    expect(g.awaitingLogin).toBe(1);
    expect(g.filed).toHaveLength(1);
    expect(g.failed).toHaveLength(1);
    expect(g.discarded).toHaveLength(1);
  });

  it('orders review and waiting oldest first, filed and failed newest first', () => {
    const old = makeDoc({ createdAt: daysAgo(3), updatedAt: daysAgo(3) });
    const recent = makeDoc({ createdAt: daysAgo(1), updatedAt: daysAgo(1) });
    expect(groupDocuments([recent, old], NOW).review.map((d) => d.id)).toEqual([old.id, recent.id]);
    const f1 = makeDoc({ state: 'filed', updatedAt: daysAgo(3) });
    const f2 = makeDoc({ state: 'filed', updatedAt: daysAgo(1) });
    expect(groupDocuments([f1, f2], NOW).filed.map((d) => d.id)).toEqual([f2.id, f1.id]);
  });

  it('keeps only the most recent filed documents', () => {
    const many = Array.from({ length: RECENT_FILED_LIMIT + 5 }, (_, i) => makeDoc({ state: 'filed', updatedAt: daysAgo(i) }));
    expect(groupDocuments(many, NOW).filed).toHaveLength(RECENT_FILED_LIMIT);
  });

  it('drops discarded documents older than the 7-day window', () => {
    const fresh = makeDoc({ state: 'discarded', discardedAt: daysAgo(6) });
    const stale = makeDoc({ state: 'discarded', discardedAt: daysAgo(8) });
    expect(groupDocuments([fresh, stale], NOW).discarded.map((d) => d.id)).toEqual([fresh.id]);
  });
});
