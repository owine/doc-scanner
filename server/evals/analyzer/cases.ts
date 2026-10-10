import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TreeFolder } from '../../src/drive/folder-tree.js';

/** File types the analyzer reads natively; the sampler only picks these. */
export const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/plain': '.txt',
};

export interface EvalCase {
  id: string;
  fileUid: string;
  mimeType: string;
  /** Relative to the flow directory. */
  docPath: string;
  /** The user's filename, extension included. */
  expectedName: string;
  expectedFolderLinkId: string;
  expectedFolderPath: string;
  /** Other files in the same folder; 0 means no naming examples to learn from. */
  siblingCount: number;
}

export function loadCases(flow: string): EvalCase[] {
  return JSON.parse(readFileSync(join(flow, 'inputs', 'cases.json'), 'utf8'));
}

export function loadTree(flow: string): TreeFolder[] {
  const raw = JSON.parse(readFileSync(join(flow, 'inputs', 'tree.json'), 'utf8')) as TreeFolder[];
  return raw.map((f) => ({ ...f, files: f.files.map((file) => ({ ...file, modified: new Date(file.modified) })) }));
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
