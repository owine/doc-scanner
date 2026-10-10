import type { FolderEntry } from './types.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const byPath = (a: FolderEntry, b: FolderEntry) => a.path.localeCompare(b.path);

/**
 * The folder picker's search: every word of the query must appear somewhere
 * in the path. Folders whose own name (the last segment) has every word rank
 * first, then shorter paths, then alphabetically.
 */
export function searchFolders(folders: readonly FolderEntry[], query: string, limit = 50): FolderEntry[] {
  const words = fold(query).split(/[\s/]+/).filter(Boolean);
  if (words.length === 0) return [...folders].sort(byPath).slice(0, limit);
  const scored: { f: FolderEntry; score: number }[] = [];
  for (const f of folders) {
    const path = fold(f.path);
    if (!words.every((w) => path.includes(w))) continue;
    const own = path.slice(path.lastIndexOf('/') + 1);
    scored.push({ f, score: (words.every((w) => own.includes(w)) ? 0 : 10_000) + path.length });
  }
  return scored
    .sort((a, b) => a.score - b.score || byPath(a.f, b.f))
    .slice(0, limit)
    .map((s) => s.f);
}
