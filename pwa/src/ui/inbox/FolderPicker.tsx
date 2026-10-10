import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { searchFolders } from '../../documents/folder-search.js';
import type { FolderEntry, FolderRef } from '../../documents/types.js';
import type { FoldersState } from '../../documents/use-folders.js';

export interface FolderPickerProps {
  folders: FoldersState;
  /** Offer "new folder inside this one" on each result. */
  allowNew: boolean;
  onChoose: (folder: FolderRef) => void;
  onCancel: () => void;
}

export function FolderPicker({ folders, allowNew, onChoose, onCancel }: FolderPickerProps) {
  const [query, setQuery] = useState('');
  const [newIn, setNewIn] = useState<FolderEntry | null>(null);
  const [newName, setNewName] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (folders.folders ? searchFolders(folders.folders, query) : []), [folders.folders, query]);

  // Once, when the picker opens. (autoFocus is ignored on elements inserted
  // after page load, so focus explicitly.)
  useEffect(() => {
    searchRef.current?.focus();
    if (folders.folders === null) void folders.reload();
  }, []);

  useEffect(() => {
    if (newIn) newNameRef.current?.focus();
  }, [newIn]);

  return (
    <div
      class="folder-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <input
        ref={searchRef}
        type="search"
        aria-label="Search folders"
        placeholder="Search folders"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      {folders.error && (
        <p class="error-text">
          {folders.error}{' '}
          <button class="btn btn-secondary btn-small" disabled={folders.busy} onClick={() => void folders.refresh()}>
            {folders.busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </p>
      )}
      {folders.folders === null && !folders.error && <p class="muted">Loading folders…</p>}
      <ul class="folder-results">
        {results.map((f) => (
          <li key={f.linkId}>
            <button class="folder-result" onClick={() => onChoose({ kind: 'existing', linkId: f.linkId, path: f.path })}>
              {f.path}
            </button>
            {allowNew && (
              <button
                class="btn btn-secondary btn-small"
                aria-label={`New folder in ${f.path}`}
                onClick={() => {
                  setNewIn(f);
                  setNewName('');
                }}
              >
                +
              </button>
            )}
            {newIn?.linkId === f.linkId && (
              <form
                class="new-folder"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newName.trim();
                  if (name) onChoose({ kind: 'new', parentLinkId: f.linkId, parentPath: f.path, name });
                }}
              >
                <input ref={newNameRef} aria-label="New folder name" value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} />
                <button class="btn btn-small" type="submit" disabled={!newName.trim()}>
                  Use new folder
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <button class="btn btn-secondary" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
