import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness } from './harness.js';
import { DocumentWorker, MAX_ATTEMPTS } from '../../src/documents/worker.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h.cleanup());

describe('DocumentWorker', () => {
  it('takes a document from received to filed when it can auto-file', async () => {
    h = makeHarness();
    const doc = h.add();
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('stops at review when auto-filing is off', async () => {
    h = makeHarness({ settings: { autoFileEnabled: false } });
    const doc = h.add();
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)?.state).toBe('needs_review');
  });

  it('retries a failing stage with backoff, then fails it and reports once', async () => {
    h = makeHarness();
    h.analyze.mockRejectedValue(new Error('overloaded'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)).toMatchObject({ attempts: 1, error: 'overloaded' });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      h.advance(10 * 60_000);
      await w.wake();
    }
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls[0][1]).toBe('analyze');
  });

  it('applies a discard that arrived while the document waited out a backoff', async () => {
    h = makeHarness();
    h.analyze.mockRejectedValueOnce(new Error('overloaded'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'analyzing', attempts: 1 });
    expect(h.repo.requestDiscard(doc.id)).toBe('requested');
    h.advance(10 * 60_000);
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('keeps retrying an upload that may have happened, even if a discard arrives', async () => {
    h = makeHarness();
    h.drive.uploadFile.mockRejectedValueOnce(new Error('network down'));
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    // The failed attempt left a filing target: the upload may have reached Drive.
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filing', attempts: 1, filingTarget: expect.anything() });
    expect(h.repo.requestDiscard(doc.id)).toBe('requested');
    h.advance(10 * 60_000);
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('on login: refreshes the folder tree and files what was waiting', async () => {
    h = makeHarness();
    h.setLive(undefined);
    const doc = h.add();
    const w = new DocumentWorker(h.ctx);
    await w.wake();
    expect(h.repo.get(doc.id)?.state).toBe('awaiting_login');
    h.setLive({ sid: 's', driveClient: h.drive } as never);
    await w.onLogin();
    expect(h.drive.walkFolderTree).toHaveBeenCalled();
    expect(h.repo.get(doc.id)?.state).toBe('filed');
  });

  it('fails a document at once when its inbox blob is missing', async () => {
    h = makeHarness();
    const doc = h.add();
    h.inbox.deleteAll(doc.id);
    await new DocumentWorker(h.ctx).wake();
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
  });

  it('sweeps orphaned inbox blobs: no row, or already filed', async () => {
    h = makeHarness();
    h.inbox.put('ghost123', 'original', new Uint8Array([1]));
    const filed = h.add();
    h.repo.transition(filed.id, 'received', 'filed');
    const pending = h.add();
    new DocumentWorker(h.ctx).purgeDiscarded();
    expect(h.inbox.listIds().sort()).toEqual([pending.id].sort());
  });

  it('shares one folder walk between concurrent refreshes', async () => {
    h = makeHarness();
    const w = new DocumentWorker(h.ctx);
    await Promise.all([w.refreshFolderCache(), w.refreshFolderCache(), w.refreshFolderCache()]);
    expect(h.drive.walkFolderTree).toHaveBeenCalledTimes(1);
  });

  it('purges documents discarded more than seven days ago, blobs included', async () => {
    h = makeHarness();
    const doc = h.add();
    h.repo.requestDiscard(doc.id);
    const w = new DocumentWorker(h.ctx);
    h.advance(6 * 24 * 3600_000);
    w.purgeDiscarded();
    expect(h.repo.get(doc.id)).not.toBeNull();
    h.advance(2 * 24 * 3600_000);
    w.purgeDiscarded();
    expect(h.repo.get(doc.id)).toBeNull();
    expect(h.inbox.has(doc.id, 'original')).toBe(false);
  });
});
