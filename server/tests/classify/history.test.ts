import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClassificationHistory } from '../../src/classify/history.js';
import { createTestDb } from '../helpers/test-db.js';

let cleanupFn: (() => void) | null = null;
let history: ClassificationHistory;
let dbHandle: ReturnType<typeof createTestDb>['db'];

beforeEach(() => {
  const { db, cleanup } = createTestDb();
  cleanupFn = cleanup;
  dbHandle = db;
  history = new ClassificationHistory(db);
});
afterEach(() => { cleanupFn?.(); cleanupFn = null; });

function rec(i: number) {
  return {
    ocrText: `OCR text for entry ${i}`,
    finalName: `Document ${i}`,
    folderLinkId: `f-${i}`,
    folderPath: `/Path${i}`,
    driveNodeUid: `node-${i}`,
  };
}

describe('ClassificationHistory', () => {
  it('findRecent on an empty table returns []', () => {
    expect(history.findRecent(3)).toEqual([]);
  });

  it('recordSave + findRecent round-trips a single row', () => {
    history.recordSave(rec(1));
    const out = history.findRecent(3);
    expect(out).toEqual([
      { ocrSnippet: 'OCR text for entry 1', finalName: 'Document 1', folderPath: '/Path1' },
    ]);
  });

  it('findRecent returns most-recent-N in reverse-chronological order', () => {
    for (let i = 1; i <= 5; i++) history.recordSave(rec(i));
    const out = history.findRecent(3);
    // Inserted 1..5; most recent are 5, 4, 3.
    expect(out.map((p) => p.finalName)).toEqual(['Document 5', 'Document 4', 'Document 3']);
  });

  it('truncates ocr_snippet to 500 chars', () => {
    const huge = 'x'.repeat(2000);
    history.recordSave({ ...rec(1), ocrText: huge });
    const out = history.findRecent(1);
    expect(out[0]!.ocrSnippet.length).toBe(500);
  });

  it('FTS5 mirror table stays in sync via triggers (insert + delete)', () => {
    for (let i = 1; i <= 3; i++) history.recordSave(rec(i));
    const ftsCount = (n: string) => (dbHandle.prepare(`SELECT COUNT(*) AS n FROM classification_history_fts`).get() as { n: number }).n;
    expect(ftsCount('after inserts')).toBe(3);
    dbHandle.prepare('DELETE FROM classification_history WHERE final_name = ?').run('Document 2');
    expect(ftsCount('after delete')).toBe(2);
    // Spot-check FTS5 query still works post-delete.
    const matches = dbHandle.prepare(
      `SELECT final_name FROM classification_history_fts WHERE classification_history_fts MATCH 'document' ORDER BY rank`,
    ).all() as Array<{ final_name: string }>;
    expect(matches.length).toBe(2);
    expect(matches.map((r) => r.final_name).sort()).toEqual(['Document 1', 'Document 3']);
  });

  it('findRecent(0) returns [] without hitting the DB', () => {
    history.recordSave(rec(1));
    expect(history.findRecent(0)).toEqual([]);
  });
});
