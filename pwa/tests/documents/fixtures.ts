import type { DocumentView, FolderEntry } from '../../src/documents/types.js';

let n = 0;

/** A document in review unless overridden. Fictional data only. */
export function makeDoc(over: Partial<DocumentView> = {}): DocumentView {
  n++;
  return {
    id: `doc${n}`,
    seq: n,
    state: 'needs_review',
    source: 'picker',
    originalName: `scan-${n}.pdf`,
    mime: 'application/pdf',
    size: 1000,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    reviewReason: 'confidence 0.600 is below 0.80',
    error: null,
    attempts: 0,
    analysis: {
      name: 'Northwind Energy Bill 2026-09',
      folder: { kind: 'existing', linkId: 'L-energy', path: '/Bills/Energy' },
      confidence: 0.6,
      rationale: 'An energy bill from Northwind Energy for September.',
      isDocument: true,
      contentSeen: true,
    },
    decision: null,
    filed: null,
    autoFiled: false,
    userEdited: false,
    possiblyInDrive: false,
    discardRequested: false,
    discardedAt: null,
    ...over,
  };
}

export const FOLDERS: FolderEntry[] = [
  { linkId: 'L-root', path: '/' },
  { linkId: 'L-bills', path: '/Bills' },
  { linkId: 'L-energy', path: '/Bills/Energy' },
  { linkId: 'L-water', path: '/Bills/Water' },
  { linkId: 'L-tax', path: '/Taxes/2026' },
  { linkId: 'L-energy-old', path: '/Archive/Energy' },
];
