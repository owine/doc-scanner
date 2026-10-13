import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { DiscardedRow, WaitingRow } from '../../src/ui/inbox/DocumentRows.js';
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
