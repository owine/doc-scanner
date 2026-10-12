import type { DocumentSource, DocumentState, DocumentView, FolderRef } from '../../documents/types.js';

export const SOURCE_LABEL: Record<DocumentSource, string> = {
  picker: 'Added',
  scanner: 'Scanned',
  share: 'Shared',
  email: 'Emailed',
};

export const WAITING_LABEL: Partial<Record<DocumentState, string>> = {
  received: 'Queued',
  analyzing: 'Analysing…',
  preparing: 'Preparing…',
  ready: 'Ready to file',
  filing: 'Filing…',
  awaiting_login: 'Waiting for sign-in',
};

/** The best name the document has so far. */
export function displayName(d: DocumentView): string {
  return d.filed?.name ?? d.decision?.name ?? d.analysis?.name ?? d.originalName ?? 'Untitled document';
}

export function folderLabel(f: FolderRef): string {
  return f.kind === 'existing' ? f.path : `${f.parentPath === '/' ? '' : f.parentPath}/${f.name}`;
}

/** Whether to go ahead with a discard: asks first when an upload may already be in Drive. */
export function confirmDiscard(d: DocumentView): boolean {
  return !d.possiblyInDrive || window.confirm('An upload of this document may already have reached Drive. Discard it anyway?');
}

/** The Drive link, only if it is an https link to Proton (the SDK builds drive.proton.me or docs.proton.me links). */
export function safeDriveUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'drive.proton.me' || u.hostname === 'docs.proton.me') ? url : null;
  } catch {
    return null;
  }
}
