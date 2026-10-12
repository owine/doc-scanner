import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { documentsApi } from '../documents/api.js';
import { DocumentSync } from '../documents/sync.js';
import { LoginScreen } from './LoginScreen.js';
import { InboxScreen } from './inbox/InboxScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { ScannerScreen } from './ScannerScreen.js';
import { SavedScansScreen } from './SavedScansScreen.js';
import { ScanViewerScreen } from './ScanViewerScreen.js';
import { ResumePrompt } from './ResumePrompt.js';
import { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';
import { OcrQueue } from '../ocr/queue.js';
import { WorkerClient } from '../ocr/worker-client.js';
import { buildSearchablePdf } from '../pdf/build.js';

type Route =
  | { kind: 'inbox' }
  | { kind: 'settings' }
  | { kind: 'scanner'; resumeScanId?: string }
  | { kind: 'saved' }
  | { kind: 'viewer'; scanId: string };

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'inbox' });
  const [store] = useState(() => new ScansStore());
  const [queue] = useState(() => new OcrQueue(store, new WorkerClient(), buildSearchablePdf));
  const [resume, setResume] = useState<Scan | null>(null);
  const [sync] = useState(
    () => new DocumentSync({ list: documentsApi.list, onUnauthorized: () => { setEmail(null); setRoute({ kind: 'inbox' }); } }),
  );
  // One open, shared: the in-progress lookup below must not run before it finishes.
  const [storeOpen] = useState(() => store.open());

  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
    storeOpen
      .then(() => queue.start())
      .catch((e) => console.error('open store', e));
  }, []);

  useEffect(() => {
    if (!email) return;
    storeOpen
      .then(() => store.findInProgress())
      .then((s) => setResume(s))
      .catch((e) => console.error('find in-progress scan', e));
    sync.start();
    return () => {
      sync.stop();
      sync.reset();
    };
  }, [email]);

  function signedOut() {
    setEmail(null);
    setRoute({ kind: 'inbox' });
  }

  async function signInAgain() {
    // The session's Drive access is gone; a fresh login restores it and
    // releases the documents waiting for it.
    //
    // Unlike Sign out in Settings, a failed logout still goes to the login
    // screen. There, staying put protects the user: leaving would look signed
    // out while the server still holds a working session. Here the session
    // can no longer reach Drive, and the login that follows replaces this
    // browser's session cookie, so nothing is left usable behind it. Saying
    // so on the login screen would give the user nothing to act on.
    await api.logout().catch(() => {});
    signedOut();
  }

  if (!loaded) return <main class="auth-screen">Loading…</main>;
  if (!email) return <LoginScreen onLoggedIn={setEmail} />;

  if (resume && route.kind === 'inbox') {
    return (
      <ResumePrompt
        scan={resume}
        onResume={() => { setResume(null); setRoute({ kind: 'scanner', resumeScanId: resume.id }); }}
        onDiscard={async () => { await store.delete(resume.id); setResume(null); }}
      />
    );
  }

  switch (route.kind) {
    case 'inbox':
      return <InboxScreen
        sync={sync}
        onScan={() => setRoute({ kind: 'scanner' })}
        onSavedScans={() => setRoute({ kind: 'saved' })}
        onSettings={() => setRoute({ kind: 'settings' })}
        onSignInAgain={() => void signInAgain()}
      />;
    case 'settings':
      return <SettingsScreen email={email} onBack={() => setRoute({ kind: 'inbox' })} onLoggedOut={signedOut} />;
    case 'scanner':
      return <ScannerScreen
        store={store}
        queue={queue}
        {...(route.resumeScanId !== undefined ? { resumeScanId: route.resumeScanId } : {})}
        onBack={() => setRoute({ kind: 'inbox' })}
        onDone={() => setRoute({ kind: 'saved' })}
      />;
    case 'saved':
      return <SavedScansScreen
        store={store}
        queue={queue}
        onBack={() => setRoute({ kind: 'inbox' })}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onView={(scanId) => setRoute({ kind: 'viewer', scanId })}
      />;
    case 'viewer':
      return <ScanViewerScreen
        store={store}
        queue={queue}
        scanId={route.scanId}
        onBack={() => setRoute({ kind: 'saved' })}
      />;
  }
}
