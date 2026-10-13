import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { DocumentChooser } from '../../src/ui/inbox/DocumentChooser.js';
import { ApiError } from '../../src/api.js';
import { makeDoc } from '../documents/fixtures.js';

const letter = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Certified letter' } });
const receipt = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Return receipt' } });
const bill = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Water bill' } });
const filed = makeDoc({ state: 'filed', filed: { name: 'Lease.pdf', folderPath: '/Home', driveNodeUid: 'n', driveUrl: null } });

let rerender: (ui: preact.ComponentChild) => void;
function renderChooser(mode: 'combine' | 'file-with', over: Partial<Parameters<typeof DocumentChooser>[0]> = {}) {
  const props = {
    mode,
    current: letter,
    review: [letter, receipt, bill],
    filed: [filed],
    onCombine: vi.fn(async () => {}),
    onFileWith: vi.fn(async () => {}),
    onCancel: vi.fn(),
    ...over,
  };
  const r = render(<DocumentChooser {...props} />);
  rerender = r.rerender;
  return props;
}

describe('DocumentChooser: combine', () => {
  it('pins the current card first and combines in the chosen order', async () => {
    const p = renderChooser('combine');
    const confirm = screen.getByRole('button', { name: /^Combine/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    const order = screen.getByRole('list', { name: 'Page order' });
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Certified letter'),
      expect.stringContaining('Water bill'),
      expect.stringContaining('Return receipt'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Return receipt up' }));
    expect(screen.queryByRole('button', { name: 'Move Certified letter up' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Combine 3' }));
    await waitFor(() => expect(p.onCombine).toHaveBeenCalledWith([letter.id, receipt.id, bill.id]));
  });

  it('names the part that cannot be combined', async () => {
    renderChooser('combine', {
      onCombine: vi.fn().mockRejectedValue(new ApiError('cannot_combine', 422, 'cannot_combine', { error: 'cannot_combine', documentId: receipt.id, reason: 'encrypted' })),
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('“Return receipt” can’t be combined: it is password-protected.');
  });

  it('says the list changed on a conflict, and when the server is unreachable', async () => {
    const onCombine = vi.fn().mockRejectedValueOnce(new ApiError('conflict', 409, 'conflict')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderChooser('combine', { onCombine });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something changed; the list has been refreshed.');
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server. Try again.'));
  });
});

describe('DocumentChooser: file with', () => {
  it('lists review cards and recently filed documents, and files with the one chosen', async () => {
    const p = renderChooser('file-with');
    expect(screen.queryByRole('button', { name: /Certified letter/ })).toBeNull(); // not itself
    expect(screen.getByRole('heading', { name: 'In review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recently filed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Lease\.pdf.*\/Home/ }));
    await waitFor(() => expect(p.onFileWith).toHaveBeenCalledWith(filed.id));
  });

  it('narrows the lists by search', () => {
    renderChooser('file-with');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'water' } });
    expect(screen.getByRole('button', { name: /Water bill/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Return receipt/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lease/ })).toBeNull();
  });

  it('says when a search matches nothing', () => {
    renderChooser('file-with');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching documents.')).toBeInTheDocument();
  });

  it('cancels', () => {
    const p = renderChooser('file-with');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it('survives a checked part leaving review', async () => {
    const p = renderChooser('combine');
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    expect(screen.getByRole('button', { name: 'Combine 3' })).toBeEnabled();
    rerender(<DocumentChooser {...p} review={[letter, bill]} />);
    const order = screen.getByRole('list', { name: 'Page order' });
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Certified letter'),
      expect.stringContaining('Water bill'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(p.onCombine).toHaveBeenCalledWith([letter.id, bill.id]));
    rerender(<DocumentChooser {...p} review={[letter]} />);
    expect(screen.getByRole('button', { name: 'Combine 1' })).toBeDisabled();
  });

  it('says when a search matches nothing', () => {
    renderChooser('combine');
    expect(screen.queryByText('No matching documents.')).toBeNull();
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching documents.')).toBeInTheDocument();
  });
});
