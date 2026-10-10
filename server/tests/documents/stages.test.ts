import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, okOutcome, ANALYSIS, TREE } from './harness.js';
import { analyzeStage } from '../../src/documents/stages/analyze.js';
import { prepareStage } from '../../src/documents/stages/prepare.js';
import { decideStage, reviewReason } from '../../src/documents/stages/decide.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h.cleanup());

describe('analyzeStage', () => {
  it('defers when there is no folder tree yet, without calling the model', async () => {
    h = makeHarness({ withTree: false });
    const doc = h.add();
    await analyzeStage(doc, h.ctx);
    const after = h.repo.get(doc.id)!;
    expect(after.state).toBe('received');
    expect(new Date(after.nextAttemptAt).getTime()).toBeGreaterThan(Date.parse('2026-10-10T12:00:00Z'));
    expect(h.analyze).not.toHaveBeenCalled();
  });

  it('stores the analysis and moves on to preparing', async () => {
    h = makeHarness();
    const doc = h.add();
    await analyzeStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'preparing', analysis: ANALYSIS });
  });

  it('hides never-file-here folders from the model', async () => {
    h = makeHarness();
    await analyzeStage(h.add(), h.ctx);
    const folders = h.analyze.mock.calls[0][1] as { path: string }[];
    expect(folders.map((f) => f.path)).toEqual(['/', '/Bills']);
  });

  it('sends an unusable answer to review with the reason', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue({ ...okOutcome(), status: 'refusal', detail: 'declined (cyber)' });
    const doc = h.add();
    await analyzeStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'analysis refusal: declined (cyber)' });
  });

  it('honours a discard requested while the model was working', async () => {
    h = makeHarness();
    const doc = h.add();
    h.analyze.mockImplementation(async () => {
      h.repo.requestDiscard(doc.id);
      return okOutcome();
    });
    await analyzeStage(doc, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });
});

describe('analyzeStage retry state and recovery', () => {
  it('resets retry state when an unusable answer goes to review', async () => {
    h = makeHarness();
    h.analyze.mockResolvedValue({ ...okOutcome(), status: 'refusal', detail: 'declined' });
    const doc = h.add();
    h.db.prepare('UPDATE documents SET attempts = 2, error = ? WHERE id = ?').run('x', doc.id);
    await analyzeStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', attempts: 0, error: null });
  });

  it('refreshes the folder cache when a session is live and there is no tree', async () => {
    h = makeHarness({ withTree: false });
    h.refreshFolderCache.mockImplementation(async () => h.ctx.folderCache.save(TREE, new Date()));
    const doc = h.add();
    await analyzeStage(doc, h.ctx);
    expect(h.refreshFolderCache).toHaveBeenCalledTimes(1);
    expect(h.repo.get(doc.id)?.state).toBe('preparing');
  });

  it('defers if the refresh throws', async () => {
    h = makeHarness({ withTree: false });
    h.refreshFolderCache.mockRejectedValue(new Error('boom'));
    const doc = h.add();
    await analyzeStage(doc, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('received');
  });

  it('moves a crashed analyzing row without a tree back to received', async () => {
    h = makeHarness({ withTree: false });
    h.setLive(undefined);
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'analyzing');
    await analyzeStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('received');
    expect(h.refreshFolderCache).not.toHaveBeenCalled();
  });

  it('re-analyses a row found in analyzing after a crash', async () => {
    h = makeHarness();
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'analyzing');
    await analyzeStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('preparing');
  });
});

describe('prepareStage (slice 1: pass-through)', () => {
  it('honours a discard requested during preparation', async () => {
    h = makeHarness();
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'preparing');
    h.repo.requestDiscard(doc.id);
    await prepareStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });

  it('marks the document ready with its own type', async () => {
    h = makeHarness();
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'preparing');
    await prepareStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'ready', preparedMime: 'text/plain' });
  });
});

describe('decideStage', () => {
  function readyDoc(analysis = ANALYSIS) {
    const doc = h.add();
    h.repo.transition(doc.id, 'received', 'ready', { analysis });
    return h.repo.get(doc.id)!;
  }

  it('auto-files a confident answer with an existing folder', () => {
    h = makeHarness();
    const doc = readyDoc();
    decideStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({
      state: 'filing',
      autoFiled: true,
      decision: { name: ANALYSIS.name, folder: ANALYSIS.folder },
    });
  });

  it('sends everything to review while auto-filing is off', () => {
    h = makeHarness({ settings: { autoFileEnabled: false } });
    const doc = readyDoc();
    decideStage(doc, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'needs_review', reviewReason: 'auto-filing is off' });
  });

  it('explains every reason a document goes to review', () => {
    h = makeHarness();
    const s = h.ctx.settings.get();
    expect(reviewReason(null, s)).toBe('no analysis');
    expect(reviewReason({ ...ANALYSIS, folder: null }, s)).toBe('no folder chosen');
    expect(reviewReason({ ...ANALYSIS, folder: { kind: 'new', parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water' } }, s)).toBe(
      'new folder proposed',
    );
    expect(reviewReason({ ...ANALYSIS, confidence: 0.5 }, s)).toBe('confidence 0.500 is below 0.80');
    expect(reviewReason(ANALYSIS, s)).toBeNull();
  });

  it('files at exactly the threshold', () => {
    h = makeHarness();
    expect(reviewReason({ ...ANALYSIS, confidence: 0.8 }, h.ctx.settings.get())).toBeNull();
  });

  it('refuses a folder on the never-file-here list', () => {
    h = makeHarness();
    const a = { ...ANALYSIS, folder: { kind: 'existing' as const, linkId: 'ARCHIVE', path: '/Archive' } };
    expect(reviewReason(a, h.ctx.settings.get())).toBe('folder is on the never-file-here list');
  });

  it('names the fixable reason before the auto-filing switch', () => {
    h = makeHarness({ settings: { autoFileEnabled: false } });
    const a = { ...ANALYSIS, folder: { kind: 'new' as const, parentLinkId: 'BILLS', parentPath: '/Bills', name: 'Water' } };
    expect(reviewReason(a, h.ctx.settings.get())).toBe('new folder proposed');
  });

  it('resets retry state when it moves on', () => {
    h = makeHarness();
    const doc = readyDoc();
    h.db.prepare('UPDATE documents SET attempts = 2, error = ? WHERE id = ?').run('x', doc.id);
    decideStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)).toMatchObject({ state: 'filing', attempts: 0, error: null });
  });

  it('honours a pending discard', () => {
    h = makeHarness();
    const doc = readyDoc();
    h.db.prepare('UPDATE documents SET discard_requested = 1 WHERE id = ?').run(doc.id);
    decideStage(h.repo.get(doc.id)!, h.ctx);
    expect(h.repo.get(doc.id)?.state).toBe('discarded');
  });
});
