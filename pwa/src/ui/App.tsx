import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { api, ApiError, type StatusResponse } from '../api.js';
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
  | { kind: 'scanner'; resumeScanId?: string }
  /** LoginScreen over the signed-in app, with Cancel back to the inbox (passkey-unlock spec §3). */
  | { kind: 'proton-login' };

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  // A Proton login in this tab: the passkey nudge follows only that.
  const [justSignedIn, setJustSignedIn] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'inbox' });
  const [store] = useState(() => new ScansStore());
  const [resume, setResume] = useState<Scan | null>(null);
  const [sync] = useState(
    () => new DocumentSync({ list: documentsApi.list, onUnauthorized: () => { setStatus(null); setRoute({ kind: 'inbox' }); } }),
  );
  const [uploads] = useState(
    () =>
      new UploadQueue({
        onUploaded: async ({ scanId }) => {
          try {
            // The server has the scan; its copy on this device can go.
            // store.open(), not a saved first open: a failed open is tried again.
            if (scanId) await store.open().then(() => store.delete(scanId));
          } catch (e) {
            // The queue keeps it off the device list for this session. Never the scan's name.
            console.error('could not delete the sent scan', (e as Error)?.name);
          } finally {
            // The new document shows either way.
            void sync.poll();
          }
        },
        onUnauthorized: () => {
          setStatus(null);
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

  // Signed in with a Proton session stored or live. With none, the login
  // screen shows and nothing polls or uploads, as when signed out.
  const email = status && status.proton !== 'none' ? status.email : null;

  useEffect(() => {
    api.status().then(setStatus)
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
    // Opened once at start and shared; a failed open is tried again by the next caller.
    store.open().catch((e: unknown) => console.error('open store', (e as Error)?.name));
  }, []);

  // A layout effect: Preact 11 runs useEffect cleanups after paint, so at
  // sign-out the queue and the poll would run on for a frame, and at unmount
  // they'd touch window after it is gone (as in a test's teardown).
  useLayoutEffect(() => {
    if (!email) return;
    sync.start();
    uploads.start();
    return () => {
      uploads.stop();
      sync.stop();
      sync.reset();
    };
  }, [email]);

  useEffect(() => {
    if (!email) return;
    store
      .open()
      .then(() => store.findInProgress())
      .then((s) => setResume(s))
      .catch((e: unknown) => console.error('find in-progress scan', (e as Error)?.name));
    // Load the PDF builder now, while online: the service worker caches its
    // chunk (sw.js), so a scan finished offline later can still be built.
    // Otherwise the first scan after a deploy or a fresh install would fetch it
    // only when finished, and offline that fails. A failure here costs nothing.
    void import('../pdf/build.js').catch(() => {});
  }, [email]);

  /** Reads the status again: a 401 signs out; any other failure keeps what is shown. */
  async function refreshStatus(): Promise<void> {
    try {
      setStatus(await api.status());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setStatus(null);
      else console.error('could not refresh the sign-in status', (e as Error)?.name);
    }
  }

  function signedOut() {
    setStatus(null);
    setRoute({ kind: 'inbox' });
  }

  function loggedIn(signedInEmail: string) {
    // Live at once; the refresh brings the passkey count and the mode.
    setStatus((s) => ({ email: signedInEmail, proton: 'live', passkeys: s?.passkeys ?? 0, unlockAvailable: s?.unlockAvailable ?? false }));
    setRoute({ kind: 'inbox' });
    setJustSignedIn(true);
    void refreshStatus();
  }

  async function signInAgain() {
    // Header mode: sign in to Proton over the app. A logout would remove the passkeys too.
    if (status?.unlockAvailable) {
      setRoute({ kind: 'proton-login' });
      return;
    }
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
  if (!status || status.proton === 'none') return <LoginScreen onLoggedIn={loggedIn} />;
  if (route.kind === 'proton-login') return <LoginScreen onLoggedIn={loggedIn} onCancel={() => setRoute({ kind: 'inbox' })} />;

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
        proton={status.proton}
        passkeys={status.passkeys}
        onUnlocked={setStatus}
        onStatusChanged={() => void refreshStatus()}
        onSignInToProton={() => setRoute({ kind: 'proton-login' })}
        showPasskeyNudge={justSignedIn && status.unlockAvailable && status.passkeys === 0}
        onAddPasskey={() => setRoute({ kind: 'settings' })}
      />;
    case 'settings':
      return <SettingsScreen email={status.email} onBack={() => setRoute({ kind: 'inbox' })} onLoggedOut={signedOut} />;
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
