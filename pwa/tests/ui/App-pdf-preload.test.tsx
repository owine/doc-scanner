import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

// The factory runs when the module is first imported, so it tells when App
// loads the PDF builder. In a file of its own: the module cache would make the
// observation depend on test order anywhere else.
const builder = vi.hoisted(() => ({ loads: 0 }));
vi.mock('../../src/pdf/build.js', () => {
  builder.loads += 1;
  return { buildImagePdf: vi.fn() };
});

const { App } = await import('../../src/ui/App.js');

afterEach(() => { vi.unstubAllGlobals(); });

describe('App', () => {
  it('loads the PDF builder once signed in, so a scan finished offline can still be built', async () => {
    let signIn!: () => void;
    const status = new Promise<Response>((resolve) => {
      signIn = () => resolve(new Response(JSON.stringify({ email: 'user@example.test' }), { status: 200 }));
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = String(input).split('?')[0]!;
      if (path === '/api/auth/status') return status;
      if (path === '/api/documents') return new Response(JSON.stringify({ documents: [], cursor: 0 }), { status: 200 });
      return new Response('{"error":"folders_not_loaded"}', { status: 503 });
    }));
    render(<App />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(builder.loads).toBe(0);
    signIn();
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    await waitFor(() => expect(builder.loads).toBe(1));
  });
});
