import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { SavedScansScreen } from '../../src/ui/SavedScansScreen.js';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

let store: ScansStore;

beforeEach(async () => {
  cleanup();
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

const Q: Quad = { tl: {x:0,y:0}, tr: {x:1,y:0}, bl: {x:0,y:1}, br: {x:1,y:1} };
const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });

describe('SavedScansScreen', () => {
  it('shows empty state when no scans', async () => {
    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no saved scans/i)).toBeInTheDocument());
  });

  it('lists completed scans with page count', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);

    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/2 pages/i)).toBeInTheDocument());
  });

  it('delete removes the scan', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blob('p'), Q);
    await store.finish(id);
    window.confirm = vi.fn().mockReturnValue(true);

    render(<SavedScansScreen store={store} onBack={() => {}} onNewScan={() => {}} onView={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 page/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(screen.getByText(/no saved scans/i)).toBeInTheDocument());
  });
});
