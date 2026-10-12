import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks';
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

/**
 * The threshold as typed, with a decimal comma read as a point. Null unless
 * it is a plain decimal number ("0.85", ".9", "1"): no signs or exponents.
 */
function parseThreshold(input: string): { text: string; value: number } | null {
  const text = input.trim().replace(',', '.');
  return /^(\d+\.?\d*|\.\d+)$/.test(text) ? { text, value: Number(text) } : null;
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
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // The threshold is edited as text: a number-bound input rewrites "0." to "0"
  // on every render, so a decimal could not be typed, and iOS number keyboards
  // can lack a decimal point or type a comma.
  const [thresholdText, setThresholdText] = useState('');

  // Set false on unmount so nothing is set after an await resolves late.
  const mounted = useRef(true);
  // A layout effect: Preact 11 runs useEffect cleanups after paint, too late for this guard.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    documents
      .settings()
      .then((s) => {
        if (!mounted.current) return;
        setSaved(s);
        setDraft(s);
        setThresholdText(String(s.autoFileThreshold));
      })
      .catch(() => mounted.current && setStatus('Could not load settings.'));
  }, [documents]);

  // "Saved." describes the form as it was saved; any edit makes it stale.
  const clearSaved = () => setStatus((s) => (s === 'Saved.' ? null : s));
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    clearSaved();
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };
  const patch = draft && saved ? changedFields(draft, saved) : {};
  const threshold = parseThreshold(thresholdText);
  const thresholdTooPrecise = threshold !== null && /\.\d{3,}$/.test(threshold.text);
  const thresholdValid = threshold !== null && !thresholdTooPrecise && threshold.value >= 0.5 && threshold.value <= 1;
  const modelValid = draft === null || draft.model.trim() !== '';
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    if (!dirty || !thresholdValid || !modelValid) return;
    setBusy(true);
    setStatus(null);
    try {
      const s = await documents.saveSettings(patch);
      if (!mounted.current) return;
      setSaved(s);
      setDraft(s);
      setThresholdText(String(s.autoFileThreshold));
      setStatus('Saved.');
      // /api/folders hides excluded subtrees, so the list is now stale.
      if ('excludePaths' in patch) void folders.reload();
    } catch (err) {
      if (!mounted.current) return;
      setStatus(
        err instanceof ApiError && err.code === 'invalid_input'
          ? 'A value was rejected. Check the model name, a threshold between 0.5 and 1 with at most two decimals, and the excluded folders.'
          : 'Could not save settings.',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function refreshFolders() {
    setRefreshed(false);
    await folders.refresh();
    if (mounted.current) setRefreshed(true);
  }

  async function logout() {
    setSignOutError(null);
    try {
      await api.logout();
    } catch {
      if (!mounted.current) return;
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
      {/* Keyed: unkeyed, Preact 11 matches the form against the next section's
          card when settings load and re-creates every control below it. */}
      {draft === null ? (
        <p key="filing-status" role="status" class="muted">
          {status ?? 'Loading…'}
        </p>
      ) : (
        <div key="filing-form" class="card">
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <label class="field">
            <input type="checkbox" checked={draft.autoFileEnabled} onChange={(e) => set('autoFileEnabled', (e.target as HTMLInputElement).checked)} />{' '}
            File automatically when confident
          </label>
          <label class="field">
            <span class="field-label">Auto-file threshold (0.5 to 1)</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={!thresholdValid}
              {...(!thresholdValid && { 'aria-describedby': 'threshold-error' })}
              value={thresholdText}
              onInput={(e) => {
                const text = (e.target as HTMLInputElement).value;
                clearSaved();
                setThresholdText(text);
                const parsed = parseThreshold(text);
                if (parsed) set('autoFileThreshold', parsed.value);
              }}
            />
          </label>
          {!thresholdValid && (
            <span id="threshold-error" class="error-text">
              {thresholdTooPrecise ? 'Use at most two decimals, such as 0.85.' : 'Enter a number between 0.5 and 1.'}
            </span>
          )}
          <label class="field">
            <span class="field-label">Model</span>
            <input
              value={draft.model}
              aria-invalid={!modelValid}
              {...(!modelValid && { 'aria-describedby': 'model-error' })}
              onInput={(e) => set('model', (e.target as HTMLInputElement).value)}
            />
          </label>
          {!modelValid && (
            <span id="model-error" class="error-text">
              Enter a model name.
            </span>
          )}
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
            <ul class="doc-list" role="list">
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
                // The server refuses "/": excluding it would leave nowhere to file.
                allowRoot={false}
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
          <p role="status" class={status === 'Saved.' ? 'muted' : 'error-text'}>
            {status}
          </p>
          <button class="btn" disabled={busy || !dirty || !thresholdValid || !modelValid} onClick={() => void save()}>
            Save
          </button>
          </fieldset>
        </div>
      )}

      <h2>Drive folders</h2>
      <div class="card">
        <button class="btn btn-secondary" disabled={folders.busy} onClick={() => void refreshFolders()}>
          {folders.busy ? 'Refreshing…' : 'Refresh folder list'}
        </button>
        <p role="status" class={folders.error ? 'error-text' : 'muted'}>
          {refreshed && !folders.busy ? (folders.error ?? `Loaded ${folders.folders?.length ?? 0} folders.`) : ''}
        </p>
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
