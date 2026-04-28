import { api } from '../api.js';

export function StatusScreen({ email, onLoggedOut }: { email: string; onLoggedOut: () => void }) {
  async function logout() { await api.logout(); onLoggedOut(); }
  return (
    <main style={{ maxWidth: 400, margin: '40px auto', padding: 16, fontFamily: 'system-ui' }}>
      <h1>doc-scanner</h1>
      <p>Logged in as <strong>{email}</strong></p>
      <button onClick={logout}>Sign out</button>
    </main>
  );
}
