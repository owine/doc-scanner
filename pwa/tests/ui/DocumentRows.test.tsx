import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { DiscardedRow, FailedRow, FiledRow, WaitingRow } from '../../src/ui/inbox/DocumentRows.js';
import { makeDoc } from '../documents/fixtures.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');

describe('DocumentRows', () => {
  it('says a discarded part was combined into another document, and still offers Restore', () => {
    const doc = makeDoc({ state: 'discarded', discardedAt: NOW.toISOString(), combinedInto: 'c1' });
    render(<ul><DiscardedRow doc={doc} now={NOW} onRestore={vi.fn()} /></ul>);
    expect(screen.getByText(/Combined into another document · Deleted in 7 days/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('shows a plain discard as before', () => {
    const doc = makeDoc({ state: 'discarded', discardedAt: NOW.toISOString() });
    render(<ul><DiscardedRow doc={doc} now={NOW} onRestore={vi.fn()} /></ul>);
    expect(screen.getByText('Deleted in 7 days')).toBeInTheDocument();
  });

  it('says what a waiting document is being filed with', () => {
    render(<ul><WaitingRow doc={makeDoc({ state: 'analyzing', anchorName: 'Certified letter' })} onDiscard={vi.fn()} /></ul>);
    expect(screen.getByText('Paired with “Certified letter”')).toBeInTheDocument();
  });
});

describe('row state dots', () => {
  const noop = async () => {};
  const filedDoc = makeDoc({ state: 'filed', filed: { name: 'Lease.pdf', folderPath: '/Home', driveNodeUid: 'n', driveUrl: null } });
  it.each([
    ['waiting', () => <WaitingRow doc={makeDoc({ state: 'analyzing' })} onDiscard={noop} />, 'work'],
    ['filed', () => <FiledRow doc={filedDoc} />, 'ok'],
    ['failed', () => <FailedRow doc={makeDoc({ state: 'failed' })} onRetry={noop} onDiscard={noop} />, 'bad'],
    ['discarded', () => <DiscardedRow doc={makeDoc({ state: 'discarded', discardedAt: '2026-10-10T12:00:00.000Z' })} now={new Date('2026-10-10T12:00:00.000Z')} onRestore={noop} />, 'idle'],
  ] as const)('marks a %s row, hidden from assistive tech', (_, row, kind) => {
    const { container } = render(<ul>{row()}</ul>);
    const dot = container.querySelector(`.state-dot--${kind}`);
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });
});
