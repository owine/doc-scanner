import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError } from '../api.js';
import type { DocumentsApi } from './api.js';
import type { FolderEntry } from './types.js';

export interface FoldersState {
  folders: FolderEntry[] | null;
  error: string | null;
  busy: boolean;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** The folder list (never-file-here folders already left out by the server). */
export function useFolders(api: Pick<DocumentsApi, 'folders' | 'refreshFolders'>): FoldersState {
  const [folders, setFolders] = useState<FolderEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setFolders((await api.folders()).folders);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'folders_not_loaded'
          ? 'The folder list has not loaded from Drive yet.'
          : 'Could not load the folder list.',
      );
    }
  }, [api]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await api.refreshFolders();
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'not_logged_in'
          ? 'Sign in again to read your Drive folders.'
          : 'Could not refresh the folder list from Drive.',
      );
    } finally {
      setBusy(false);
    }
  }, [api, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { folders, error, busy, reload, refresh };
}
