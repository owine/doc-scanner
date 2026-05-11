import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, PreflightError } from '../api.js';
import { LoginScreen } from './LoginScreen.js';
import { StatusScreen } from './StatusScreen.js';
import { ScannerScreen } from './ScannerScreen.js';
import { SavedScansScreen } from './SavedScansScreen.js';
import { ScanViewerScreen } from './ScanViewerScreen.js';
import { ResumePrompt } from './ResumePrompt.js';
import { ConfirmCard } from './ConfirmCard.js';
import { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';

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
  const [resume, setResume] = useState<Scan | null>(null);

  // Phase 5 upload-pipeline state. The currently-acting-on scan id and a
  // tick counter to force re-reads after setUploadStatus mutations.
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [folders, setFolders] = useState<{ linkId: string; path: string }[]>([]);
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    api.status().then((s) => setEmail(s.email))
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) console.error(e); })
      .finally(() => setLoaded(true));
    store.open().catch((e) => console.error('open store', e));
  }, []);

  useEffect(() => {
    if (!email) return;
    store.findInProgress().then((s) => setResume(s));
  }, [email]);

  // Watch for pending_classify scans and run the AI suggestion call. This
  // currently only fires for the ScannerScreen flow's just-finished scan
  // (set via setActiveScanId in onDone). Slice 4 will add a SW-driven
  // outbox drain that processes any pending row regardless of UI state.
  useEffect(() => {
    if (!activeScanId) return;
    let cancelled = false;
    (async () => {
      const scan = await store.getScan(activeScanId);
      if (!scan || cancelled) return;
      setActiveScan(scan);
      if (scan.uploadStatus !== 'pending_classify') return;

      try {
        const pages = await store.getPageBlobs(activeScanId);
        const { folders: list } = await api.getFolders().catch(() => ({ folders: [] }));
        if (cancelled) return;
        setFolders(list);
        const { suggestion } = await api.classify(pages);
        if (cancelled) return;
        if (suggestion) {
          await store.setSuggestionAndOcr(activeScanId, suggestion, suggestion.pageOcr);
        } else {
          await store.setSuggestionAndOcr(activeScanId, undefined, undefined);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('classify pipeline failed', err);
        // Even on PreflightError / network blowup, advance to awaiting_confirm
        // so the user can fill the form manually rather than being stuck.
        await store.setSuggestionAndOcr(activeScanId, undefined, undefined).catch(() => {});
        if (err instanceof PreflightError) console.warn('pre-flight rejected', err.message);
      }
      if (!cancelled) refresh();
    })();
    return () => { cancelled = true; };
  }, [activeScanId]);

  // Re-read activeScan after any setUploadStatus mutation (refresh tick).
  useEffect(() => {
    if (!activeScanId) return;
    store.getScan(activeScanId).then((s) => setActiveScan(s));
  }, [activeScanId, /* refresh ticks */]);

  if (!loaded) return <main class="auth-screen">Loading…</main>;
  if (!email) return <LoginScreen onLoggedIn={setEmail} />;

  // Confirmation surface takes priority over the route stack: when a scan
  // reaches awaiting_confirm we render ConfirmCard regardless of where the
  // user navigated. Dismiss returns control to whatever route was active.
  if (activeScan && activeScan.uploadStatus === 'awaiting_confirm') {
    return (
      <ConfirmCard
        scanId={activeScan.id}
        suggestion={activeScan.suggestion ?? null}
        folders={folders}
        onSave={async (name, folderLinkId) => {
          // Slice 1 stub: no real upload yet (slice 2 wires this).
          // Reset to idle so the card dismisses and the scan stays saved.
          await store.setUploadStatus(activeScan.id, 'pending_upload', { finalName: name, finalFolderLinkId: folderLinkId });
          // Slice 2 will replace the next two lines with a real /api/upload call.
          console.info('would upload to Drive', { scanId: activeScan.id, name, folderLinkId });
          await store.setUploadStatus(activeScan.id, 'done');
          setActiveScanId(null);
          setActiveScan(null);
          setRoute({ kind: 'saved' });
        }}
        onDismiss={async () => {
          await store.setUploadStatus(activeScan.id, 'idle').catch(() => {});
          setActiveScanId(null);
          setActiveScan(null);
        }}
        onRefreshFolders={async () => {
          const { folders: list } = await api.getFolders(true).catch(() => ({ folders: [] }));
          setFolders(list);
        }}
      />
    );
  }

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
        {...(route.resumeScanId !== undefined ? { resumeScanId: route.resumeScanId } : {})}
        onBack={() => setRoute({ kind: 'status' })}
        onDone={(scanId) => {
          setActiveScanId(scanId);
          setRoute({ kind: 'saved' });
        }}
      />;
    case 'saved':
      return <SavedScansScreen
        store={store}
        onBack={() => setRoute({ kind: 'status' })}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onView={(scanId) => setRoute({ kind: 'viewer', scanId })}
      />;
    case 'viewer':
      return <ScanViewerScreen
        store={store}
        scanId={route.scanId}
        onBack={() => setRoute({ kind: 'saved' })}
      />;
  }
}
