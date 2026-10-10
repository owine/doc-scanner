import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { ReviewCard } from '../../src/ui/inbox/ReviewCard.js';
import { ApiError } from '../../src/api.js';
import type { FoldersState } from '../../src/documents/use-folders.js';
import { FOLDERS, makeDoc } from '../documents/fixtures.js';

const folders: FoldersState = { folders: FOLDERS, error: null, busy: false, reload: async () => {}, refresh: async () => {} };
const nativeConfirm = window.confirm;
afterEach(() => { window.confirm = nativeConfirm; });

function renderCard(doc = makeDoc(), handlers: Partial<{ onApprove: any; onDiscard: any }> = {}) {
  const onApprove = handlers.onApprove ?? vi.fn(async () => {});
  const onDiscard = handlers.onDiscard ?? vi.fn(async () => {});
  render(<ReviewCard doc={doc} folders={folders} onApprove={onApprove} onDiscard={onDiscard} />);
  return { onApprove, onDiscard };
}

describe('ReviewCard', () => {
  it('shows the suggestion, confidence, reason and rationale', () => {
    renderCard();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Northwind Energy Bill 2026-09');
    expect(screen.getByText('/Bills/Energy')).toBeInTheDocument();
    expect(screen.getByText(/60% confident · confidence 0.600 is below 0.80/)).toBeInTheDocument();
    expect(screen.getByText(/energy bill from Northwind Energy/)).toBeInTheDocument();
  });

  it('approves as suggested with an empty body', async () => {
    const { onApprove } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('sends an edited name and a changed folder', async () => {
    const { onApprove } = renderCard();
    fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Northwind Energy Bill 2026-09 (final)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: '/Bills/Water' }));
    expect(screen.getByRole('button', { name: 'Change' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        name: 'Northwind Energy Bill 2026-09 (final)',
        folder: { kind: 'existing', linkId: 'L-water' },
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('marks a proposed new folder and sends it unchanged as-is', async () => {
    const doc = makeDoc({
      analysis: { ...makeDoc().analysis!, folder: { kind: 'new', parentLinkId: 'L-bills', parentPath: '/Bills', name: 'Gas' } },
    });
    const { onApprove } = renderCard(doc);
    expect(screen.getByText('New folder')).toBeInTheDocument();
    expect(screen.getByText('/Bills/Gas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('needs a folder and a name before it can approve', () => {
    renderCard(makeDoc({ analysis: { ...makeDoc().analysis!, folder: null } }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText(/no folder suggested/i)).toBeInTheDocument();
  });

  it('explains a server error', async () => {
    renderCard(makeDoc(), { onApprove: vi.fn().mockRejectedValue(new ApiError('unknown_folder', 400, 'unknown_folder')) });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i);
  });

  it('explains an unusable folder name', async () => {
    renderCard(makeDoc(), { onApprove: vi.fn().mockRejectedValue(new ApiError('x', 400, 'invalid_folder_name')) });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no usable characters/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('explains a suggested folder that is now on the never-file-here list', async () => {
    renderCard(makeDoc(), { onApprove: vi.fn().mockRejectedValue(new ApiError('x', 400, 'excluded_folder')) });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That folder is on your never-file-here list. Pick another.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('explains a document that no longer exists', async () => {
    renderCard(makeDoc(), { onApprove: vi.fn().mockRejectedValue(new ApiError('x', 404, 'not_found')) });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('labels the folder control as a group named Folder', () => {
    renderCard();
    const group = screen.getByRole('group', { name: 'Folder' });
    expect(within(group).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('notes an analysis from file details only', () => {
    renderCard(makeDoc({ analysis: { ...makeDoc().analysis!, contentSeen: false } }));
    expect(screen.getByText(/file's details only/i)).toBeInTheDocument();
  });

  it('discards without asking, unless the document may already be in Drive', async () => {
    const { onDiscard } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled());
  });

  it('asks before discarding a document that may be in Drive', async () => {
    window.confirm = vi.fn().mockReturnValue(false);
    const { onDiscard } = renderCard(makeDoc({ possiblyInDrive: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('sends {} when the suggested folder is picked again', async () => {
    const { onApprove } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: '/Bills/Energy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('sends {} when the name differs only by surrounding whitespace', async () => {
    const { onApprove } = renderCard();
    fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '  Northwind Energy Bill 2026-09  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('discards after the user confirms', async () => {
    window.confirm = vi.fn().mockReturnValue(true);
    const { onDiscard } = renderCard(makeDoc({ possiblyInDrive: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled());
  });

  it('returns focus to Change after Cancel', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toHaveFocus());
  });
});
