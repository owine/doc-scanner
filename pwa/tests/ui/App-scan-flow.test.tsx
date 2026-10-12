import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { ScansStore } from '../../src/scanner/scans-store.js';
import { buildImagePdf } from '../../src/pdf/build.js';
import { FakeXhr } from '../uploads/fake-xhr.js';

// The camera can't run here: a stand-in scanner whose Done finishes the scan the test made.
const scanner = vi.hoisted(() => ({ scanId: '' }));
vi.mock('../../src/ui/ScannerScreen.js', async () => {
  const { h } = await import('preact');
  return {
    ScannerScreen: ({ onDone }: { onDone: (scanId: string) => void }) =>
      h('button', { type: 'button', onClick: () => onDone(scanner.scanId) }, 'Done'),
  };
});
vi.mock('../../src/pdf/build.js', () => ({ buildImagePdf: vi.fn() }));

const { App } = await import('../../src/ui/App.js');

class FakeFormData {
  private readonly fields = new Map<string, unknown>();
  append(key: string, value: unknown) { this.fields.set(key, value); }
  get(key: string) { return this.fields.get(key) ?? null; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(buildImagePdf).mockReset();
});

const QUAD = { tl: { x: 0, y: 0 }, tr: { x: 2, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 2, y: 1 } };

/** Signs in, opens the scanner, and finishes a one-page scan there. */
async function finishScan(): Promise<string> {
  FakeXhr.last = null;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('FormData', FakeFormData);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/api/auth/status') return new Response(JSON.stringify({ email: 'user@example.test' }), { status: 200 });
    if (path === '/api/documents') return new Response(JSON.stringify({ documents: [], cursor: 0 }), { status: 200 });
    return new Response('{"error":"folders_not_loaded"}', { status: 503 });
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Scan' }));
  // What the scanner leaves behind on Done: a finished scan on the device.
  const store = new ScansStore();
  await store.open();
  const id = await store.createInProgress();
  await store.appendPage(id, new Blob(['jpeg'], { type: 'image/jpeg' }), QUAD);
  await store.finish(id);
  scanner.scanId = id;
  fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
  return id;
}

describe('App, finishing a scan', () => {
  it('shows why a just-finished scan could not be sent, on its row', async () => {
    vi.mocked(buildImagePdf).mockRejectedValue(new Error('northwind chunk offline'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await finishScan();
      const region = await screen.findByRole('region', { name: 'Scans on this device' });
      expect(await within(region).findByText('Could not send this scan. Try again.')).toBeInTheDocument();
      expect(within(region).getByText('Scans not sent yet. Send them or delete them.')).toBeInTheDocument();
      expect(JSON.stringify(logged.mock.calls)).not.toContain('northwind');
    } finally {
      logged.mockRestore();
    }
  });

  it('sends a finished scan, and deletes it from the device once the server has it', async () => {
    vi.mocked(buildImagePdf).mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    const id = await finishScan();
    expect(await screen.findByRole('region', { name: 'Uploading' })).toBeInTheDocument();
    await waitFor(() => expect(FakeXhr.last?.body).not.toBeNull());
    const req = FakeXhr.last!;
    expect(req.body!.get('source')).toBe('scanner');
    req.respond(202, '{"id":"d1"}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
    const store = new ScansStore();
    await store.open();
    await waitFor(async () => expect((await store.listCompleted()).map((s) => s.id)).not.toContain(id));
    expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull();
  });
});
