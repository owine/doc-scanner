import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { InboxScreen } from '../../src/ui/inbox/InboxScreen.js';
import { DocumentSync } from '../../src/documents/sync.js';
import type { DocumentsApi } from '../../src/documents/api.js';
import type { DocumentView } from '../../src/documents/types.js';
import { ApiError } from '../../src/api.js';
import { FOLDERS, makeDoc } from '../documents/fixtures.js';
import { UploadQueue, type UploadQueueOptions } from '../../src/uploads/queue.js';
import { UploadError } from '../../src/uploads/send.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';
import { ScansStore } from '../../src/scanner/scans-store.js';

class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()]; }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

type Send = NonNullable<UploadQueueOptions['send']>;

const queues: UploadQueue[] = [];
/** An upload queue over memory whose sends never finish, unless the test passes `send`. Stopped after each test. */
function makeQueue(send: Send = () => new Promise(() => {})): UploadQueue {
  const q = new UploadQueue({ store: new MemoryStore(), send });
  queues.push(q);
  return q;
}

afterEach(() => {
  for (const q of queues.splice(0)) q.stop();
  Reflect.deleteProperty(navigator, 'onLine');
});

const JPEG = resolve(__dirname, '../../src/pdf/fixtures/2x1-red.jpg');
const QUAD = { tl: { x: 0, y: 0 }, tr: { x: 2, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 2, y: 1 } };

/** A one-page scan finished before this slice, saved through a store of its own. */
async function savedScan(): Promise<string> {
  const store = new ScansStore();
  await store.open();
  const id = await store.createInProgress();
  await store.appendPage(id, new Blob([readFileSync(JPEG)], { type: 'image/jpeg' }), QUAD);
  await store.finish(id);
  return id;
}

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;

const NOW = new Date('2026-10-10T12:00:00.000Z');

/** Waits until the inbox's folder load has finished and its re-render has flushed. */
async function folderLoad(api: DocumentsApi) {
  const folders = vi.mocked(api.folders);
  await waitFor(() => expect(folders).toHaveBeenCalled());
  await act(async () => {
    await folders.mock.results[0]!.value;
  });
}

