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

  it('leaves the name to the user: no autocorrect, autocapitalize or spellcheck', () => {
    // Browsers expose spellcheck, and iOS Safari autocorrect, as boolean
    // properties that reflect to the attribute, and Preact sets them as
    // properties. happy-dom has neither, so Preact would fall back to the
    // attribute and drop a `false`: give it the browser's properties. (A
    // string "off" set through such a property is truthy and turns it on.)
    const reflect = (name: string, on: string, off: string) =>
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get(this: HTMLElement) { return this.getAttribute(name) !== off; },
        set(this: HTMLElement, v: unknown) { this.setAttribute(name, v ? on : off); },
      });
    reflect('spellcheck', 'true', 'false');
    reflect('autocorrect', 'on', 'off');
    try {
      renderCard();
      const name = screen.getByRole('textbox', { name: 'Name' });
      expect(name).toHaveAttribute('autocorrect', 'off');
      expect(name).toHaveAttribute('autocapitalize', 'off');
      expect(name).toHaveAttribute('spellcheck', 'false');
    } finally {
      for (const p of ['spellcheck', 'autocorrect']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
    }
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

  it('shows the first-page thumbnail when there is one', () => {
    renderCard(makeDoc({ id: 'a/b c', hasThumbnail: true }));
    const img = screen.getByRole('img', { name: 'First page preview' });
    expect(img).toHaveAttribute('src', '/api/documents/a%2Fb%20c/thumbnail');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('shows no thumbnail without one', () => {
    renderCard();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('hides a thumbnail that fails to load', () => {
    renderCard(makeDoc({ hasThumbnail: true }));
    const img = screen.getByRole('img', { name: 'First page preview' }) as HTMLImageElement;
    fireEvent.error(img);
    expect(img.hidden).toBe(true);
  });

  it('shows the preparation note, muted', () => {
    renderCard(makeDoc({ prepareNote: 'No text layer: OCR failed.' }));
    expect(screen.getByText('No text layer: OCR failed.')).toHaveClass('muted');
  });

  it('returns focus to Change after Cancel', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toHaveFocus());
  });
});

describe('ReviewCard more menu', () => {
  function renderWithMenu(doc = makeDoc(), review = [doc, makeDoc()], filed: ReturnType<typeof makeDoc>[] = []) {
    const onCombine = vi.fn(async () => {});
    const onReanalyze = vi.fn(async () => {});
    render(
      <ReviewCard doc={doc} folders={folders} onApprove={vi.fn()} onDiscard={vi.fn()} review={review} filed={filed} onCombine={onCombine} onReanalyze={onReanalyze} />,
    );
    return { onCombine, onReanalyze };
  }

  it('offers Combine with…, File with… and Re-analyse', async () => {
    const { onReanalyze } = renderWithMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Combine with…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File with…' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyse' }));
    await waitFor(() => expect(onReanalyze).toHaveBeenCalledWith());
  });

  it('hides Combine with… and File with… when there is nothing to pick', () => {
    const doc = makeDoc();
    renderWithMenu(doc, [doc]);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('button', { name: 'Combine with…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'File with…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Re-analyse' })).toBeInTheDocument();
  });

  it('has no menu for a document that may already be in Drive', () => {
    renderWithMenu(makeDoc({ possiblyInDrive: true }));
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('opens the chooser and files with the document picked', async () => {
    const doc = makeDoc();
    const other = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Certified letter' } });
    const { onReanalyze } = renderWithMenu(doc, [doc, other]);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'File with…' }));
    fireEvent.click(screen.getByRole('button', { name: /Certified letter/ }));
    await waitFor(() => expect(onReanalyze).toHaveBeenCalledWith(other.id));
  });

  it('says what the document is being filed with', () => {
    renderWithMenu(makeDoc({ anchorName: 'Certified letter' }));
    expect(screen.getByText('Filed with “Certified letter”')).toBeInTheDocument();
  });

  it('returns focus to More when the chooser is cancelled, and ties aria-controls to a shown menu', () => {
    const doc = makeDoc();
    renderWithMenu(doc, [doc, makeDoc()]);
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).not.toHaveAttribute('aria-controls');
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more).toHaveAttribute('aria-controls');
    fireEvent.click(screen.getByRole('button', { name: 'File with…' }));
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).not.toHaveAttribute('aria-controls');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(more).toHaveFocus();
  });
});
