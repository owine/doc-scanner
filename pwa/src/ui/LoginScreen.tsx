import { useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.login(totp ? { email, password, totp } : { email, password });
      onLoggedIn(res.email);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') { setNeedsTotp(true); setError('TOTP code required'); }
      else setError(err instanceof Error ? err.message : 'Login failed');
    } finally { setBusy(false); }
  }

  return (
    <main class="auth-screen">
      <h1>doc-scanner</h1>
      <div role="alert" class="warn">
        <strong>Warning:</strong> This is an unofficial app. Your Proton credentials are sent
        only to your own server. Proton does not endorse this app. Your password is never stored.
      </div>
      <form onSubmit={submit}>
        <label class="field">
          <span class="field-label">Email</span>
          <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required autoComplete="username" />
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required autoComplete="current-password" />
        </label>
        {needsTotp && (
          <label class="field">
            <span class="field-label">TOTP</span>
            <input type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} value={totp} onInput={(e) => setTotp((e.target as HTMLInputElement).value)} required />
          </label>
        )}
        {error && <p class="error-text">{error}</p>}
        <button class="btn btn-block" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
