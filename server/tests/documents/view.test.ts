import { describe, it, expect } from 'vitest';
import { toView } from '../../src/documents/view.js';
import type { DocumentRow } from '../../src/documents/types.js';
import { ANALYSIS } from './harness.js';

const row = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: 'doc1',
  seq: 1,
  createdAt: '2026-10-10T12:00:00.000Z',
  updatedAt: '2026-10-10T12:00:00.000Z',
  source: 'picker',
  originalName: 'statement.pdf',
  mime: 'application/pdf',
  size: 10,
  sha256: 'a'.repeat(64),
  sourceContext: null,
  state: 'filing',
  reviewReason: null,
  attempts: 0,
  nextAttemptAt: '2026-10-10T12:00:00.000Z',
  error: null,
  analysis: ANALYSIS,
  preparedMime: null,
  decision: { name: ANALYSIS.name, folder: { kind: 'existing', linkId: 'BILLS', path: '/Bills' } },
  filingTarget: null,
  filedName: null,
  filedFolderPath: null,
  driveNodeUid: null,
  autoFiled: true,
  userEdited: false,
  discardRequested: false,
  discardedAt: null,
  ...over,
});

const TARGET = { folderLinkId: 'BILLS', name: 'Northwind Energy Sep 2026.pdf' };

describe('toView', () => {
  it('flags a document whose upload may have happened as possibly in Drive', () => {
    expect(toView(row({ state: 'awaiting_login', filingTarget: TARGET })).possiblyInDrive).toBe(true);
    expect(toView(row({ state: 'failed', filingTarget: TARGET })).possiblyInDrive).toBe(true);
  });

  it('does not flag a filed document, or one never sent', () => {
    const filed = toView(
      row({ state: 'filed', filingTarget: TARGET, filedName: TARGET.name, filedFolderPath: '/Bills', driveNodeUid: 'N1' }),
    );
    expect(filed.possiblyInDrive).toBe(false);
    expect(filed.filed).toEqual({ name: TARGET.name, folderPath: '/Bills', driveNodeUid: 'N1' });
    expect(toView(row({ state: 'awaiting_login', filingTarget: null })).possiblyInDrive).toBe(false);
  });

  it('leaves out blobs, hashes and the analysis text snippet', () => {
    const v = toView(row());
    expect(v).not.toHaveProperty('sha256');
    expect(v).not.toHaveProperty('sourceContext');
    expect(v.analysis).not.toHaveProperty('textSnippet');
    expect(v.filed).toBeNull();
  });
});
