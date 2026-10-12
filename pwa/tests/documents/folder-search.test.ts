import { describe, it, expect } from 'vitest';
import { searchFolders } from '../../src/documents/folder-search.js';
import { FOLDERS } from './fixtures.js';

const paths = (q: string, limit?: number) => searchFolders(FOLDERS, q, limit).map((f) => f.path);

describe('searchFolders', () => {
  it('returns every folder by path when the query is empty', () => {
    expect(paths('')).toEqual(['/', '/Archive/Energy', '/Bills', '/Bills/Energy', '/Bills/Water', '/Taxes/2026']);
  });

  it('matches every word anywhere in the path, ignoring case', () => {
    expect(paths('bills energy')).toEqual(['/Bills/Energy']);
    expect(paths('WATER')).toEqual(['/Bills/Water']);
  });

  it('ranks a match in the last segment first, then shorter paths', () => {
    expect(paths('energy')).toEqual(['/Bills/Energy', '/Archive/Energy']);
    expect(paths('bills')).toEqual(['/Bills', '/Bills/Water', '/Bills/Energy']);
  });

  it('treats a slash as a word break', () => {
    expect(paths('bills/wat')).toEqual(['/Bills/Water']);
  });

  it('caps the number of results', () => {
    expect(paths('', 2)).toHaveLength(2);
  });

  it('matches regardless of accents', () => {
    const folders = [...FOLDERS, { linkId: 'L-energie', path: '/Bills/\u00c9nergie' }];
    expect(searchFolders(folders, 'energie').map((f) => f.path)).toEqual(['/Bills/\u00c9nergie']);
    expect(searchFolders(folders, '\u00e9nergie').map((f) => f.path)).toEqual(['/Bills/\u00c9nergie']);
  });
});
