import type { DocumentRow } from './types.js';

/** An upload was started: the document may already be in Drive (it can't be filed, combined or re-analysed safely). */
export function possiblyInDrive(d: DocumentRow): boolean {
  return d.state !== 'filed' && (d.filingTarget !== null || d.uploadUnverified);
}

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
      contentSeen: d.analysis.contentSeen,
    },
    decision: d.decision,
    filed:
      d.state === 'filed'
        ? { name: d.filedName, folderPath: d.filedFolderPath, driveNodeUid: d.driveNodeUid, driveUrl: d.driveUrl }
        : null,
    autoFiled: d.autoFiled,
    prepareNote: d.prepareNote,
    // The blobs are deleted once a document is filed.
    hasThumbnail: d.hasThumbnail && d.state !== 'filed',
    userEdited: d.userEdited,
    // An upload was started: discarding now may leave a copy in Drive (the PWA warns).
    possiblyInDrive: possiblyInDrive(d),
    discardRequested: d.discardRequested,
    discardedAt: d.discardedAt,
    combinedInto: d.combinedInto,
    // The name only: the anchor's folder and id stay on the server.
    anchorName: d.anchor?.name ?? null,
  };
}

export type DocumentView = ReturnType<typeof toView>;
