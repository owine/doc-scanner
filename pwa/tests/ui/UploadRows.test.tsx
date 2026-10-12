import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { DeviceScanRow, UploadRow } from '../../src/ui/inbox/UploadRows.js';
import { UploadQueue, MAX_UPLOAD_BYTES } from '../../src/uploads/queue.js';
import type { UploadItem } from '../../src/uploads/types.js';
import type { Scan } from '../../src/scanner/types.js';

const item = (over: Partial<UploadItem> = {}): UploadItem => ({
  id: 'u1', name: 'northwind-bill.pdf', size: 3, blob: new Blob(['abc']), source: 'picker', scanId: null,
  createdAt: 1, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0, ...over,
});
/** Never started, so it sends nothing; the rows only read it. */
const idle = () => new UploadQueue({ send: () => new Promise(() => {}) });
const scan: Scan = { id: 's1', status: 'completed', pageCount: 2, createdAt: 1, updatedAt: 1, thumbnailKey: null };

describe('UploadRow', () => {
  it('says a file is waiting, or retrying after a failure', async () => {
    const queue = idle();
    const { rerender } = render(<ul><UploadRow item={item()} queue={queue} /></ul>);
    expect(screen.getByText('Waiting to upload')).toBeInTheDocument();
    rerender(<ul><UploadRow item={item({ attempts: 1 })} queue={queue} /></ul>);
    await waitFor(() => expect(screen.getByText('Retrying soon')).toBeInTheDocument());
  });

  it('shows a refusal with Retry and Remove, each described by the file name', async () => {
    const queue = idle();
    const retry = vi.spyOn(queue, 'retry').mockResolvedValue();
    const remove = vi.spyOn(queue, 'remove').mockResolvedValue(true);
    render(<ul><UploadRow item={item({ state: 'failed', error: 'The file is empty.' })} queue={queue} /></ul>);
    expect(screen.getByText('The file is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAccessibleDescription('northwind-bill.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('u1'));
    expect(retry).toHaveBeenCalledWith('u1');
  });

  it('offers no Retry for a file over the limit', async () => {
    render(<ul><UploadRow item={item({ state: 'failed', error: 'Too large to upload (the limit is 50 MB).', size: MAX_UPLOAD_BYTES + 1 })} queue={idle()} /></ul>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument());
  });
});

describe('DeviceScanRow', () => {
  it('says when sending failed, and can be tried again', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('no pages'));
    render(<ul><DeviceScanRow scan={scan} onSend={onSend} onDelete={vi.fn()} /></ul>);
    expect(screen.getByText('Scan · 2 pages')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send to inbox' }));
    expect(await screen.findByText('Could not send this scan. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to inbox' })).toBeEnabled();
  });

  it('asks before deleting', async () => {
    const nativeConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValue(false);
    try {
      const onDelete = vi.fn();
      render(<ul><DeviceScanRow scan={scan} onSend={vi.fn()} onDelete={onDelete} /></ul>);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(window.confirm).toHaveBeenCalled());
      expect(onDelete).not.toHaveBeenCalled();
    } finally {
      window.confirm = nativeConfirm;
    }
  });
});
