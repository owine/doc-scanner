// doc-scanner Service Worker.
// Caches the scanner chunk (split out by Vite as a dynamic-import chunk) and
// the jscanify wasm so subsequent opens work fully offline.

const CACHE_NAME = 'docscanner-scanner-v1';
const RUNTIME_CACHE_PATTERNS = [
  /\/assets\/scanner-jscanify-.*\.js$/,
  /\/assets\/scanner-core-.*\.js$/,
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
