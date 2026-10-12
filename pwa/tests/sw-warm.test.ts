import { describe, it, expect, vi } from 'vitest';
import { warmServiceWorkerCache } from '../src/sw-warm.js';

const ORIGIN = 'https://scanner.example.test';

/** A service worker container whose controllerchange the test fires itself. */
function fakeServiceWorker(controller: object | null) {
  const listeners: (() => void)[] = [];
  return {
    controller,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (type === 'controllerchange') listeners.push(fn);
    }),
    takeOver() {
      for (const fn of listeners) fn();
    },
  };
}

const entries = () => [
  { name: `${ORIGIN}/assets/index-RLoDkrPo.js` },
  { name: `${ORIGIN}/assets/scanner-core-DErY7ePu.js` },
  { name: `${ORIGIN}/assets/pdf-CLO6JsLx.js` },
  { name: `${ORIGIN}/assets/pdf-worker-ABCDEFGH.js` },
  { name: `${ORIGIN}/scanner/jscanify.js` },
  { name: `${ORIGIN}/api/documents` },
  { name: 'https://cdn.example.test/assets/pdf-CLO6JsLx.js' },
];

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('warmServiceWorkerCache', () => {
  it('fetches the hashed chunks already loaded, once, when the service worker first takes control', async () => {
    const sw = fakeServiceWorker(null);
    const fetch = vi.fn().mockResolvedValue(new Response(''));
    warmServiceWorkerCache({ serviceWorker: sw, entries, fetch, origin: ORIGIN });
    expect(fetch).not.toHaveBeenCalled();
    sw.takeOver();
    sw.takeOver(); // a later controller (an update) changes nothing
    await flush();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/assets/scanner-core-DErY7ePu.js`,
      `${ORIGIN}/assets/pdf-CLO6JsLx.js`,
    ]);
  });

  it('does nothing when the page was already controlled', async () => {
    const sw = fakeServiceWorker({});
    const fetch = vi.fn();
    warmServiceWorkerCache({ serviceWorker: sw, entries, fetch, origin: ORIGIN });
    sw.takeOver();
    await flush();
    expect(sw.addEventListener).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing without service worker support', async () => {
    const fetch = vi.fn();
    expect(() => warmServiceWorkerCache({ serviceWorker: undefined, entries, fetch, origin: ORIGIN })).not.toThrow();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shrugs off a failed fetch and still tries the rest', async () => {
    const sw = fakeServiceWorker(null);
    const fetch = vi.fn()
      .mockImplementationOnce(() => { throw new TypeError('offline'); })
      .mockRejectedValueOnce(new TypeError('offline'));
    warmServiceWorkerCache({ serviceWorker: sw, entries, fetch, origin: ORIGIN });
    expect(() => sw.takeOver()).not.toThrow();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shrugs off a browser without resource timing', async () => {
    const sw = fakeServiceWorker(null);
    const fetch = vi.fn();
    warmServiceWorkerCache({ serviceWorker: sw, entries: () => { throw new TypeError('unsupported'); }, fetch, origin: ORIGIN });
    expect(() => sw.takeOver()).not.toThrow();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});
