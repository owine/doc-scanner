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

  it('offers the root folder unless told not to', () => {
    const { unmount } = render(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument();
    unmount();
    render(<FolderPicker folders={folders()} allowNew={false} allowRoot={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: '/' })).toBeNull();
    expect(screen.getByRole('button', { name: '/Bills' })).toBeInTheDocument();
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

  it('reloads the list on every open, showing the one it has meanwhile', () => {
    // A folder created by an approval exists in Drive now, but not in a list loaded before it.
    const state = folders();
    render(<FolderPicker folders={state} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '/Bills/Water' })).toBeInTheDocument();
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

  it('Escape in the new-folder name closes only that form', () => {
    const onCancel = vi.fn();
    render(<FolderPicker folders={folders()} allowNew onChoose={() => {}} onCancel={onCancel} />);
    const plus = screen.getByRole('button', { name: 'New folder in /Bills' });
    fireEvent.click(plus);
    fireEvent.keyDown(screen.getByRole('textbox', { name: /new folder name/i }), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /new folder name/i })).toBeNull();
    expect(plus).toHaveFocus();
    expect(screen.getByRole('searchbox', { name: /search folders/i })).toBeInTheDocument();
  });

  it('re-focuses the name field when + is clicked again', () => {
    render(<FolderPicker folders={folders()} allowNew onChoose={() => {}} onCancel={() => {}} />);
    const plus = screen.getByRole('button', { name: 'New folder in /Bills' });
    fireEvent.click(plus);
    const input = screen.getByRole('textbox', { name: /new folder name/i });
    expect(input).toHaveFocus();
    plus.focus();
    fireEvent.click(plus);
    expect(screen.getByRole('textbox', { name: /new folder name/i })).toHaveFocus();
  });

  it('keeps its live regions in place while their text changes', () => {
    const { rerender } = render(<FolderPicker folders={folders({ folders: null })} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status).toHaveTextContent(/loading folders/i);
    expect(alert).toBeEmptyDOMElement();
    rerender(<FolderPicker folders={folders({ folders: null, error: 'Could not load the folder list.' })} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert).toHaveTextContent(/could not load/i);
    expect(screen.getByRole('status')).toBe(status);
    rerender(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it('keeps list semantics on the results', () => {
    render(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('list')).toHaveClass('folder-results');
    expect(document.querySelectorAll('ul:not([role="list"])')).toHaveLength(0);
  });

  it('says only the first results show until the search narrows them', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ linkId: `L-${i}`, path: `/Projects/P${String(i).padStart(2, '0')}` }));
    render(<FolderPicker folders={folders({ folders: many })} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Showing the first 50 — type to narrow')).toBeInTheDocument();
    fireEvent.input(screen.getByRole('searchbox', { name: /search folders/i }), { target: { value: 'P07' } });
    expect(screen.queryByText(/showing the first/i)).toBeNull();
  });

  it('shows no limit hint when every folder fits', () => {
    render(<FolderPicker folders={folders()} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(/showing the first/i)).toBeNull();
  });

  it('announces a load error and the loading state', () => {
    const { unmount } = render(<FolderPicker folders={folders({ folders: null, error: 'Could not load the folder list.' })} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i);
    unmount();
    render(<FolderPicker folders={folders({ folders: null })} allowNew={false} onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading folders/i);
  });
});
