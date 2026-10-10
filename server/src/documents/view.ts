import type { DocumentRow } from './types.js';

/** What the API returns for a document: no blobs, no history text. */
export function toView(d: DocumentRow) {
  return {
    id: d.id,
    seq: d.seq,
    state: d.state,
    source: d.source,
    originalName: d.originalName,
    mime: d.mime,
    size: d.size,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    reviewReason: d.reviewReason,
    error: d.error,
    attempts: d.attempts,
    analysis: d.analysis && {
      name: d.analysis.name,
      folder: d.analysis.folder,
      confidence: d.analysis.confidence,
      rationale: d.analysis.rationale,
      isDocument: d.analysis.isDocument,
    },
    decision: d.decision,
    filed: d.state === 'filed' ? { name: d.filedName, folderPath: d.filedFolderPath, driveNodeUid: d.driveNodeUid } : null,
    autoFiled: d.autoFiled,
    userEdited: d.userEdited,
    // An upload was started: discarding now may leave a copy in Drive (the PWA warns).
    possiblyInDrive: d.state !== 'filed' && d.filingTarget !== null,
    discardRequested: d.discardRequested,
    discardedAt: d.discardedAt,
  };
}

export type DocumentView = ReturnType<typeof toView>;
