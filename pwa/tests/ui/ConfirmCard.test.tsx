import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { ConfirmCard } from '../../src/ui/ConfirmCard.js';
import type { UploadSuggestion } from '../../src/scanner/types.js';

const FOLDERS = [
  { linkId: 'root', path: '/' },
  { linkId: 'f-tax', path: '/Tax' },
  { linkId: 'f-recipes', path: '/Recipes' },
];

const FULL_SUGGESTION: UploadSuggestion = {
  suggestedName: 'Tax Receipt 2026',
  suggestedFolderLinkId: 'f-tax',
  confidence: 0.9,
  rationale: 'Page contains IRS Form 1040 header',
};

beforeEach(() => cleanup());

function noopAsync(): Promise<void> { return Promise.resolve(); }

describe('ConfirmCard', () => {
  it('pre-fills filename + folder + rationale from a full suggestion', () => {
    render(
      <ConfirmCard
        scanId="s1"
        suggestion={FULL_SUGGESTION}
        folders={FOLDERS}
        onSave={noopAsync}
        onDismiss={() => {}}
        onRefreshFolders={noopAsync}
      />,
    );
    const nameInput = screen.getByLabelText('filename') as HTMLInputElement;
    expect(nameInput.value).toBe('Tax Receipt 2026');
    const folderSelect = screen.getByLabelText('folder') as HTMLSelectElement;
    expect(folderSelect.value).toBe('f-tax');
    expect(screen.getByText(/IRS Form 1040 header/)).toBeInTheDocument();
  });

  it('renders empty fields and disables Save when suggestion is null', () => {
    render(
      <ConfirmCard
        scanId="s1"
        suggestion={null}
        folders={FOLDERS}
        onSave={noopAsync}
        onDismiss={() => {}}
        onRefreshFolders={noopAsync}
      />,
    );
    const nameInput = screen.getByLabelText('filename') as HTMLInputElement;
    expect(nameInput.value).toBe('');
    const saveBtn = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('disables Save and shows hint when name has illegal characters', () => {
    render(
      <ConfirmCard
        scanId="s1"
        suggestion={null}
        folders={FOLDERS}
        onSave={noopAsync}
        onDismiss={() => {}}
        onRefreshFolders={noopAsync}
      />,
    );
    const nameInput = screen.getByLabelText('filename') as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: 'Tax/Receipt 2026' } });
    expect(screen.getByText(/letters, digits, spaces/)).toBeInTheDocument();
    const saveBtn = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('Save calls onSave with current name + folder values after edits', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmCard
        scanId="s1"
        suggestion={FULL_SUGGESTION}
        folders={FOLDERS}
        onSave={onSave}
        onDismiss={() => {}}
        onRefreshFolders={noopAsync}
      />,
    );
    const nameInput = screen.getByLabelText('filename') as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: 'Edited Name' } });
    const folderSelect = screen.getByLabelText('folder') as HTMLSelectElement;
    fireEvent.change(folderSelect, { target: { value: 'f-recipes' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith('Edited Name', 'f-recipes');
  });

  it('shows Low-confidence badge below threshold and hides above', () => {
    const { rerender } = render(
      <ConfirmCard
        scanId="s1"
        suggestion={{ ...FULL_SUGGESTION, confidence: 0.4 }}
        folders={FOLDERS}
        onSave={noopAsync}
        onDismiss={() => {}}
        onRefreshFolders={noopAsync}
      />,
    );
    expect(screen.queryByLabelText('low confidence')).toBeInTheDocument();
    rerender(
      <ConfirmCard
        scanId="s1"
        suggestion={{ ...FULL_SUGGESTION, confidence: 0.95 }}
        folders={FOLDERS}
        onSave={noopAsync}
        onDismiss={() => {}}
        onRefreshFolders={noopAsync}
      />,
    );
    expect(screen.queryByLabelText('low confidence')).not.toBeInTheDocument();
  });

  it('Refresh folders button triggers the onRefreshFolders callback', async () => {
    const onRefreshFolders = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmCard
        scanId="s1"
        suggestion={FULL_SUGGESTION}
        folders={FOLDERS}
        onSave={noopAsync}
        onDismiss={() => {}}
        onRefreshFolders={onRefreshFolders}
      />,
    );
    fireEvent.click(screen.getByText(/Refresh folders/));
    await waitFor(() => expect(onRefreshFolders).toHaveBeenCalledOnce());
  });
});
