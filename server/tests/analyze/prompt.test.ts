import { describe, it, expect } from 'vitest';
import { buildFolderIndex, formatArrival, formatExamples, systemPrompt } from '../../src/analyze/prompt.js';

describe('buildFolderIndex', () => {
  it('lists folders in path order with short IDs and recent names', () => {
    const { text, byId } = buildFolderIndex([
      { linkId: 'b', path: '/Bills', recentNames: ['Northwind Energy Sep 2026', 'Say "hi"'] },
      { linkId: 'r', path: '/', recentNames: [] },
    ]);
    expect(text).toBe(
      '<folders>\n' +
        'F1 / (top level of My files)\n' +
        `F2 /Bills | recent: "Northwind Energy Sep 2026"; "Say 'hi'"\n` +
        '</folders>',
    );
    expect(byId.get('F2')?.linkId).toBe('b');
  });

  it('is deterministic regardless of input order, so the cached prefix stays stable', () => {
    const a = [
      { linkId: '1', path: '/A', recentNames: [] },
      { linkId: '2', path: '/B', recentNames: [] },
    ];
    expect(buildFolderIndex(a).text).toBe(buildFolderIndex([...a].reverse()).text);
  });
});

describe('formatExamples', () => {
  it('returns null when there are none', () => {
    expect(formatExamples([])).toBeNull();
  });
});

describe('formatArrival', () => {
  const input = { bytes: new Uint8Array(10), mimeType: 'application/pdf', source: 'picker' as const };

  it('withholds the filename when it is null', () => {
    const text = formatArrival({ ...input, originalName: null }, null);
    expect(text).not.toContain('original filename');
  });

  it('includes the filename, source note and content note when present', () => {
    const text = formatArrival(
      { ...input, originalName: 'statement.pdf', sourceContext: 'Fwd: your bill' },
      'showing the first 20 of 31 pages',
    );
    expect(text).toContain('original filename: statement.pdf');
    expect(text).toContain('source note: Fwd: your bill');
    expect(text).toContain('note: showing the first 20 of 31 pages');
  });
});

describe('systemPrompt', () => {
  it('states the configured auto-file threshold', () => {
    expect(systemPrompt(0.8)).toContain('Documents above 0.80 are filed automatically');
    expect(systemPrompt(0.85)).toContain('Documents above 0.85 are filed automatically');
  });

  it('is stable for a given threshold, so the prompt cache holds', () => {
    expect(systemPrompt(0.8)).toBe(systemPrompt(0.8));
  });
});
