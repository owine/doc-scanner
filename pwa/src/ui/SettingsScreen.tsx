import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { documentsApi, type DocumentsApi } from '../documents/api.js';
import type { Settings } from '../documents/types.js';
import { useFolders } from '../documents/use-folders.js';
import { useTheme } from '../theme/use-theme.js';
import { FolderPicker } from './inbox/FolderPicker.js';

export interface SettingsScreenProps {
  email: string;
  documents?: DocumentsApi;
  onBack: () => void;
  onLoggedOut: () => void;
}

/**
 * The fields that differ from what is saved. The server stores every key it
 * is sent, and a stored value overrides its env default for good, so an
 * untouched field must not be sent: it keeps following its env var.
 */
function changedFields(draft: Settings, saved: Settings): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as (keyof Settings)[]) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) patch[key] = draft[key];
  }
  return patch as Partial<Settings>;
}

export function SettingsScreen({ email, documents = documentsApi, onBack, onLoggedOut }: SettingsScreenProps) {
  const { pref, setPref } = useTheme();
  const folders = useFolders(documents);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  // The threshold is edited as text: a number-bound input rewrites "0." to "0"
  // on every render, so a decimal could not be typed.
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [thresholdText, setThresholdText] = useState('');

  useEffect(() => {
    documents
      .settings()
      .then((s) => {
        setSaved(s);
        setDraft(s);
        setThresholdText(String(s.autoFileThreshold));
      })
      .catch(() => setStatus('Could not load settings.'));
  }, [documents]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const patch = draft && saved ? changedFields(draft, saved) : {};
  const thresholdValid = thresholdText.trim() !== '' && Number.isFinite(Number(thresholdText));
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    if (!dirty || !thresholdValid) return;
    setBusy(true);
    setStatus(null);
    try {
      const s = await documents.saveSettings(patch);
      setSaved(s);
      setDraft(s);
      setThresholdText(String(s.autoFileThreshold));
      setStatus('Saved.');
    } catch (err) {
      setStatus(
        err instanceof ApiError && err.code === 'invalid_input'
          ? 'A value was rejected. The threshold must be between 0.5 and 1, with at most two decimals.'
          : 'Could not save settings.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshFolders() {
    setRefreshed(false);
    await folders.refresh();
    setRefreshed(true);
  }

  async function logout() {
    setSignOutError(null);
    try {
      await api.logout();
    } catch {
      // The server keeps the live session until it restarts, so leaving the
      // screen now would look signed out while it is not.
      setSignOutError('Could not sign out. Check your connection and try again.');
      return;
    }
    onLoggedOut();
  }

  return (
    <main class="inbox">
      <header class="inbox-header">
        <button class="btn btn-secondary" onClick={onBack}>
          ← Back
        </button>
        <h1>Settings</h1>
      </header>

      <h2>Filing</h2>
      {draft === null ? (
        <p class="muted">{status ?? 'Loading…'}</p>
      ) : (
        <div class="card">
          <label class="field">
            <input type="checkbox" checked={draft.autoFileEnabled} onChange={(e) => set('autoFileEnabled', (e.target as HTMLInputElement).checked)} />{' '}
            File automatically when confident
          </label>
          <label class="field">
            <span class="field-label">Auto-file threshold (0.5 to 1)</span>
            <input
              type="number"
              min="0.5"
              max="1"
              step="0.05"
              value={thresholdText}
              onInput={(e) => {
                const text = (e.target as HTMLInputElement).value;
                setThresholdText(text);
                if (text.trim() !== '' && Number.isFinite(Number(text))) set('autoFileThreshold', Number(text));
              }}
            />
            {!thresholdValid && <span class="error-text">Enter a number between 0.5 and 1.</span>}
          </label>
          <label class="field">
            <span class="field-label">Model</span>
            <input value={draft.model} onInput={(e) => set('model', (e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span class="field-label">Effort</span>
            <select value={draft.effort} onChange={(e) => set('effort', (e.target as HTMLSelectElement).value as Settings['effort'])}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <div class="field">
            <span class="field-label">Never file here</span>
            {draft.excludePaths.length === 0 && <p class="muted">No folders excluded.</p>}
            <ul class="doc-list">
              {draft.excludePaths.map((p) => (
                <li key={p} class="doc-row">
                  <span class="doc-main">{p}</span>
                  <button
                    class="btn btn-secondary btn-small"
                    aria-label={`Remove ${p}`}
                    onClick={() => set('excludePaths', draft.excludePaths.filter((x) => x !== p))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {picking ? (
              <FolderPicker
                folders={folders}
                allowNew={false}
                onChoose={(f) => {
                  if (f.kind === 'existing' && !draft.excludePaths.includes(f.path)) set('excludePaths', [...draft.excludePaths, f.path]);
                  setPicking(false);
                }}
                onCancel={() => setPicking(false)}
              />
            ) : (
              <button class="btn btn-secondary btn-small" onClick={() => setPicking(true)}>
                Add folder
              </button>
            )}
          </div>
          {status && (
            <p role="status" class={status === 'Saved.' ? 'muted' : 'error-text'}>
              {status}
            </p>
          )}
          <button class="btn" disabled={busy || !dirty || !thresholdValid} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}

      <h2>Drive folders</h2>
      <div class="card">
        <button class="btn btn-secondary" disabled={folders.busy} onClick={() => void refreshFolders()}>
          {folders.busy ? 'Refreshing…' : 'Refresh folder list'}
        </button>
        {refreshed && !folders.busy && (
          <p class={folders.error ? 'error-text' : 'muted'}>{folders.error ?? `Loaded ${folders.folders?.length ?? 0} folders.`}</p>
        )}
      </div>

      <h2>Theme</h2>
      <div class="card" role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 8 }}>
        {(['system', 'light', 'dark'] as const).map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={pref === p}
            class={pref === p ? 'btn' : 'btn btn-secondary'}
            onClick={() => setPref(p)}
            style={{ textTransform: 'capitalize' }}
          >
            {p}
          </button>
        ))}
      </div>

      <h2>Account</h2>
      <div class="card">
        <p>
          Signed in as <strong>{email}</strong>
        </p>
        <button class="btn btn-secondary" onClick={() => void logout()}>
          Sign out
        </button>
        <p role="status" class="error-text">
          {signOutError}
        </p>
      </div>
    </main>
  );
}
