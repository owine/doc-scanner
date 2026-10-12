/**
 * The service worker's hashed chunks (sw.js HASHED_CHUNKS; keep the two in
 * step): the scanner core and the PDF builder, named by their content hash.
 */
const HASHED_CHUNK = /^\/assets\/(?:scanner-core|pdf)-[\w-]{8}\.js$/;

export interface WarmDeps {
  /** navigator.serviceWorker, or as much of it as this uses. */
  serviceWorker?: { readonly controller: unknown; addEventListener(type: 'controllerchange', listener: () => void): void } | undefined;
  /** The resources the page has loaded (performance.getEntriesByType('resource')). */
  entries?: () => readonly { name: string }[];
  fetch?: (url: string) => Promise<unknown>;
  origin?: string;
}

/**
 * On a device's first visit the page loads before the service worker controls
 * it, so chunks loaded then (the PDF builder App imports after sign-in, say)
 * never pass through it and aren't cached: a scan finished offline in that
 * first session couldn't be built. When the worker first takes control, fetch
 * those chunks again so it caches them. Fire and forget; any failure is
 * ignored. Nothing to do when the page was controlled from the start.
 */
export function warmServiceWorkerCache(deps: WarmDeps = {}): void {
  const sw = 'serviceWorker' in deps ? deps.serviceWorker : 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
  if (!sw || sw.controller) return;
  const entries = deps.entries ?? (() => performance.getEntriesByType('resource'));
  const fetchChunk = deps.fetch ?? ((url: string) => fetch(url));
  const origin = deps.origin ?? location.origin;
  let warmed = false;
  sw.addEventListener('controllerchange', () => {
    // Only the first takeover: a later one is an update, and that page was controlled.
    if (warmed) return;
    warmed = true;
    let urls: string[];
    try {
      urls = [
        ...new Set(
          entries()
            .map((e) => new URL(e.name, origin))
            .filter((u) => u.origin === origin && HASHED_CHUNK.test(u.pathname))
            .map((u) => u.href),
        ),
      ];
    } catch {
      return;
    }
    for (const url of urls) {
      Promise.resolve()
        .then(() => fetchChunk(url))
        .catch(() => {});
    }
  });
}