function setup(docs: DocumentView[], over: Partial<DocumentsApi> = {}, send?: Send) {
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
  const uploads = makeQueue(send);
  uploads.start();
  const scans = new ScansStore();
  const props = { onScan: vi.fn(), onSettings: vi.fn(), onSignInAgain: vi.fn() };
  render(<InboxScreen sync={sync} documents={api} now={() => NOW} uploads={uploads} scans={scans} {...props} />);
  return { sync, api, props, uploads, scans };
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

  it('reads a document back when a discard was refused because it already moved on', async () => {
    const doc = makeDoc({ state: 'awaiting_login' });
    const { api } = setup([doc], {
      discard: vi.fn().mockRejectedValue(new ApiError('not allowed', 409, 'not_allowed')),
    });
    fireEvent.click(within(screen.getByRole('region', { name: 'In progress' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(doc.id));
    expect(await screen.findByRole('region', { name: 'Discarded' })).toBeInTheDocument();
    expect(screen.queryByText(/failed, try again/i)).toBeNull();
  });

  it('reads a document back when an approval was refused because it already moved on', async () => {
    const doc = makeDoc();
    const { api } = setup([doc], {
      approve: vi.fn().mockRejectedValue(new ApiError('not_in_review', 409, 'not_in_review')),
      get: vi.fn(async () => ({ ...doc, state: 'filed' as const, seq: 999, filed: { name: 'Northwind Energy Bill 2026-09', folderPath: '/Bills/Energy', driveNodeUid: 'v~5', driveUrl: null } })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(doc.id));
    expect(await screen.findByRole('region', { name: 'Recently filed' })).toBeInTheDocument();
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
  });

  it('still says a refused approval moved on while the card stays', async () => {
    const doc = makeDoc();
    const { api } = setup([doc], {
      approve: vi.fn().mockRejectedValue(new ApiError('conflict', 409, 'conflict')),
      get: vi.fn(async () => ({ ...doc, seq: 999 })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This document has already moved on.');
    expect(api.get).toHaveBeenCalledWith(doc.id);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('reads a document back when a retry was refused because it already moved on', async () => {
    const doc = makeDoc({ state: 'failed', error: 'Drive was unavailable' });
    const { api } = setup([doc], {
      retry: vi.fn().mockRejectedValue(new ApiError('not allowed', 409, 'not_allowed')),
      get: vi.fn(async () => ({ ...doc, state: 'received' as const, seq: 999 })),
    });
    fireEvent.click(within(screen.getByRole('region', { name: 'Failed' })).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(doc.id));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Failed' })).toBeNull());
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('drops a discarded row once retention passes, without any document change', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let clock = NOW.getTime();
      const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
      sync.loaded = true;
      sync.upsert(makeDoc({ state: 'discarded', discardedAt: '2026-10-04T12:00:00.000Z' }));
      const api = { folders: vi.fn().mockResolvedValue({ walkedAt: NOW.toISOString(), folders: FOLDERS }), refreshFolders: vi.fn() } as unknown as DocumentsApi;
      render(<InboxScreen sync={sync} documents={api} now={() => new Date(clock)} onScan={vi.fn()} uploads={makeQueue()} scans={new ScansStore()} onSettings={vi.fn()} onSignInAgain={vi.fn()} />);
      expect(screen.getByRole('region', { name: 'Discarded' })).toBeInTheDocument();
      // Let the mount's own re-renders and the folder load settle first.
      await folderLoad(api);
      expect(screen.getByRole('region', { name: 'Discarded' })).toBeInTheDocument();
      clock += 2 * 86_400_000 + 60_000;
      // Nothing re-renders until the interval fires.
      expect(screen.getByRole('region', { name: 'Discarded' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Discarded' })).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the server is unreachable instead of showing an empty inbox', async () => {
    const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
    sync.loaded = true;
    sync.error = new Error('offline');
    const api = { folders: vi.fn().mockResolvedValue({ walkedAt: NOW.toISOString(), folders: FOLDERS }), refreshFolders: vi.fn() } as unknown as DocumentsApi;
    render(<InboxScreen sync={sync} documents={api} now={() => NOW} onScan={vi.fn()} uploads={makeQueue()} scans={new ScansStore()} onSettings={vi.fn()} onSignInAgain={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent("Can't reach the server.");
    expect(screen.queryByText(/nothing to review/i)).toBeNull();
    expect(screen.queryByText(/showing what was last loaded/i)).toBeNull();
    await folderLoad(api);
  });

  it('keeps the documents and warns when the server becomes unreachable', async () => {
    const sync = new DocumentSync({ list: vi.fn().mockResolvedValue({ documents: [], cursor: 0 }) });
    sync.loaded = true;
    sync.upsert(makeDoc());
    sync.error = new Error('offline');
    const api = { folders: vi.fn().mockResolvedValue({ walkedAt: NOW.toISOString(), folders: FOLDERS }), refreshFolders: vi.fn() } as unknown as DocumentsApi;
    render(<InboxScreen sync={sync} documents={api} now={() => NOW} onScan={vi.fn()} uploads={makeQueue()} scans={new ScansStore()} onSettings={vi.fn()} onSignInAgain={vi.fn()} />);
    expect(screen.getByText(/showing what was last loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    await folderLoad(api);
  });

  it('describes every row action by its document and keeps list semantics', async () => {
    const waiting = makeDoc({ state: 'awaiting_login', analysis: null, originalName: 'waiting.pdf' });
    const failed = makeDoc({ state: 'failed', error: 'Drive was unavailable', analysis: null, originalName: 'failed.pdf' });
    const discarded = makeDoc({ state: 'discarded', discardedAt: '2026-10-08T12:00:00.000Z', analysis: null, originalName: 'gone.pdf' });
    const filed = makeDoc({ state: 'filed', originalName: 'filed.pdf', filed: { name: 'Filed One', folderPath: '/Bills', driveNodeUid: 'v~9', driveUrl: 'https://drive.proton.me/u/0/s/file/9' } });
    setup([waiting, failed, discarded, filed]);
    const inRegion = (name: string) => within(screen.getByRole('region', { name }));
    expect(inRegion('In progress').getByRole('button', { name: 'Discard' })).toHaveAccessibleDescription('waiting.pdf');
    expect(inRegion('Failed').getByRole('button', { name: 'Retry' })).toHaveAccessibleDescription('failed.pdf');
    expect(inRegion('Failed').getByRole('button', { name: 'Discard' })).toHaveAccessibleDescription('failed.pdf');
    expect(inRegion('Discarded').getByRole('button', { name: 'Restore' })).toHaveAccessibleDescription('gone.pdf');
    expect(inRegion('Recently filed').getByRole('link', { name: /open in drive/i })).toHaveAccessibleDescription('Filed One');
    expect(document.querySelectorAll('ul.doc-list:not([role="list"])')).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });

  it('shows a requested discard as discarding and hides the button', async () => {
    const doc = makeDoc({ state: 'analyzing' });
    const { api } = setup([doc], {
      discard: vi.fn().mockResolvedValue({ result: 'requested' }),
      get: vi.fn(async () => ({ ...doc, discardRequested: true, seq: 999 })),
    });
    const progress = screen.getByRole('region', { name: 'In progress' });
    fireEvent.click(within(progress).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(doc.id));
    expect(await within(progress).findByText('Discarding…')).toBeInTheDocument();
    expect(within(progress).queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('offers no discard while an upload is under way', async () => {
    setup([makeDoc({ state: 'filing', possiblyInDrive: true })]);
    const progress = screen.getByRole('region', { name: 'In progress' });
    expect(within(progress).getByText('Filing…')).toBeInTheDocument();
    expect(within(progress).queryByRole('button', { name: 'Discard' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });

  it('does not report a failure when the read-back after a discard fails, and polls instead', async () => {
    const doc = makeDoc({ state: 'awaiting_login' });
    const { sync, api } = setup([doc], { get: vi.fn().mockRejectedValue(new Error('network')) });
    const poll = vi.spyOn(sync, 'poll').mockResolvedValue();
    fireEvent.click(within(screen.getByRole('region', { name: 'In progress' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(poll).toHaveBeenCalled());
    expect(api.discard).toHaveBeenCalledWith(doc.id);
    expect(screen.queryByText(/failed, try again/i)).toBeNull();
  });

  it('shows a failed action that is not a refusal as try again', async () => {
    const doc = makeDoc({ state: 'failed', error: 'Drive was unavailable' });
    const { api } = setup([doc], { retry: vi.fn().mockRejectedValue(new ApiError('boom', 500)) });
    fireEvent.click(within(screen.getByRole('region', { name: 'Failed' })).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Retry (failed, try again)' })).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('goes ahead with a discard when the user confirms', async () => {
    const nativeConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValue(true);
    try {
      const doc = makeDoc({ state: 'failed', error: 'Upload interrupted', possiblyInDrive: true });
      const { api } = setup([doc]);
      fireEvent.click(within(screen.getByRole('region', { name: 'Failed' })).getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(api.discard).toHaveBeenCalledWith(doc.id));
      expect(await screen.findByRole('region', { name: 'Discarded' })).toBeInTheDocument();
    } finally {
      window.confirm = nativeConfirm;
    }
  });

  it('says how many documents are waiting for sign-in', async () => {
    setup([makeDoc({ state: 'awaiting_login' }), makeDoc({ state: 'awaiting_login' })]);
    expect(screen.getByText(/2 documents are waiting to be filed/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Waiting for sign-in')).toHaveLength(2));
  });

  it('does not report a failure when the read-back after a refusal fails, and polls instead', async () => {
    const doc = makeDoc({ state: 'failed', error: 'Drive was unavailable' });
    const { sync } = setup([doc], {
      retry: vi.fn().mockRejectedValue(new ApiError('not allowed', 409, 'not_allowed')),
      get: vi.fn().mockRejectedValue(new Error('network')),
    });
    const poll = vi.spyOn(sync, 'poll').mockResolvedValue();
    fireEvent.click(within(screen.getByRole('region', { name: 'Failed' })).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(poll).toHaveBeenCalled());
    expect(screen.queryByText(/failed, try again/i)).toBeNull();
  });

  it('forgets a document the server no longer has', async () => {
    const doc = makeDoc({ state: 'discarded', discardedAt: '2026-10-08T12:00:00.000Z' });
    setup([doc], { restore: vi.fn().mockRejectedValue(new ApiError('gone', 404, 'not_found')) });
    fireEvent.click(within(screen.getByRole('region', { name: 'Discarded' })).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Discarded' })).toBeNull());
    expect(screen.queryByText(/failed, try again/i)).toBeNull();
  });

  it('keeps its live region in place while the banners come and go', async () => {
    const { sync } = setup([makeDoc()]);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    sync.error = new Error('offline');
    act(() => sync.upsert(makeDoc({ state: 'awaiting_login' })));
    await waitFor(() => expect(status).toHaveTextContent(/showing what was last loaded/i));
    expect(status).toHaveTextContent(/1 document is waiting to be filed/i);
    expect(screen.getByRole('status')).toBe(status);
    sync.error = null;
    act(() => sync.upsert(makeDoc()));
    await waitFor(() => expect(status).not.toHaveTextContent(/can't reach/i));
    expect(screen.getByRole('status')).toBe(status);
  });

  it('opens the scanner and settings, and has no saved scans any more', async () => {
    const { props } = setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(props.onScan).toHaveBeenCalled();
    expect(props.onSettings).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /saved scans/i })).toBeNull();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
  });
});

describe('InboxScreen uploads', () => {
  it('adds the files chosen with Add, and clears the picker for the next choice', async () => {
    const { uploads } = setup([]);
    const input = fileInput();
    const click = vi.spyOn(input, 'click');
    const cleared = vi.spyOn(input, 'value', 'set');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    const region = await screen.findByRole('region', { name: 'Uploading' });
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(2));
    expect(uploads.list().map((i) => i.source)).toEqual(['picker', 'picker']);
    expect(cleared).toHaveBeenCalledWith('');
  });

  it('adds files dropped on the inbox, with a hint while dragging', async () => {
    const { uploads } = setup([]);
    const main = screen.getByRole('main');
    fireEvent.dragOver(main, { dataTransfer: { types: ['Files'] } });
    expect(await screen.findByText('Drop files to add them')).toBeInTheDocument();
    fireEvent.drop(main, { dataTransfer: { files: [pdf('a.pdf')] } });
    await waitFor(() => expect(uploads.list()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Drop files to add them')).toBeNull());
  });

  it('shows the progress of the file being sent', async () => {
    let report!: (fraction: number) => void;
    setup([], {}, (_input, onProgress) => {
      report = onProgress;
      return new Promise(() => {});
    });
    fireEvent.change(fileInput(), { target: { files: [pdf('a.pdf')] } });
    await waitFor(() => expect(report).toBeDefined());
    act(() => report(0.5));
    expect(await screen.findByText('Uploading… 50%')).toBeInTheDocument();
  });

  it('explains a refused file and offers Retry and Remove', async () => {
    const { uploads } = setup([], {}, vi.fn().mockRejectedValue(new UploadError(413, 'payload_too_large')));
    const retry = vi.spyOn(uploads, 'retry');
    fireEvent.change(fileInput(), { target: { files: [pdf('big.pdf')] } });
    const region = await screen.findByRole('region', { name: 'Uploading' });
    expect(await within(region).findByText(/50 MB/)).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    // Refused again; then Remove takes the row away.
    fireEvent.click(await within(region).findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Uploading' })).toBeNull());
  });

  it('says which files wait, and which wait for a connection, as it comes and goes', async () => {
    setup([]);
    fireEvent.change(fileInput(), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    expect(await screen.findByText('Waiting to upload')).toBeInTheDocument();
    expect(screen.getByText('Uploading… 0%')).toBeInTheDocument();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText('Waiting for a connection')).toBeInTheDocument();
    Reflect.deleteProperty(navigator, 'onLine');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByText('Waiting to upload')).toBeInTheDocument();
  });

  it('says so when the files cannot be kept for upload', async () => {
    const { uploads } = setup([]);
    vi.spyOn(uploads, 'add').mockRejectedValue(new Error('quota'));
    fireEvent.change(fileInput(), { target: { files: [pdf('a.pdf')] } });
    expect(await screen.findByText("Couldn't add the files. Try again.")).toBeInTheDocument();
  });
});

describe('InboxScreen scans on this device', () => {
  beforeAll(async () => {
    await import('../../src/pdf/build.js');
  });

  it('lists a scan saved on the device', async () => {
    await savedScan();
    setup([]);
    const region = await screen.findByRole('region', { name: 'Scans on this device' });
    expect(within(region).getByText('Scan · 1 page')).toBeInTheDocument();
    expect(within(region).getByText(/saved before scans went straight to your inbox/i)).toBeInTheDocument();
  });

  it('sends a scan to the inbox', async () => {
    const id = await savedScan();
    const { uploads } = setup([]);
    const region = await screen.findByRole('region', { name: 'Scans on this device' });
    fireEvent.click(within(region).getByRole('button', { name: 'Send to inbox' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull());
    expect(await screen.findByRole('region', { name: 'Uploading' })).toBeInTheDocument();
    expect(uploads.list()).toMatchObject([{ source: 'scanner', scanId: id }]);
  });

  it('deletes a scan once the user confirms, and keeps it otherwise', async () => {
    const nativeConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      await savedScan();
      setup([]);
      const region = await screen.findByRole('region', { name: 'Scans on this device' });
      fireEvent.click(within(region).getByRole('button', { name: 'Delete' }));
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(within(region).getByText('Scan · 1 page')).toBeInTheDocument();
      fireEvent.click(within(region).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull());
    } finally {
      window.confirm = nativeConfirm;
    }
  });

  it('has no device section without saved scans', async () => {
    setup([]);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Scans on this device' })).toBeNull();
  });
});
