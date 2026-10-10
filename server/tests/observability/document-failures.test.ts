import { describe, it, expect, beforeEach } from 'vitest';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { captureDocumentFailure } from '../../src/observability/report.js';

const { events } = initRecordingSentry();

// Built at runtime so the value never appears in this file's source: the
// ContextLines integration attaches source lines around stack frames, and a
// literal here would leak into the event through them.
const docName = `${['Northwind', 'Energy'].join(' ')} ${Date.now()}.pdf`;

describe('document failure reporting', () => {
  beforeEach(() => {
    events.length = 0;
  });

  it('tags the stage and keeps the document name out of the event', async () => {
    captureDocumentFailure(new Error(`analysis failed for ${docName}`), 'analyze', [docName, '']);
    await flushEvents();
    expect(events).toHaveLength(1);
    expect((events[0]!.tags as Record<string, unknown>)['document.stage']).toBe('analyze');
    expect(JSON.stringify(events[0])).not.toContain(docName);
  });
});
