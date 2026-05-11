import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { SavedScansScreen } from '../../src/ui/SavedScansScreen.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

const Q: Quad = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, bl: { x: 0, y: 100 }, br: { x: 100, y: 100 } };
function blobOf(text: string): Blob { return new Blob([text], { type: 'image/jpeg' }); }

let store: ScansStore;
beforeEach(async () => {
  cleanup();
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

async function mkScan(): Promise<string> {
  const id = await store.createInProgress();
  await store.appendPage(id, blobOf('p1'), Q);
  await store.finish(id);
  return id;
}

describe('SavedScansScreen outbox banner', () => {
  it('does not render the banner when no scans are pending or needs_attention', async () => {
    await mkScan();
    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 page/)).toBeInTheDocument());
    expect(screen.queryByLabelText('outbox status')).not.toBeInTheDocument();
  });

  it('shows pending + needs-attention counts; Retry all only when needs_attention > 0', async () => {
    const a = await mkScan();
    const b = await mkScan();
    const c = await mkScan();
    await store.setUploadStatus(a, 'pending_classify');
    await store.setUploadStatus(b, 'pending_classify');
    await store.setUploadStatus(b, 'awaiting_confirm');
    await store.setUploadStatus(b, 'pending_upload', { finalName: 'B', finalFolderLinkId: 'f' });
    await store.setUploadStatus(b, 'needs_attention', { uploadError: 'oops' });
    // c stays idle (just finished, no upload yet)
    void c;

    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('outbox status')).toBeInTheDocument());
    const banner = screen.getByLabelText('outbox status');
    // 1 pending_classify (a) + 1 needs_attention (b)
    expect(banner.textContent).toMatch(/1 processing/);
    expect(banner.textContent).toMatch(/1 need attention/);
    expect(screen.getByRole('button', { name: /Retry all/i })).toBeInTheDocument();
  });

  it('Retry all transitions needs_attention scans → pending_upload and calls onRetryAll', async () => {
    const a = await mkScan();
    await store.setUploadStatus(a, 'pending_classify');
    await store.setUploadStatus(a, 'awaiting_confirm');
    await store.setUploadStatus(a, 'pending_upload', { finalName: 'A', finalFolderLinkId: 'f' });
    await store.setUploadStatus(a, 'needs_attention', { uploadError: 'oops' });

    const onRetryAll = vi.fn().mockResolvedValue(undefined);
    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} onRetryAll={onRetryAll} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry all/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Retry all/i }));
    await waitFor(() => expect(onRetryAll).toHaveBeenCalledOnce());
    const scan = await store.getScan(a);
    expect(scan?.uploadStatus).toBe('pending_upload');
    expect(scan?.retryCount).toBe(0);
    expect(scan?.uploadError).toBeNull();
  });
});
