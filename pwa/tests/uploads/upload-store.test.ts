import { describe, it, expect } from 'vitest';
import { UploadStore } from '../../src/uploads/upload-store.js';
import type { UploadItem } from '../../src/uploads/types.js';

const item = (id: string, createdAt: number): UploadItem => ({
  id, name: `${id}.pdf`, size: 3, blob: new Blob(['abc'], { type: 'application/pdf' }), source: 'picker',
  scanId: null, createdAt, attempts: 0, state: 'queued', error: null, nextAttemptAt: 0,
});

describe('UploadStore', () => {
  it('keeps items, oldest first, until removed', async () => {
    const store = new UploadStore();
    await store.put(item('b', 2));
    await store.put(item('a', 1));
    expect((await store.all()).map((i) => i.id)).toEqual(['a', 'b']);
    await store.remove('a');
    expect((await store.all()).map((i) => i.id)).toEqual(['b']);
  });

  it('keeps the file bytes', async () => {
    const store = new UploadStore();
    await store.put(item('a', 1));
    const [got] = await store.all();
    expect(await got!.blob.text()).toBe('abc');
  });
});
