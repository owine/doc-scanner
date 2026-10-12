import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { documentsApi } from '../documents/api.js';
import { DocumentSync } from '../documents/sync.js';
import { LoginScreen } from './LoginScreen.js';
import { InboxScreen } from './inbox/InboxScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { ScannerScreen } from './ScannerScreen.js';
import { ResumePrompt } from './ResumePrompt.js';
import { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';
import { sendScanToInbox } from '../uploads/scans.js';
import { UploadQueue } from '../uploads/queue.js';
import { captureRequestFailure } from '../observability/sentry.js';

type Route =
  | { kind: 'inbox' }
  | { kind: 'settings' }
  | { kind: 'scanner'; resumeScanId?: string };

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'inbox' });
  const [store] = useState(() => new ScansStore());
  const [resume, setResume] = useState<Scan | null>(null);
  const [sync] = useState(
    () => new DocumentSync({ list: documentsApi.list, onUnauthorized: () => { setEmail(null); setRoute({ kind: 'inbox' }); } }),
  );
  // One open, shared: the in-progress lookup and the inbox's device scans wait on it.
  const [storeOpen] = useState(() => store.open());
  const [uploads] = useState(
    () =>
      new UploadQueue({
        onUploaded: async ({ scanId }) => {
          try {
            // The server has the scan; its copy on this device can go.
            if (scanId) await storeOpen.then(() => store.delete(scanId));
          } catch (e) {
            // The queue keeps it off the device list for this session. Never the scan's name.
            console.error('could not delete the sent scan', (e as Error)?.name);
          } finally {
            // The new document shows either way.
            void sync.poll();
          }
        },
        onUnauthorized: () => {
          setEmail(null);
          setRoute({ kind: 'inbox' });
        },
        // Status and error code only (the code is the error's message); never the file's name.
        report: (err) =>
          captureRequestFailure(err, {
            operation: 'document-upload',
            path: '/api/documents',
            failure: err.status > 0 ? 'http' : 'network',
            ...(err.status > 0 ? { status: err.status } : {}),
          }),
      }),
  );

  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
    storeOpen.catch((e) => console.error('open store', e));
  }, []);

  useEffect(() => {
    if (!email) return;
    storeOpen
      .then(() => store.findInProgress())
      .then((s) => setResume(s))
      .catch((e) => console.error('find in-progress scan', e));
    sync.start();
    uploads.start();
    // Load the PDF builder now, while online: the service worker caches its
    // chunk (sw.js), so a scan finished offline later can still be built.
    // Otherwise the first scan after a deploy or a fresh install would fetch it
    // only when finished, and offline that fails. A failure here costs nothing.
    void import('../pdf/build.js').catch(() => {});
    return () => {
      uploads.stop();
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
        uploads={uploads}
        scans={store}
        onSettings={() => setRoute({ kind: 'settings' })}
        onSignInAgain={() => void signInAgain()}
      />;
    case 'settings':
      return <SettingsScreen email={email} onBack={() => setRoute({ kind: 'inbox' })} onLoggedOut={signedOut} />;
    case 'scanner':
      return <ScannerScreen
        store={store}
        {...(route.resumeScanId !== undefined ? { resumeScanId: route.resumeScanId } : {})}
        onBack={() => setRoute({ kind: 'inbox' })}
        onDone={(scanId) => {
          setRoute({ kind: 'inbox' });
          // A scan whose PDF can't be built stays on the device and shows under
          // "Scans on this device", with the reason the queue keeps for it.
          sendScanToInbox(store, uploads, scanId).catch((e: unknown) => console.error('could not queue scan', (e as Error)?.name));
        }}
      />;
  }
}
