import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { SavedScansScreen } from '../../src/ui/SavedScansScreen.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import { OcrQueue } from '../../src/ocr/queue.js';
import type { Quad } from '../../src/scanner/types.js';

let store: ScansStore;
let queue: OcrQueue;

beforeEach(async () => {
  cleanup();
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
  queue = new OcrQueue(store, { init: async () => {}, recognize: async () => ({ text: '', words: [] }), terminate: () => {} } as any, async () => new Blob());
});

const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });

describe('SavedScansScreen', () => {
  it('shows empty state when no scans', async () => {
    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no saved scans/i)).toBeInTheDocument());
  });

  it('lists completed scans with page count', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);

    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/2 pages/i)).toBeInTheDocument());
  });

  it('delete removes the scan', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    window.confirm = vi.fn().mockReturnValue(true);

    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 page/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(screen.getByText(/no saved scans/i)).toBeInTheDocument());
  });

  it('shows "OCR queued" for a row with pdfStatus pending', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    await store.setPdfStatus(id, 'pending');

    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/ocr queued/i)).toBeInTheDocument());
  });

  it("shows \"OCR'ing N/M\" when queue emits progress for the row", async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p1'), Q);
    await store.appendPage(id, blob('p2'), Q);
    await store.finish(id);
    await store.setPdfStatus(id, 'running');
    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);

    // Simulate progress emission
    (queue as any).emit('progress', { scanId: id, doneCount: 1, totalCount: 2 });
    await waitFor(() => expect(screen.getByText(/ocr.*1\/2/i)).toBeInTheDocument());
  });

  it('shows Download button when pdfStatus is done', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    await store.setPdfBlob(id, new Blob(['%PDF'], { type: 'application/pdf' }));
    await store.setPdfStatus(id, 'done');
    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument());
  });

  it('shows Retry button on failed; tap calls queue.retry', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    await store.setPdfStatus(id, 'failed', 'boom');
    const retrySpy = vi.spyOn(queue, 'retry').mockResolvedValue();
    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retrySpy).toHaveBeenCalledWith(id);
  });

  it('delete cancels queue then deletes the scan', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    await store.setPdfStatus(id, 'running');
    const cancelSpy = vi.spyOn(queue, 'cancel');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedScansScreen store={store} queue={queue} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 page/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(id));
  });
});
