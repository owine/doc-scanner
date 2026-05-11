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
  const [resume, setResume] = useState<Scan | null>(null);

  // Phase 5 upload-pipeline state. The currently-acting-on scan id and a
  // tick counter to force re-reads after setUploadStatus mutations.
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [folders, setFolders] = useState<{ linkId: string; path: string }[]>([]);
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  // Slice 2: post-upload success banner. Cleared on dismiss or after the
  // user navigates somewhere new.
  const [savedNotice, setSavedNotice] = useState<{ name: string; url: string } | null>(null);

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
          // Slice 2: assemble searchable PDF from page blobs + Haiku OCR,
          // upload to Drive, and transition to 'done' with the resolved
          // metadata. The PWA pre-flights size; server enforces 50 MB.
          await store.setUploadStatus(activeScan.id, 'pending_upload', {
            finalName: name, finalFolderLinkId: folderLinkId,
          });
          try {
            const pages = await store.getPageBlobs(activeScan.id);
            const ocr = activeScan.pageOcr ?? [];
            const pdfBlob = await buildSearchablePdf(
              pages.map((blob, i) => ({
                blob,
                ocrText: ocr[i]?.text ?? '',
                ocrWords: ocr[i]?.words ?? [],
              })),
            );
            await store.setPdfBlob(activeScan.id, pdfBlob);
            const ocrText = ocr.map((p) => p.text).filter((t) => t.length > 0).join('\n\n');
            const result = await api.upload(pdfBlob, name, folderLinkId, ocrText);
            await store.setUploadStatus(activeScan.id, 'done', {
              driveNodeUid: result.driveNodeUid,
              driveWebUrl: result.driveWebUrl,
              finalName: result.finalName,
            });
            setSavedNotice({ name: result.finalName, url: result.driveWebUrl });
            setActiveScanId(null);
            setActiveScan(null);
            setRoute({ kind: 'saved' });
          } catch (err) {
            console.error('upload failed', err);
            // Leave scan in pending_upload so a future drain (slice 4) can
            // retry. Surface a minimal alert for now; slice 4 swaps in the
            // outbox panel + retry-all UI.
            if (err instanceof ApiError && err.code === 'reauth_required') {
              window.alert('Session expired. Please log in again.');
              setEmail(null);
            } else if (err instanceof ApiError && err.code === 'collision_exhausted') {
              window.alert('A file with that name (and 3 suffix variants) already exists in that folder. Please rename and retry.');
              await store.setUploadStatus(activeScan.id, 'idle').catch(() => {});
              setActiveScanId(null);
              setActiveScan(null);
            } else {
              window.alert(`Upload failed: ${(err as Error).message ?? 'unknown'}`);
            }
            refresh();
          }
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

  // Slice 2: post-save success banner over the active route. Auto-clears
  // on next route change or when the user taps Dismiss.
  const banner = savedNotice && (
    <div
      role="status"
      style={{
        position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 100,
        background: '#d4edda', color: '#155724', border: '1px solid #c3e6cb',
        borderRadius: 6, padding: 12, display: 'flex', gap: 12, alignItems: 'center',
      }}
    >
      <strong style={{ flex: 1 }}>Saved to Drive: {savedNotice.name}</strong>
      <a href={savedNotice.url} target="_blank" rel="noopener noreferrer" class="btn">Open</a>
      <button class="btn btn-secondary" onClick={() => setSavedNotice(null)}>Dismiss</button>
    </div>
  );

  switch (route.kind) {
    case 'status':
      return <><StatusScreen
        email={email}
        onLoggedOut={() => setEmail(null)}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onViewSavedScans={() => setRoute({ kind: 'saved' })}
      />{banner}</>;
    case 'scanner':
      return <><ScannerScreen
        store={store}
        {...(route.resumeScanId !== undefined ? { resumeScanId: route.resumeScanId } : {})}
        onBack={() => setRoute({ kind: 'status' })}
        onDone={(scanId) => {
          setActiveScanId(scanId);
          setRoute({ kind: 'saved' });
        }}
      />{banner}</>;
    case 'saved':
      return <><SavedScansScreen
        store={store}
        onBack={() => setRoute({ kind: 'status' })}
        onNewScan={() => setRoute({ kind: 'scanner' })}
        onView={(scanId) => setRoute({ kind: 'viewer', scanId })}
      />{banner}</>;
    case 'viewer':
      return <><ScanViewerScreen
        store={store}
        scanId={route.scanId}
        onBack={() => setRoute({ kind: 'saved' })}
      />{banner}</>;
  }
}
