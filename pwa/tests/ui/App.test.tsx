import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { UploadStore } from '../../src/uploads/upload-store.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import { FakeXhr } from '../uploads/fake-xhr.js';
import { toBase64url } from '../../src/auth/passkeys.js';
import { fakeCredential, installCredentials, removeCredentials } from '../auth/fake-webauthn.js';

const { App } = await import('../../src/ui/App.js');
const { makeDoc } = await import('../documents/fixtures.js');

afterEach(() => { vi.unstubAllGlobals(); });

function route(table: Record<string, unknown>) {
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    const hit = table[path];
    if (hit === undefined) return new Response('{"error":"not_found"}', { status: 404 });
    if (hit instanceof Response) return hit;
    return new Response(JSON.stringify(hit), { status: 200 });
  });
}

describe('App', () => {
  it('shows the login screen when signed out', async () => {
    vi.stubGlobal('fetch', route({ '/api/auth/status': new Response('{"error":"not_authenticated"}', { status: 401 }) }));
    render(<App />);
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('finds an unfinished scan even when the first open of the scans database failed', async () => {
    const seed = new ScansStore();
    await seed.open();
    const id = await seed.createInProgress();
    await seed.appendPage(id, new Blob(['page'], { type: 'image/jpeg' }), { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 1, y: 1 } });
    const connect = vi
      .spyOn(ScansStore.prototype as unknown as { connect: () => Promise<void> }, 'connect')
      .mockRejectedValueOnce(new Error('blocked'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal(
        'fetch',
        route({
          '/api/auth/status': { email: 'user@example.test' },
          '/api/documents': { documents: [], cursor: 0 },
          '/api/folders': new Response('{"error":"folders_not_loaded"}', { status: 503 }),
        }),
      );
      render(<App />);
      expect(await screen.findByRole('heading', { name: 'Unfinished scan' })).toBeInTheDocument();
      expect(connect.mock.calls.length).toBeGreaterThan(1);
    } finally {
      connect.mockRestore();
      logged.mockRestore();
    }
  });

  it('opens on the inbox and goes to settings and back', async () => {
    vi.stubGlobal(
      'fetch',
      route({
        '/api/auth/status': { email: 'user@example.test' },
        '/api/documents': { documents: [], cursor: 0 },
        '/api/folders': new Response('{"error":"folders_not_loaded"}', { status: 503 }),
        '/api/settings': { model: 'claude-haiku-5-5', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
      }),
    );
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /saved scans/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await screen.findByRole('checkbox', { name: /file automatically/i });
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
  });

  describe('session flows', () => {
    const SETTINGS = { model: 'claude-haiku-5-5', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] };

    /** A fresh Response on every call (a body reads once); `routes` can be changed mid-test. */
    function server(routes: Record<string, () => Response>) {
      const fetch = vi.fn(async (input: string, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        const handler = routes[`${init?.method ?? 'GET'} ${path}`];
        return handler ? handler() : new Response('{"error":"not_found"}', { status: 404 });
      });
      vi.stubGlobal('fetch', fetch);
      return fetch;
    }
    const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

    it('lands on the login screen when the documents poll finds the session gone', async () => {
      const routes: Record<string, () => Response> = {
        'GET /api/auth/status': json({ email: 'user@example.test' }),
        'GET /api/documents': json({ documents: [], cursor: 0 }),
        'GET /api/folders': json({ error: 'folders_not_loaded' }, 503),
        'GET /api/settings': json(SETTINGS),
      };
      server(routes);
      render(<App />);
      expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
      routes['GET /api/documents'] = json({ error: 'not_authenticated' }, 401);
      // Polls run at once when the page becomes visible again.
      document.dispatchEvent(new Event('visibilitychange'));
      expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
    });

    for (const [label, logout] of [
      ['signs out', json({ ok: true })],
      ['fails to sign out', json({ error: 'internal' }, 500)],
    ] as const) {
      it(`in cookie mode, goes to the login screen from "Sign in again" when it ${label}`, async () => {
        const fetch = server({
          'GET /api/auth/status': json({ email: 'user@example.test', proton: 'live', passkeys: 0, unlockAvailable: false }),
          'GET /api/documents': json({ documents: [makeDoc({ state: 'awaiting_login' })], cursor: 1 }),
          'GET /api/folders': json({ error: 'folders_not_loaded' }, 503),
          'POST /api/auth/logout': logout,
        });
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }));
        expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
      });
    }

    it('never logs out from "Sign in again" while the mode is unknown', async () => {
      const fetch = server({
        // An answer without unlockAvailable: cookie or header mode can't be told.
        'GET /api/auth/status': json({ email: 'user@example.test', proton: 'live', passkeys: 0 }),
        'GET /api/documents': json({ documents: [makeDoc({ state: 'awaiting_login' })], cursor: 1 }),
        'GET /api/folders': json({ error: 'folders_not_loaded' }, 503),
        'POST /api/auth/logout': json({ ok: true }),
      });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }));
      expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(fetch.mock.calls.some(([url]) => url === '/api/auth/logout')).toBe(false);
    });

    it("says it can't reach the server when the first status read fails, and Retry recovers", async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const routes: Record<string, () => Response> = {
          'GET /api/auth/status': () => new Response('<html><body>Bad Gateway</body></html>', { status: 502 }),
          'GET /api/documents': json({ documents: [], cursor: 0 }),
          'GET /api/folders': json({ error: 'folders_not_loaded' }, 503),
        };
        server(routes);
        render(<App />);
        expect(await screen.findByText("Can't reach the server.")).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
        // Still down: Retry stays.
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
        expect(screen.getByText("Can't reach the server.")).toBeInTheDocument();
        routes['GET /api/auth/status'] = json({ email: 'user@example.test', proton: 'live', passkeys: 0, unlockAvailable: false });
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
      } finally {
        logged.mockRestore();
      }
    });

    it("says it can't reach the server when the first status read gets no answer", async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        render(<App />);
        expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
      } finally {
        logged.mockRestore();
      }
    });

    const status = (proton: 'live' | 'locked' | 'none', passkeys: number) => json({ email: 'user@example.test', proton, passkeys, unlockAvailable: true });
    const inbox = {
      'GET /api/documents': json({ documents: [], cursor: 0 }),
      'GET /api/folders': json({ error: 'folders_not_loaded' }, 503),
      'GET /api/settings': json(SETTINGS),
      'GET /api/passkeys': json({ passkeys: [], notice: null }),
    };
    const calledLogout = (fetch: ReturnType<typeof server>) => fetch.mock.calls.some(([url]) => url === '/api/auth/logout');

    it('shows the login screen when no Proton session is stored', async () => {
      server({ 'GET /api/auth/status': status('none', 0), ...inbox });
      render(<App />);
      expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
    });

    it('opens the inbox while locked and unlocks it with a tap', async () => {
      const id = toBase64url(new Uint8Array(16).fill(1));
      const prf = new Uint8Array(32).fill(7);
      const fetch = server({
        'GET /api/auth/status': status('locked', 1),
        ...inbox,
        'POST /api/auth/unlock/begin': json({ credentials: [{ credentialId: id, salt: toBase64url(new Uint8Array(32).fill(3)) }] }),
        'POST /api/auth/unlock': status('live', 1),
      });
      const c = installCredentials();
      c.get.mockResolvedValue(fakeCredential(id, prf));
      const begins = () => fetch.mock.calls.filter(([url]) => url === '/api/auth/unlock/begin').length;
      try {
        render(<App />);
        expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
        const unlockButton = await screen.findByRole('button', { name: 'Unlock' });
        await waitFor(() => expect(unlockButton).toBeEnabled());
        expect(begins()).toBe(1);
        fireEvent.click(unlockButton);
        // The prompt starts within the tap, with the salts fetched before it: no fetch in between.
        expect(c.get).toHaveBeenCalledTimes(1);
        expect(begins()).toBe(1);
        await waitFor(() => expect(screen.queryByText(/filing is paused/i)).toBeNull());
        const sent = fetch.mock.calls.find(([url]) => url === '/api/auth/unlock')!;
        expect(JSON.parse(String(sent[1]!.body))).toEqual({ credentialId: id, prf: toBase64url(prf) });
      } finally {
        removeCredentials();
      }
    });

    it('reads the status again after an unlock refusal that changed it', async () => {
      const id = toBase64url(new Uint8Array(16).fill(1));
      const routes: Record<string, () => Response> = {
        'GET /api/auth/status': status('locked', 1),
        ...inbox,
        'POST /api/auth/unlock/begin': json({ credentials: [{ credentialId: id, salt: toBase64url(new Uint8Array(32).fill(3)) }] }),
        'POST /api/auth/unlock': json({ error: 'passkeys_stale' }, 409),
      };
      const fetch = server(routes);
      installCredentials().get.mockResolvedValue(fakeCredential(id, new Uint8Array(32).fill(7)));
      const statusReads = () => fetch.mock.calls.filter(([url]) => url === '/api/auth/status').length;
      try {
        render(<App />);
        const unlockButton = await screen.findByRole('button', { name: 'Unlock' });
        await waitFor(() => expect(unlockButton).toBeEnabled());
        // The server removed the passkeys while refusing.
        routes['GET /api/auth/status'] = status('locked', 0);
        fireEvent.click(unlockButton);
        expect(
          await screen.findByText('Your Proton password changed. Sign in again, then add your passkey again in Settings.'),
        ).toBeInTheDocument();
        await waitFor(() => expect(statusReads()).toBe(2));
      } finally {
        removeCredentials();
      }
    });

    it('signs in to Proton over the inbox from the locked banner, and Cancel goes back', async () => {
      const fetch = server({ 'GET /api/auth/status': status('locked', 0), ...inbox });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Proton' }));
      expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
      // The Cancel button is gone: focus lands on the inbox's heading.
      expect(screen.getByRole('heading', { name: 'Inbox' })).toHaveFocus();
      expect(calledLogout(fetch)).toBe(false);
    });

    it('in header mode, "Sign in again" never logs out, and suggests a passkey after the login', async () => {
      localStorage.clear();
      const fetch = server({
        'GET /api/auth/status': status('live', 0),
        ...inbox,
        'GET /api/documents': json({ documents: [makeDoc({ state: 'awaiting_login' })], cursor: 1 }),
        'POST /api/auth/login': json({ ok: true, email: 'user@example.test' }),
      });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }));
      fireEvent.input(await screen.findByLabelText('Email'), { target: { value: 'user@example.test' } });
      fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
      fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
      expect(await screen.findByText('Add a passkey so a server restart doesn’t need your Proton password.')).toBeInTheDocument();
      expect(calledLogout(fetch)).toBe(false);
      const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
        expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
        // Straight to the Passkeys section, on its Add passkey button.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Add passkey' })).toHaveFocus());
        expect(scrolled.mock.contexts).toContain(screen.getByRole('heading', { name: 'Passkeys' }));
      } finally {
        scrolled.mockRestore();
      }
    });

    /** Signs in to Proton from the login screen (proton: 'none'); the status then reads `after`. */
    async function signInToProton(routes: Record<string, () => Response>, after: () => Response) {
      render(<App />);
      fireEvent.input(await screen.findByLabelText('Email'), { target: { value: 'user@example.test' } });
      fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
      routes['GET /api/auth/status'] = after;
      fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    }
    const NUDGE = 'Add a passkey so a server restart doesn’t need your Proton password.';

    it('stops suggesting a passkey once one was added, even after it is removed again', async () => {
      localStorage.clear();
      const id = toBase64url(new Uint8Array(16).fill(1));
      const routes: Record<string, () => Response> = {
        'GET /api/auth/status': status('none', 0),
        ...inbox,
        'POST /api/auth/login': json({ ok: true, email: 'user@example.test' }),
        'POST /api/passkeys/begin': json({ salt: toBase64url(new Uint8Array(32).fill(3)), userHandle: toBase64url(new Uint8Array(16).fill(9)), excludeCredentials: [] }),
        'POST /api/passkeys': json({ credentialId: id, label: 'Passkey', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null }, 201),
        [`DELETE /api/passkeys/${id}`]: json({}),
      };
      const fetch = server(routes);
      const statusReads = () => fetch.mock.calls.filter(([url]) => url === '/api/auth/status').length;
      installCredentials().create.mockResolvedValue(fakeCredential(id, new Uint8Array(32).fill(7)));
      try {
        await signInToProton(routes, status('live', 0));
        fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
        expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
        const cont = screen.getByRole('button', { name: 'Continue' });
        await waitFor(() => expect(cont).toBeEnabled());
        routes['GET /api/auth/status'] = status('live', 1);
        fireEvent.click(cont);
        expect(await screen.findByText('Passkey added.')).toBeInTheDocument();
        await waitFor(() => expect(statusReads()).toBe(3));
        routes['GET /api/auth/status'] = status('live', 0);
        fireEvent.click(screen.getByRole('button', { name: 'Remove Passkey' }));
        await waitFor(() => expect(statusReads()).toBe(4));
        fireEvent.click(screen.getByRole('button', { name: /back/i }));
        expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
        expect(screen.queryByText(NUDGE)).toBeNull();
      } finally {
        removeCredentials();
      }
    });

    it('stops suggesting a passkey once dismissed, even where the dismissal could not be stored', async () => {
      localStorage.clear();
      const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('refused', 'SecurityError');
      });
      try {
        const routes: Record<string, () => Response> = {
          'GET /api/auth/status': status('none', 0),
          ...inbox,
          'POST /api/auth/login': json({ ok: true, email: 'user@example.test' }),
        };
        server(routes);
        await signInToProton(routes, status('live', 0));
        expect(await screen.findByText(NUDGE)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        fireEvent.click(await screen.findByRole('button', { name: /back/i }));
        expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
        expect(screen.queryByText(NUDGE)).toBeNull();
      } finally {
        refused.mockRestore();
      }
    });
  });

  describe('uploads', () => {
    class FakeFormData {
      private readonly fields = new Map<string, unknown>();
      append(key: string, value: unknown) { this.fields.set(key, value); }
      get(key: string) { return this.fields.get(key) ?? null; }
    }

    /** Signs in with one file left in the queue from an earlier session, and returns its upload request. */
    async function signedInWithQueuedFile(scanId: string | null = null) {
      FakeXhr.last = null;
      vi.stubGlobal('XMLHttpRequest', FakeXhr);
      vi.stubGlobal('FormData', FakeFormData);
      await new UploadStore().put({
        id: 'old', name: 'northwind-bill.pdf', size: 1, blob: new Blob(['x']), source: scanId ? 'scanner' : 'picker', scanId,
        createdAt: 1, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0,
      });
      vi.stubGlobal(
        'fetch',
        route({
          '/api/auth/status': { email: 'user@example.test' },
          '/api/documents': { documents: [], cursor: 0 },
          '/api/folders': new Response('{"error":"folders_not_loaded"}', { status: 503 }),
        }),
      );
      render(<App />);
      expect(await screen.findByRole('region', { name: 'Uploading' })).toBeInTheDocument();
      await waitFor(() => expect(FakeXhr.last?.body).not.toBeNull());
      return FakeXhr.last!;
    }

    it('sends files left in the queue once signed in', async () => {
      const req = await signedInWithQueuedFile();
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/documents');
      req.respond(202, '{"id":"d1"}');
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
    });

    it('refreshes the inbox even when deleting the sent scan fails, logging only the error name', async () => {
      const del = vi.spyOn(ScansStore.prototype, 'delete').mockRejectedValue(new Error('northwind storage'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const req = await signedInWithQueuedFile('scan-1');
        // The first poll has finished, so a later poll() starts a request of its own.
        expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
        const polls = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).split('?')[0] === '/api/documents').length;
        const before = polls();
        req.respond(202, '{"id":"d1"}');
        await waitFor(() => expect(del).toHaveBeenCalledWith('scan-1'));
        await waitFor(() => expect(polls()).toBeGreaterThan(before));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
        expect(logged).toHaveBeenCalledWith('could not delete the sent scan', 'Error');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('northwind');
      } finally {
        del.mockRestore();
        logged.mockRestore();
      }
    });

    it('sends the same queued file again once signed in after a 401', async () => {
      const first = await signedInWithQueuedFile();
      first.respond(401, '{"error":"not_authenticated"}');
      expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
      vi.stubGlobal(
        'fetch',
        route({
          '/api/auth/login': { email: 'user@example.test' },
          '/api/documents': { documents: [], cursor: 0 },
          '/api/folders': new Response('{"error":"folders_not_loaded"}', { status: 503 }),
        }),
      );
      fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'user@example.test' } });
      fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
      fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
      await waitFor(() => expect(FakeXhr.last).not.toBe(first));
      const again = FakeXhr.last!;
      await waitFor(() => expect(again.body).not.toBeNull());
      expect(again.body!.get('originalName')).toBe('northwind-bill.pdf');
      again.respond(202, '{"id":"d1"}');
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
    });

    it('stops the upload queue as the app unmounts, not after paint', async () => {
      await signedInWithQueuedFile();
      const removed = vi.spyOn(window, 'removeEventListener');
      try {
        cleanup();
        expect(removed).toHaveBeenCalledWith('online', expect.any(Function));
        expect(removed).toHaveBeenCalledWith('offline', expect.any(Function));
      } finally {
        removed.mockRestore();
      }
    });

    it('lands on the login screen when an upload finds the session gone', async () => {
      const req = await signedInWithQueuedFile();
      req.respond(401, '{"error":"not_authenticated"}');
      expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
  });
});
