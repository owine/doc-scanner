import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { searchFolders } from '../../documents/folder-search.js';
import type { FolderEntry, FolderRef } from '../../documents/types.js';
import type { FoldersState } from '../../documents/use-folders.js';

export interface FolderPickerProps {
  folders: FoldersState;
  /** Offer "new folder inside this one" on each result. */
  allowNew: boolean;
  /** Offer the root folder ("/"). Off where it can't be used, such as never-file-here. */
  allowRoot?: boolean;
  onChoose: (folder: FolderRef) => void;
  onCancel: () => void;
}

export function FolderPicker({ folders, allowNew, allowRoot = true, onChoose, onCancel }: FolderPickerProps) {
  const [query, setQuery] = useState('');
  const [newIn, setNewIn] = useState<FolderEntry | null>(null);
  const [newName, setNewName] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const plusRefs = useRef(new Map<string, HTMLButtonElement>());
  // Bumped on every "+" click so the name field takes focus again even for the same row.
  const [focusTick, setFocusTick] = useState(0);
  const offered = useMemo(
    () => (folders.folders && !allowRoot ? folders.folders.filter((f) => f.path !== '/') : folders.folders),
    [folders.folders, allowRoot],
  );
  const results = useMemo(() => (offered ? searchFolders(offered, query) : []), [offered, query]);

  // Once, when the picker opens. (autoFocus is ignored on elements inserted
  // after page load, so focus explicitly.) The list is reloaded every time,
  // so a folder created by an approval since it loaded is offered; the list
  // already held stays up meanwhile.
  useEffect(() => {
    searchRef.current?.focus();
    void folders.reload();
  }, []);

  useEffect(() => {
    if (newIn) newNameRef.current?.focus();
  }, [newIn, focusTick]);

  return (
    <div
      class="folder-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.isComposing) {
          e.stopPropagation();
          onCancel();
        }
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
        <p class="error-text" role="alert">
          {folders.error}{' '}
          <button type="button" class="btn btn-secondary btn-small" disabled={folders.busy} onClick={() => void folders.refresh()}>
            {folders.busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </p>
      )}
      {folders.folders === null && !folders.error && <p class="muted" role="status">Loading folders…</p>}
      <ul class="folder-results">
        {results.map((f) => (
          <li key={f.linkId}>
            <button type="button" class="folder-result" onClick={() => onChoose({ kind: 'existing', linkId: f.linkId, path: f.path })}>
              {f.path}
            </button>
            {allowNew && (
              <button
                type="button"
                ref={(el) => {
                  if (el) plusRefs.current.set(f.linkId, el);
                  else plusRefs.current.delete(f.linkId);
                }}
                class="btn btn-secondary btn-small"
                aria-label={`New folder in ${f.path}`}
                onClick={() => {
                  setNewIn(f);
                  setNewName('');
                  setFocusTick((t) => t + 1);
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
                <input
                  ref={newNameRef}
                  aria-label="New folder name"
                  value={newName}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !e.isComposing) {
                      e.stopPropagation();
                      setNewIn(null);
                      plusRefs.current.get(f.linkId)?.focus();
                    }
                  }}
                  onInput={(e) => setNewName((e.target as HTMLInputElement).value)} />
                <button class="btn btn-small" type="submit" disabled={!newName.trim()}>
                  Use new folder
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <button type="button" class="btn btn-secondary" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
