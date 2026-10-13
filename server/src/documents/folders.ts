import type { FolderChoice } from '../analyze/types.js';

/** The folder's own path; for a new folder, the one it will have once created (so it is under its parent's). */
export function folderPath(folder: FolderChoice): string {
  if (folder.kind === 'existing') return folder.path;
  return `${folder.parentPath === '/' ? '' : folder.parentPath}/${folder.name}`;
}
