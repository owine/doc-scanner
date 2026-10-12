import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/preact';
import type { ScansStore } from '../../src/scanner/scans-store.js';
import type { Scan } from '../../src/scanner/types.js';
import { UploadQueue } from '../../src/uploads/queue.js';
import { useDeviceScans } from '../../src/uploads/scans.js';
import type { UploadStorage } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';

// Every state update the hooks make, so a late one after unmount shows up:
// Preact drops it silently, so nothing else in the DOM would.
const updates = vi.hoisted(() => [] as unknown[]);
vi.mock('preact/hooks', async (importOriginal) => {
  const hooks = await importOriginal<typeof import('preact/hooks')>();
  return {
    ...hooks,
    useState: (initial: unknown) => {
      const [value, set] = hooks.useState(initial);
      return [value, (next: unknown) => {
        updates.push(next);
        set(next);
      }];
    },
  };
});

class MemoryStore implements UploadStorage {
  items = new Map<string, UploadItem>();
  async all() { return [...this.items.values()]; }
  async put(i: UploadItem) { this.items.set(i.id, i); }
  async remove(id: string) { this.items.delete(id); }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const scan = (id: string): Scan => ({ id, status: 'completed', pageCount: 1, createdAt: 1, updatedAt: 1, thumbnailKey: null });

/** A store whose every listCompleted waits until the test answers it. */
function slowStore() {
  const reads: ReturnType<typeof deferred<Scan[]>>[] = [];
  const store = {
    open: vi.fn().mockResolvedValue(undefined),
    listCompleted: vi.fn(() => {
      const d = deferred<Scan[]>();
      reads.push(d);
      return d.promise;
    }),
  };
  return { store: store as unknown as ScansStore, reads };
}

const idleQueue = () => new UploadQueue({ store: new MemoryStore(), send: () => new Promise(() => {}) });

describe('useDeviceScans', () => {
  it('shows only the latest reload, whichever read finishes last', async () => {
    const { store, reads } = slowStore();
    const queue = idleQueue();
    const { result } = renderHook(() => useDeviceScans(store, queue));
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(() => queue.add([{ blob: new Blob(['x']), name: 'a.pdf', source: 'picker' }]));
    await waitFor(() => expect(reads.length).toBeGreaterThan(1));
    const latest = reads.at(-1)!;
    await act(async () => {
      latest.resolve([scan('new')]);
      await latest.promise;
    });
    await waitFor(() => expect(result.current.scans.map((s) => s.id)).toEqual(['new']));
    await act(async () => {
      for (const r of reads.slice(0, -1)) r.resolve([scan('stale')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.scans.map((s) => s.id)).toEqual(['new']);
  });

  it('sets nothing once unmounted', async () => {
    const { store, reads } = slowStore();
    const { unmount } = renderHook(() => useDeviceScans(store, idleQueue()));
    await waitFor(() => expect(reads).toHaveLength(1));
    unmount();
    updates.length = 0;
    await act(async () => {
      reads[0]!.resolve([scan('late')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(updates).toEqual([]);
  });

  it('keeps one reload across renders', async () => {
    const store = { open: vi.fn().mockResolvedValue(undefined), listCompleted: vi.fn().mockResolvedValue([scan('s1')]) } as unknown as ScansStore;
    const queue = idleQueue();
    const { result, rerender } = renderHook(() => useDeviceScans(store, queue));
    const first = result.current.reload;
    await waitFor(() => expect(result.current.scans.map((s) => s.id)).toEqual(['s1']));
    rerender();
    expect(result.current.reload).toBe(first);
  });
});
