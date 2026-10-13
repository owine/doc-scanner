import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { DocumentChooser } from '../../src/ui/inbox/DocumentChooser.js';
import { ApiError } from '../../src/api.js';
import { makeDoc } from '../documents/fixtures.js';

const letter = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Certified letter' } });
const receipt = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Return receipt' } });
const bill = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Water bill' } });
const filed = makeDoc({ state: 'filed', filed: { name: 'Lease.pdf', folderPath: '/Home', driveNodeUid: 'n', driveUrl: null } });

type Props = Parameters<typeof DocumentChooser>[0];
let rerender: (ui: preact.ComponentChild) => void;
function renderChooser(mode: 'combine' | 'file-with', over: Partial<Props> = {}) {
  const props: Props = {
    mode,
    current: letter,
    review: [letter, receipt, bill],
    filed: [filed],
    busy: false,
    run: async (fn) => {
      try {
        await fn();
        return null;
      } catch (error) {
        return { error };
      }
    },
    onCombine: vi.fn(async () => {}),
    onFileWith: vi.fn(async () => {}),
    onCancel: vi.fn(),
    ...over,
  };
  const r = render(<DocumentChooser {...props} />);
  rerender = r.rerender;
  return props;
}
const order = () => within(screen.getByRole('list', { name: 'Order' })).getAllByRole('listitem').map((li) => li.textContent);

