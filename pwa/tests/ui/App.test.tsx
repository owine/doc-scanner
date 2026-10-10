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
});
