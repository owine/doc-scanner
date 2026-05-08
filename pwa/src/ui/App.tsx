import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { LoginScreen } from './LoginScreen.js';
import { StatusScreen } from './StatusScreen.js';
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
  | { kind: 'status' }
  | { kind: 'scanner'; resumeScanId?: string }
  | { kind: 'saved' }
  | { kind: 'viewer'; scanId: string };

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'status' });
  const [store] = useState(() => new ScansStore());
  const [queue] = useState(() => new OcrQueue(store, new WorkerClient(), buildSearchablePdf));
  const [resume, setResume] = useState<Scan | null>(null);

  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
    store.open()
      .then(() => queue.start())
      .catch((e) => console.error('open store', e));
  }, []);

  useEffect(() => {
    if (!email) return;
    store.findInProgress().then((s) => setResume(s));
  }, [email]);

  if (!loaded) return <main class="auth-screen">Loading…</main>;
  if (!email) return <LoginScreen onLoggedIn={setEmail} />;

  if (resume && route.kind === 'status') {
    return (
      <ResumePrompt
        scan={resume}
        onResume={() => { setResume(null); setRoute({ kind: 'scanner', resumeScanId: resume.id }); }}
        onDiscard={async () => { await store.delete(resume.id); setResume(null); }}
      />
    );
  }

  switch (route.kind) {
    case 'status':
      return <StatusScreen
        email={email}
        onLoggedOut={() => setEmail(null)}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onViewSavedScans={() => setRoute({ kind: 'saved' })}
      />;
    case 'scanner':
      return <ScannerScreen
        store={store}
        queue={queue}
        {...(route.resumeScanId !== undefined ? { resumeScanId: route.resumeScanId } : {})}
        onBack={() => setRoute({ kind: 'status' })}
        onDone={() => setRoute({ kind: 'saved' })}
      />;
    case 'saved':
      return <SavedScansScreen
        store={store}
        queue={queue}
        onBack={() => setRoute({ kind: 'status' })}
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