describe('DocumentChooser: combine', () => {
  it('pins the current card first and combines in the chosen order', async () => {
    const p = renderChooser('combine');
    expect(screen.getByRole('button', { name: /^Combine/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    expect(order()).toEqual([
      expect.stringContaining('Certified letter'),
      expect.stringContaining('Water bill'),
      expect.stringContaining('Return receipt'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Return receipt up' }));
    expect(screen.getByRole('status')).toHaveTextContent('Return receipt is now position 2');
    expect(screen.getByRole('button', { name: 'Move Return receipt up' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Move Certified letter up' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Combine 3' }));
    await waitFor(() => expect(p.onCombine).toHaveBeenCalledWith([letter.id, receipt.id, bill.id]));
  });

  it('moves a part down', () => {
    renderChooser('combine');
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Return receipt down' }));
    expect(order()).toEqual([
      expect.stringContaining('Certified letter'),
      expect.stringContaining('Water bill'),
      expect.stringContaining('Return receipt'),
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Return receipt is now position 3');
    expect(screen.getByRole('button', { name: 'Move Return receipt down' })).toHaveFocus();
  });

  it('refocuses the button each time the same item moves the same way', () => {
    const three = makeDoc({ analysis: { ...makeDoc().analysis!, name: 'Gas bill' } });
    renderChooser('combine', { review: [letter, receipt, bill, three] });
    for (const n of [/Return receipt/, /Water bill/, /Gas bill/]) fireEvent.click(screen.getByRole('checkbox', { name: n }));
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      const up = () => screen.getByRole('button', { name: 'Move Gas bill up' });
      fireEvent.click(up());
      fireEvent.click(up());
      expect(order()[1]).toContain('Gas bill');
      expect(focus.mock.contexts.filter((c) => c === up())).toHaveLength(2);
      expect(up()).toHaveFocus();
    } finally {
      focus.mockRestore();
    }
  });

  it('keeps the edge buttons focusable, as aria-disabled no-ops', () => {
    renderChooser('combine');
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    const up = screen.getByRole('button', { name: 'Move Return receipt up' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    expect(up).not.toBeDisabled();
    fireEvent.click(up);
    expect(order()[1]).toContain('Return receipt');
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByRole('button', { name: 'Move Water bill down' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('names the part that cannot be combined', async () => {
    renderChooser('combine', {
      onCombine: vi.fn().mockRejectedValue(new ApiError('cannot_combine', 422, 'cannot_combine', { error: 'cannot_combine', documentId: receipt.id, reason: 'encrypted' })),
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('“Return receipt” can’t be combined: it is password-protected.');
  });

  it.each([
    [new ApiError('cannot_combine', 422, 'cannot_combine', { reason: 'too_large' }), 'These documents are too large to combine.'],
    [new ApiError('cannot_combine', 422, 'cannot_combine', { documentId: 'gone', reason: 'signed' }), 'One document can’t be combined: it is digitally signed.'],
    [new ApiError('possibly_in_drive', 409, 'possibly_in_drive'), 'This document may already be in Drive, so it can’t be changed.'],
    [new ApiError('invalid_input', 400, 'invalid_input'), 'Could not do that. Pick up to 10 documents and try again.'],
  ])('explains a refusal (%#)', async (err, text) => {
    renderChooser('combine', { onCombine: vi.fn().mockRejectedValue(err) });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('says the list is being updated on a conflict, and when the server is unreachable', async () => {
    const onCombine = vi.fn().mockRejectedValueOnce(new ApiError('conflict', 409, 'conflict')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderChooser('combine', { onCombine });
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something changed; the list is being updated.');
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server. Try again.'));
  });

  it('survives a checked part leaving review, and does not re-check it if it returns', async () => {
    const p = renderChooser('combine');
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    expect(screen.getByRole('button', { name: 'Combine 3' })).toBeEnabled();
    rerender(<DocumentChooser {...p} review={[letter, bill]} />);
    expect(order()).toEqual([expect.stringContaining('Certified letter'), expect.stringContaining('Water bill')]);
    rerender(<DocumentChooser {...p} review={[letter, receipt, bill]} />);
    expect(screen.getByRole('checkbox', { name: /Return receipt/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Water bill/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Water bill/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Return receipt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine 2' }));
    await waitFor(() => expect(p.onCombine).toHaveBeenCalledWith([letter.id, receipt.id]));
    rerender(<DocumentChooser {...p} review={[letter]} />);
    expect(screen.getByRole('button', { name: 'Combine 1' })).toBeDisabled();
  });

  it('says when a combine search matches nothing', () => {
    renderChooser('combine');
    expect(screen.queryByText('No matching documents.')).toBeNull();
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching documents.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Documents in review' })).toBeNull();
  });

  it('stops at 10 documents', () => {
    const many = Array.from({ length: 11 }, (_, i) => makeDoc({ analysis: { ...makeDoc().analysis!, name: `Part ${i}` } }));
    renderChooser('combine', { current: letter, review: [letter, ...many] });
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Part ${i} ·`) }));
    expect(screen.getByText('Up to 10 documents can be combined.', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Up to 10 documents can be combined.');
    expect(screen.getByRole('checkbox', { name: /Part 9 ·/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Part 0 ·/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Part 0 ·/ }));
    expect(screen.queryByText('Up to 10 documents can be combined.')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByRole('checkbox', { name: /Part 9 ·/ })).toBeEnabled();
  });

  it('disables everything while busy', () => {
    renderChooser('combine', { busy: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Return receipt/ })).toBeDisabled();
  });

  it('closes on Escape', () => {
    const p = renderChooser('combine');
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search documents' }), { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalled();
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

  it('says when a search matches nothing, and when there is nothing to file with', () => {
    renderChooser('file-with');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching documents.')).toBeInTheDocument();
    expect(screen.queryByText('No documents to file with.')).toBeNull();
  });

  it('says when there is nothing to file with', () => {
    renderChooser('file-with', { review: [letter], filed: [] });
    expect(screen.getByText('No documents to file with.')).toBeInTheDocument();
  });

  it('explains an anchor that can’t be used', async () => {
    renderChooser('file-with', { onFileWith: vi.fn().mockRejectedValue(new ApiError('invalid_anchor', 409, 'invalid_anchor')) });
    fireEvent.click(screen.getByRole('button', { name: /Lease\.pdf/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That document can’t be used. Pick another.');
  });

  it('cancels, and closes on Escape', () => {
    const p = renderChooser('file-with');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search documents' }), { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalledTimes(2);
  });
});
