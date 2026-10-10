import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { FilingHistory } from '../../src/documents/history.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe('FilingHistory', () => {
  it('records a filing and indexes it for full-text search', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    new FilingHistory(t.db).recordSave({
      snippet: 'Northwind Energy statement September 2026',
      finalName: 'Northwind Energy Sep 2026',
      folderLinkId: 'L1',
      folderPath: '/Bills',
      driveNodeUid: 'N1',
    });
    const hit = t.db
      .prepare(`SELECT final_name FROM classification_history_fts WHERE classification_history_fts MATCH 'northwind'`)
      .get() as { final_name: string } | undefined;
    expect(hit?.final_name).toBe('Northwind Energy Sep 2026');
  });

  it('never throws: history is a bonus, not the critical path', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    t.db.exec('DROP TABLE classification_history_fts');
    t.db.exec('DROP TABLE classification_history');
    expect(() =>
      new FilingHistory(t.db).recordSave({ snippet: '', finalName: 'x', folderLinkId: 'L', folderPath: '/', driveNodeUid: 'N' }),
    ).not.toThrow();
  });
});
