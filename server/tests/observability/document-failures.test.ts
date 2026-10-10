import { describe, it, expect, beforeEach } from 'vitest';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDocumentFailure } from '../../src/observability/report.js';
import { createPipeline } from '../../src/documents/pipeline.js';
import { createTestDb } from '../helpers/test-db.js';

const { events } = initRecordingSentry();

// Built at runtime so the value never appears in this file's source: the
// ContextLines integration attaches source lines around stack frames, and a
// literal here would leak into the event through them.
const nameCore = ['Northwind', 'Energy'].join(' ');
const docName = `${nameCore} ${Date.now()}.pdf`;
const stem = docName.replace(/\.pdf$/, '');

describe('document failure reporting', () => {
  beforeEach(() => {
    events.length = 0;
  });

  it('tags the stage and keeps the document name out of the event', async () => {
    captureDocumentFailure(new Error(`analysis failed for ${docName}`), 'analyze', [docName, '']);
    await flushEvents();
    expect(events).toHaveLength(1);
    expect((events[0]!.tags as Record<string, unknown>)['document.stage']).toBe('analyze');
    expect(JSON.stringify(events[0])).not.toContain(nameCore);
    expect(events[0]!.exception!.values![0]!.value).toBe('analysis failed for [filename]');
  });

  it('redacts the extension-less stem too', async () => {
    captureDocumentFailure(new Error(`no match for ${stem} (2)`), 'file', [docName]);
    await flushEvents();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(nameCore);
  });

  it('reports a quarantined row once, tagged storage, with no document content', async () => {
    const { db, cleanup } = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'quarantine-report-'));
    try {
      const pipeline = createPipeline({
        db,
        dataDir: dir,
        encryptionKey: Buffer.alloc(32, 3).toString('base64'),
        defaults: { model: 'm', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
        analyzerFor: () => ({ analyze: async () => Promise.reject(new Error('unused')) }),
      });
      const doc = pipeline.repo.insert({ source: 'picker', originalName: docName, mime: 'application/pdf', size: 1, sha256: 's', sourceContext: null });
      db.prepare('UPDATE documents SET original_name = ? WHERE id = ?').run(new Uint8Array(40), doc.id);
      pipeline.repo.get(doc.id);
      pipeline.repo.get(doc.id);
      await flushEvents();
      expect(events).toHaveLength(1);
      expect((events[0]!.tags as Record<string, unknown>)['document.stage']).toBe('storage');
      expect(events[0]!.exception!.values![0]!.type).toBe('DocumentDataUnreadableError');
      expect(JSON.stringify(events[0])).not.toContain(nameCore);
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
