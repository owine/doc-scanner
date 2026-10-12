// doc-scanner Service Worker.
// Caches the scanner chunk and the PDF builder chunk (both split out by Vite as
// dynamic-import chunks) and the jscanify wasm, so subsequent opens work fully
// offline and a scan finished offline can still be built into a PDF. App
// loads the PDF builder after sign-in so it is cached before it's needed.

const CACHE_NAME = 'docscanner-scanner-v5';
const RUNTIME_CACHE_PATTERNS = [
  /\/assets\/scanner-core-.*\.js$/,
  /\/assets\/pdf-.*\.js$/,
  /\/scanner\//,
  /\/opencv\//,
];

// Chunks named by their content hash: each deploy brings a new name, and the
// old one is never asked for again. Caching one deletes the older copies, so
// they don't pile up. Matched exactly (an 8-character hash), so a chunk that
// merely starts with the same name can't be taken for an older copy. The
// /scanner/ and /opencv/ files keep their names, and are left alone.
const HASHED_CHUNKS = [
  /^\/assets\/scanner-core-[\w-]{8}\.js$/,
  /^\/assets\/pdf-[\w-]{8}\.js$/,
];

async function pruneOlderCopies(cache, keptPath) {
  const chunk = HASHED_CHUNKS.find((re) => re.test(keptPath));
  if (!chunk) return;
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path !== keptPath && chunk.test(path)) await cache.delete(request);
  }
}

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
      if (response.ok) {
        event.waitUntil(cache.put(event.request, response.clone()).then(() => pruneOlderCopies(cache, url.pathname)));
      }
      return response;
    } catch (err) {
      return cached ?? Response.error();
    }
  })());
});
