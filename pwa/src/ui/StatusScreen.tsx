import { api } from '../api.js';
import { useTheme } from '../theme/use-theme.js';

export interface StatusScreenProps {
  email: string;
  onLoggedOut: () => void;
  onNewScan: () => void;
  onViewSavedScans: () => void;
}

export function StatusScreen({ email, onLoggedOut, onNewScan, onViewSavedScans }: StatusScreenProps) {
  const { pref, setPref } = useTheme();
  async function logout() { await api.logout(); onLoggedOut(); }

  return (
    <main class="auth-screen">
      <h1>doc-scanner</h1>
      <p>Logged in as <strong>{email}</strong></p>

      <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <button class="btn" onClick={onNewScan}>+ New Scan</button>
        <button class="btn btn-secondary" onClick={onViewSavedScans}>Saved Scans</button>
      </div>

      <div class="card" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>Theme</div>
        <div role="radiogroup" style={{ display: 'flex', gap: 8 }}>
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
      </div>

      <button class="btn btn-secondary" onClick={logout}>Sign out</button>
    </main>
  );
}
