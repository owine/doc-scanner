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
    <main style={{ maxWidth: 400, margin: '40px auto', padding: 16, fontFamily: 'system-ui' }}>
      <h1>doc-scanner</h1>
      <div role="alert" style={{ background: '#fef3c7', border: '1px solid #f59e0b', padding: 12, borderRadius: 6, marginBottom: 16 }}>
        <strong>Warning:</strong> This is an unofficial app. Your Proton credentials are sent
        only to your own server. Proton does not endorse this app. Your password is never stored.
      </div>
      <form onSubmit={submit}>
        <label>Email<br /><input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required autoComplete="username" /></label><br /><br />
        <label>Password<br /><input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required autoComplete="current-password" /></label><br /><br />
        {needsTotp && (<><label>TOTP<br /><input type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} value={totp} onInput={(e) => setTotp((e.target as HTMLInputElement).value)} required /></label><br /><br /></>)}
        {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
