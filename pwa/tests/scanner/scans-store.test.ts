import { describe, it, expect, beforeEach } from 'vitest';
import { ScansStore } from '../../src/scanner/scans-store.js';
import type { Quad } from '../../src/scanner/types.js';

const Q: Quad = { tl: {x:0,y:0}, tr: {x:100,y:0}, bl: {x:0,y:100}, br: {x:100,y:100} };

function blobOf(text: string): Blob { return new Blob([text], { type: 'image/jpeg' }); }

let store: ScansStore;

beforeEach(async () => {
  indexedDB.deleteDatabase('docscanner');
  store = new ScansStore();
  await store.open();
});

describe('ScansStore', () => {
  it('createInProgress + appendPage + finish flow', async () => {
    const id = await store.createInProgress();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const ord = await store.appendPage(id, blobOf('p1'), Q);
    expect(ord).toBe(0);
    await store.appendPage(id, blobOf('p2'), Q);

    const beforeFinish = await store.findInProgress();
    expect(beforeFinish?.id).toBe(id);
    expect(beforeFinish?.pageCount).toBe(2);
    expect(beforeFinish?.thumbnailKey).toBeNull();

    await store.finish(id);
    const list = await store.listCompleted();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(id);
    expect(list[0]!.status).toBe('completed');
    expect(list[0]!.thumbnailKey).not.toBeNull();
    expect(await store.findInProgress()).toBeNull();
  });

  it('updatePage replaces blob + quad at ordinal', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.appendPage(id, blobOf('p2-old'), Q);
    const newQ: Quad = { ...Q, tl: { x: 10, y: 10 } };
    await store.updatePage(id, 1, blobOf('p2-new'), newQ);
    const pages = await store.getPages(id);
    expect(pages[1]!.quad.tl).toEqual({ x: 10, y: 10 });
    expect(await pages[1]!.blob.text()).toBe('p2-new');
  });

  it('delete cascades pages and thumbnail', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    await store.delete(id);
    expect(await store.listCompleted()).toEqual([]);
    expect(await store.getPages(id)).toEqual([]);
  });

  it('listCompleted is sorted by updatedAt desc', async () => {
    const a = await store.createInProgress();
    await store.appendPage(a, blobOf('a'), Q);
    await store.finish(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createInProgress();
    await store.appendPage(b, blobOf('b'), Q);
    await store.finish(b);

    const list = await store.listCompleted();
    expect(list.map((s) => s.id)).toEqual([b, a]);
  });

  it('only one in-progress scan at a time', async () => {
    const a = await store.createInProgress();
    const b = await store.createInProgress();
    const found = await store.findInProgress();
    expect(found?.id).toBe(b);
    expect(await store.getPages(a)).toEqual([]);
  });

  it('getThumbnailBlob returns the saved thumb', async () => {
    const id = await store.createInProgress();
    await store.appendPage(id, blobOf('p1'), Q);
    await store.finish(id);

    const list = await store.listCompleted();
    const thumb = await store.getThumbnailBlob(list[0]!.thumbnailKey!);
    expect(thumb).toBeInstanceOf(Blob);
  });

  it('appendPage propagates QuotaExceededError from the underlying transaction', async () => {
    const id = await store.createInProgress();
    // Wrap db.transaction so its put rejects with a synthetic quota error.
    const realTx = (store as any).db.transaction.bind((store as any).db);
    (store as any).db.transaction = (...args: any[]) => {
      const tx = realTx(...args);
      const realStore = tx.objectStore.bind(tx);
      tx.objectStore = (name: string) => {
        const os = realStore(name);
        if (name === 'pages') {
          os.put = () => Promise.reject(new DOMException('quota exceeded', 'QuotaExceededError'));
        }
        return os;
      };
      return tx;
    };
    await expect(store.appendPage(id, blobOf('p1'), Q)).rejects.toThrow(/quota/i);
    (store as any).db.transaction = realTx;
  });
});
