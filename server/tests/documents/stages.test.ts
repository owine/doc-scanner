import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, okOutcome, ANALYSIS } from './harness.js';
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

describe('prepareStage (slice 1: pass-through)', () => {
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
    expect(reviewReason({ ...ANALYSIS, confidence: 0.5 }, s)).toBe('confidence 0.50 is below 0.80');
    expect(reviewReason(ANALYSIS, s)).toBeNull();
  });
});
