import { describe, it, expect } from 'vitest';
import { buildFolderIndex } from '../../src/analyze/prompt.js';
import { resolveAnalysis, sanitiseName, type ModelAnswer } from '../../src/analyze/resolve.js';

const index = buildFolderIndex([
  { linkId: 'link-bills', path: '/Bills', recentNames: [] },
  { linkId: 'link-root', path: '/', recentNames: [] },
]);
// Sorted by path: "/" is F1, "/Bills" is F2.

function answer(over: Partial<ModelAnswer> = {}): ModelAnswer {
  return {
    rationale: 'A utility bill.',
    name: 'Northwind Energy Sep 2026',
    folderId: 'F2',
    newFolder: null,
    confidence: 0.9,
    isDocument: true,
    textSnippet: 'Northwind Energy account 1234',
    ...over,
  };
}

describe('sanitiseName', () => {
  it('strips markdown, json and html extensions', () => {
    expect(sanitiseName('Notes.md', 'x')).toBe('Notes');
    expect(sanitiseName('data.json', 'x')).toBe('data');
  });

  it('keeps the user-style punctuation the old ASCII regex rejected', () => {
    expect(sanitiseName('Lab results - Patel (Aug)', 'x')).toBe('Lab results - Patel (Aug)');
    expect(sanitiseName('Café receipt — €12', 'x')).toBe('Café receipt — €12');
  });

  it('replaces path separators and control characters, and strips an extension', () => {
    expect(sanitiseName('Taxes/2025\\1099:B\u0007.pdf', 'x')).toBe('Taxes 2025 1099 B');
  });

  it('drops leading dots and falls back when nothing is left', () => {
    expect(sanitiseName('..hidden', 'x')).toBe('hidden');
    expect(sanitiseName('  /// ', 'Document')).toBe('Document');
  });

  it('caps the length', () => {
    expect(sanitiseName('a'.repeat(300), 'x')).toHaveLength(120);
  });

  it('strips bidirectional override and isolate controls', () => {
    // U+202E would display "Invoice fdp.exe" as "Invoice exe.pdf".
    expect(sanitiseName('Invoice \u202Efdp.exe', 'x')).toBe('Invoice fdp.exe');
    expect(sanitiseName('\u202A\u202B\u202C\u202D\u2066\u2067\u2068\u2069Receipt', 'x')).toBe('Receipt');
  });

  it('caps the length by code point, never splitting a surrogate pair', () => {
    const out = sanitiseName('a' + '\u{1F4C4}'.repeat(200), 'x');
    expect([...out]).toHaveLength(120);
    expect(out.endsWith('\u{1F4C4}')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('resolveAnalysis', () => {
  it('records whether the model saw the content', () => {
    expect(resolveAnalysis(answer(), index, { contentSeen: true }).contentSeen).toBe(true);
    expect(resolveAnalysis(answer(), index, { contentSeen: false }).contentSeen).toBe(false);
  });

  it('maps a short folder ID back to the Drive link ID', () => {
    const a = resolveAnalysis(answer(), index, { contentSeen: true });
    expect(a.folder).toEqual({ kind: 'existing', linkId: 'link-bills', path: '/Bills' });
  });

  it('resolves a new-folder proposal against its parent', () => {
    const a = resolveAnalysis(answer({ folderId: null, newFolder: { parentId: 'F2', name: 'Water' } }), index, { contentSeen: true });
    expect(a.folder).toEqual({ kind: 'new', parentLinkId: 'link-bills', parentPath: '/Bills', name: 'Water' });
  });

  it('prefers the existing folder when both are set', () => {
    const a = resolveAnalysis(answer({ newFolder: { parentId: 'F1', name: 'Other' } }), index, { contentSeen: true });
    expect(a.folder?.kind).toBe('existing');
  });

  it('returns no folder for a hallucinated ID, so the document goes to review', () => {
    expect(resolveAnalysis(answer({ folderId: 'F99' }), index, { contentSeen: true }).folder).toBeNull();
    expect(resolveAnalysis(answer({ folderId: null, newFolder: { parentId: 'F9', name: 'X' } }), index, { contentSeen: true }).folder).toBeNull();
  });

  it('clamps confidence into 0..1', () => {
    expect(resolveAnalysis(answer({ confidence: 1.7 }), index, { contentSeen: true }).confidence).toBe(1);
    expect(resolveAnalysis(answer({ confidence: -2 }), index, { contentSeen: true }).confidence).toBe(0);
    expect(resolveAnalysis(answer({ confidence: Number.NaN }), index, { contentSeen: true }).confidence).toBe(0);
  });
});
