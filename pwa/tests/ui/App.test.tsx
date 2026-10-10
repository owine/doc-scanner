import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

// The OCR worker can't start in happy-dom; the inbox doesn't need it.
vi.mock('../../src/ocr/worker-client.js', () => ({
  WorkerClient: class {
    init = async () => {};
    recognize = async () => ({ text: '', words: [] });
    terminate = () => {};
  },
}));

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
      it(`goes to the login screen from "Sign in again" when it ${label}`, async () => {
        const fetch = server({
          'GET /api/auth/status': json({ email: 'user@example.test' }),
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
  });
});
