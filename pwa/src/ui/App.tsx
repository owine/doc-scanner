import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { LoginScreen } from './LoginScreen.js';
import { StatusScreen } from './StatusScreen.js';

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return <main style={{ padding: 16 }}>Loading…</main>;
  return email ? <StatusScreen email={email} onLoggedOut={() => setEmail(null)} /> : <LoginScreen onLoggedIn={setEmail} />;
}
