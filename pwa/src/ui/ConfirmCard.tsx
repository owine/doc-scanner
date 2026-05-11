import { useState } from 'preact/hooks';
import type { UploadSuggestion } from '../scanner/types.js';

// Mirrors the server's NAME_REGEX in classify/haiku.ts. Keep in sync.
const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;
// Below this confidence the user sees a small "Low confidence" hint —
// the suggestion is still pre-filled, this is just a nudge to read it
// carefully before tapping Save.
const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface ConfirmCardProps {
  scanId: string;
  /**
   * Suggestion from /api/classify; `null` when classify failed/timed-out
   * — fields stay empty, user fills manually, Save still works.
   */
  suggestion: UploadSuggestion | null;
  folders: { linkId: string; path: string }[];
  onSave(name: string, folderLinkId: string): Promise<void>;
  onDismiss(): void;
  onRefreshFolders(): Promise<void>;
}

export function ConfirmCard({ suggestion, folders, onSave, onDismiss, onRefreshFolders }: ConfirmCardProps) {
  const [name, setName] = useState(suggestion?.suggestedName ?? '');
  const [folderId, setFolderId] = useState(suggestion?.suggestedFolderLinkId ?? '');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const valid = NAME_REGEX.test(name) && folderId.length > 0;

  async function handleRefresh() {
    setRefreshing(true);
    try { await onRefreshFolders(); }
    finally { setRefreshing(false); }
  }

  async function handleSave() {
    setBusy(true);
    try { await onSave(name, folderId); }
    finally { setBusy(false); }
  }

  return (
    <main class="auth-screen">
      <div class="card">
        <h2 style={{ marginTop: 0 }}>Save to Drive</h2>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span>Filename</span>
          <input
            aria-label="filename"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: 8 }}
          />
          {name.length > 0 && !NAME_REGEX.test(name) && (
            <small class="muted" style={{ color: '#c00' }}>
              Use letters, digits, spaces, and . , ' _ - only (≤80 chars).
            </small>
          )}
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span>Folder</span>
          <select
            aria-label="folder"
            value={folderId}
            onChange={(e) => setFolderId((e.target as HTMLSelectElement).value)}
            style={{ width: '100%', padding: 8 }}
          >
            <option value="">— pick a folder —</option>
            {folders.map((f) => (
              <option key={f.linkId} value={f.linkId}>{f.path}</option>
            ))}
          </select>
          <button
            type="button"
            class="btn btn-secondary"
            onClick={handleRefresh}
            disabled={refreshing}
            style={{ marginTop: 6, fontSize: 12 }}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh folders'}
          </button>
        </label>

        {suggestion && (
          <p class="muted" style={{ fontSize: 13 }}>
            <em>{suggestion.rationale}</em>
            {suggestion.confidence < LOW_CONFIDENCE_THRESHOLD && (
              <span
                aria-label="low confidence"
                style={{
                  marginLeft: 8, padding: '2px 6px', borderRadius: 3,
                  background: '#fff3cd', color: '#856404', fontSize: 11,
                }}
              >Low confidence</span>
            )}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button class="btn" onClick={handleSave} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button class="btn btn-secondary" onClick={onDismiss} disabled={busy}>Dismiss</button>
        </div>
      </div>
    </main>
  );
}
