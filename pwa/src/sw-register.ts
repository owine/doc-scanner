// Service Worker registration + Phase 5 slice 4 outbox-drain triggers.
//
// Registration is idempotent (same script URL → browser dedupes). After
// register we:
//   - Ask the SW to register an 'outbox-drain' background sync. Browsers
//     without SyncManager (notably iOS Safari) silently no-op.
//   - Listen for `visibilitychange → visible` and post {request-drain} to
//     the SW so it fans out the drain. This is the iOS fallback for the
//     missing Background Sync.
//   - Listen for {type:'outbox-drain'} messages from the SW and call the
//     drain() function on the page. The actual drain logic lives in TS
//     so we get types + tests; the SW is just the broadcast medium.

type DrainCallback = () => Promise<void>;

interface SyncManagerLike { register(tag: string): Promise<void>; }
interface RegistrationWithSync extends ServiceWorkerRegistration {
  sync?: SyncManagerLike;
}

export function registerSW(onDrainRequested: DrainCallback): void {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('/sw.js')
    .then((reg) => registerOutboxSync(reg as RegistrationWithSync))
    .catch((e) => console.warn('SW register failed', e));

  // Drain on tab focus regardless of SW state — covers iOS Safari and
  // catches anything the SW broadcast missed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void onDrainRequested();
    navigator.serviceWorker.controller?.postMessage({ type: 'request-drain' });
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'outbox-drain') void onDrainRequested();
  });
}

async function registerOutboxSync(reg: RegistrationWithSync): Promise<void> {
  if (!reg.sync) return; // SyncManager unavailable (iOS Safari) — visibility fallback handles it
  try {
    await reg.sync.register('outbox-drain');
  } catch {
    // Some browsers throw if not allowed (private browsing, etc.); ignore.
  }
}
