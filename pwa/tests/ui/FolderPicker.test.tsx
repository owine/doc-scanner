import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { FolderPicker } from '../../src/ui/inbox/FolderPicker.js';
import type { FoldersState } from '../../src/documents/use-folders.js';
import { FOLDERS } from '../documents/fixtures.js';

function folders(over: Partial<FoldersState> = {}): FoldersState {
  return { folders: FOLDERS, error: null, busy: false, reload: vi.fn(async () => {}), refresh: vi.fn(async () => {}), ...over };
}

describe('FolderPicker', () => {
  it('filters as you type and chooses an existing folder', () => {
    const onChoose = vi.fn();
    render(<FolderPicker folders={folders()} allowNew={false} onChoose={onChoose} onCancel={() => {}} />);
    fireEvent.input(screen.getByRole('searchbox', { name: /search folders/i }), { target: { value: 'water' } });
    expect(screen.queryByRole('button', { name: '/Bills/Energy' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '/Bills/Water' }));
    expect(onChoose).toHaveBeenCalledWith({ kind: 'existing', linkId: 'L-water', path: '/Bills/Water' });
  });

  it('chooses a new folder inside a result', () => {
    const onChoose = vi.fn();
    render(<FolderPicker folders={folders()} allowNew onChoose={onChoose} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'New folder in /Bills' }));
    fireEvent.input(screen.getByRole('textbox', { name: /new folder name/i }), { target: { value: ' Gas ' } });
    fireEvent.click(screen.getByRole('button', { name: /use new folder/i }));
    expect(onChoose).toHaveBeenCalledWith({ kind: 'new', parentLinkId: 'L-bills', parentPath: '/Bills', name: 'Gas' });
  });

  it('offers no new folder when not allowed', () => {
    render(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: /new folder in/i })).toBeNull();
  });

  it('shows a load error with a refresh button', () => {
    const state = folders({ folders: null, error: 'The folder list has not loaded from Drive yet.' });
    render(<FolderPicker folders={state} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/has not loaded/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(state.refresh).toHaveBeenCalled();
  });

  it('loads the list when it has none yet', () => {
    const state = folders({ folders: null });
    render(<FolderPicker folders={state} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(state.reload).toHaveBeenCalled();
  });

  it('cancels with the button or Escape', () => {
    const onCancel = vi.fn();
    render(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.keyDown(screen.getByRole('searchbox', { name: /search folders/i }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('focuses the search box when it opens', () => {
    render(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('searchbox', { name: /search folders/i })).toHaveFocus();
  });
});
