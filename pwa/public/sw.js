// doc-scanner Service Worker.
// - Caches the scanner chunk + opencv + pdf-core so re-opens work offline.
// - Phase 5 slice 4: handles 'outbox-drain' sync events by posting a
//   message to every open client. The drain logic itself runs on the page
//   (TypeScript, in pwa/src/outbox-drain.ts) — this avoids duplicating the
//   drain implementation in plain JS inside the SW. iOS Safari's
//   visibilitychange handler in sw-register.ts is the practical fallback
//   when Background Sync isn't supported or no clients are open at sync
//   time.

const CACHE_NAME = 'docscanner-scanner-v8';
const RUNTIME_CACHE_PATTERNS = [
  /\/assets\/scanner-core-.*\.js$/,
  /\/assets\/pdf-core-.*\.js$/,
  /\/scanner\//,
  /\/opencv\//,
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (!RUNTIME_CACHE_PATTERNS.some((re) => re.test(url.pathname))) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (err) {
      return cached ?? Response.error();
    }
  })());
});

async function notifyClientsToDrain() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: 'outbox-drain' });
}

self.addEventListener('sync', (event) => {
  if (event.tag !== 'outbox-drain') return;
  event.waitUntil(notifyClientsToDrain());
});

// Manual trigger: pages can post {type:'request-drain'} to ask the SW to
// fan out the drain message (also lets the visibility fallback piggyback
// on the same plumbing).
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'request-drain') return;
  event.waitUntil(notifyClientsToDrain());
});
