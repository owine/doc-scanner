import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { InboxScreen } from '../../src/ui/inbox/InboxScreen.js';
import { DocumentSync } from '../../src/documents/sync.js';
import type { DocumentsApi } from '../../src/documents/api.js';
import type { DocumentView } from '../../src/documents/types.js';
import { FOLDERS, makeDoc } from '../documents/fixtures.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

function setup(docs: DocumentView[], over: Partial<DocumentsApi> = {}) {
  const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
  sync.loaded = true;
  for (const d of docs) sync.upsert(d);
  const api = {
    folders: vi.fn().mockResolvedValue({ walkedAt: NOW.toISOString(), folders: FOLDERS }),
    refreshFolders: vi.fn().mockResolvedValue({ ok: true }),
    approve: vi.fn(async (id: string) => ({ ...docs.find((d) => d.id === id)!, state: 'filing' as const, seq: 999 })),
    discard: vi.fn().mockResolvedValue({ result: 'discarded' }),
    get: vi.fn(async (id: string) => ({ ...docs.find((d) => d.id === id)!, state: 'discarded' as const, seq: 999, discardedAt: NOW.toISOString() })),
    restore: vi.fn(async (id: string) => ({ ...docs.find((d) => d.id === id)!, state: 'needs_review' as const, seq: 999, discardedAt: null })),
    retry: vi.fn(async (id: string) => ({ ...docs.find((d) => d.id === id)!, state: 'received' as const, seq: 999 })),
    ...over,
  } as unknown as DocumentsApi;
  const props = { onScan: vi.fn(), onSavedScans: vi.fn(), onSettings: vi.fn(), onSignInAgain: vi.fn() };
  render(<InboxScreen sync={sync} documents={api} now={() => NOW} {...props} />);
  return { sync, api, props };
}

describe('InboxScreen', () => {
  it('says when there is nothing to review', async () => {
    setup([]);
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });

  it('approving moves a document out of review', async () => {
    const doc = makeDoc();
    const { api } = setup([doc]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith(doc.id, {}));
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'In progress' })).getByText('Filing…')).toBeInTheDocument();
  });

  it('lists filed documents with who filed them and a Drive link', async () => {
    setup([
      makeDoc({ state: 'filed', autoFiled: true, filed: { name: 'Northwind Energy Bill 2026-08', folderPath: '/Bills/Energy', driveNodeUid: 'v~1', driveUrl: 'https://drive.proton.me/u/0/s/file/1' } }),
      makeDoc({ state: 'filed', userEdited: true, filed: { name: 'Water Bill 2026-08', folderPath: '/Bills/Water', driveNodeUid: 'v~2', driveUrl: null } }),
    ]);
    const filed = screen.getByRole('region', { name: 'Recently filed' });
    expect(within(filed).getByText('auto')).toBeInTheDocument();
    expect(within(filed).getByText('you edited')).toBeInTheDocument();
    expect(within(filed).getAllByRole('link', { name: /open in drive/i })).toHaveLength(1);
    await waitFor(() => expect(filed).toBeInTheDocument());
  });

  it('links only https Proton Drive URLs', async () => {
    setup([
      makeDoc({ state: 'filed', filed: { name: 'X', folderPath: '/', driveNodeUid: 'v~3', driveUrl: 'javascript:alert(1)' } }),
      makeDoc({ state: 'filed', filed: { name: 'Y', folderPath: '/', driveNodeUid: 'v~4', driveUrl: 'https://example.test/file' } }),
    ]);
    expect(screen.queryByRole('link', { name: /open in drive/i })).toBeNull();
    await waitFor(() => expect(screen.getByText('X')).toBeInTheDocument());
  });

  it('asks before discarding a failed document that may be in Drive', async () => {
    const nativeConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValue(false);
    try {
      const { api } = setup([makeDoc({ state: 'failed', error: 'Upload interrupted', possiblyInDrive: true })]);
      fireEvent.click(within(screen.getByRole('region', { name: 'Failed' })).getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(window.confirm).toHaveBeenCalled());
      expect(api.discard).not.toHaveBeenCalled();
    } finally {
      window.confirm = nativeConfirm;
    }
  });

  it('discards a document that is waiting, and shows it as discarded', async () => {
    const doc = makeDoc({ state: 'awaiting_login' });
    const { api } = setup([doc]);
    fireEvent.click(within(screen.getByRole('region', { name: 'In progress' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.discard).toHaveBeenCalledWith(doc.id));
    expect(await screen.findByRole('region', { name: 'Discarded' })).toBeInTheDocument();
  });

  it('retries a failed document', async () => {
    const doc = makeDoc({ state: 'failed', error: 'Drive was unavailable' });
    const { api } = setup([doc]);
    const failed = screen.getByRole('region', { name: 'Failed' });
    expect(within(failed).getByText('Drive was unavailable')).toBeInTheDocument();
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith(doc.id));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Failed' })).toBeNull());
  });

  it('restores a discarded document and shows the days left', async () => {
    const doc = makeDoc({ state: 'discarded', discardedAt: '2026-10-08T12:00:00.000Z' });
    const { api } = setup([doc]);
    const discarded = screen.getByRole('region', { name: 'Discarded' });
    expect(within(discarded).getByText(/deleted in 5 days/i)).toBeInTheDocument();
    fireEvent.click(within(discarded).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith(doc.id));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument());
  });

  it('asks the user to sign in again when documents wait for login', async () => {
    const { props } = setup([makeDoc({ state: 'awaiting_login' })]);
    expect(screen.getByText(/1 document is waiting to be filed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign in again/i }));
    expect(props.onSignInAgain).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Waiting for sign-in')).toBeInTheDocument());
  });

  it('opens the scanner, settings and saved scans', async () => {
    const { props } = setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: /saved scans/i }));
    expect(props.onScan).toHaveBeenCalled();
    expect(props.onSettings).toHaveBeenCalled();
    expect(props.onSavedScans).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });
});
