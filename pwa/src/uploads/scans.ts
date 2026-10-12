import { useEffect, useState } from 'preact/hooks';
import type { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';
import type { UploadQueue } from './queue.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** "Scan 2026-10-12 09.05.pdf", in local time. The analyzer names it properly. */
export function scanFileName(at: Date): string {
  return `Scan ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.pdf`;
}

/**
 * Queues a finished scan as one image-only PDF. Its local copy is deleted once
 * the server has it (App). If the PDF can't be built (say, its chunk can't load
 * while offline), the scan stays on the device and shows under "Scans on this
 * device".
 */
export async function sendScanToInbox(store: ScansStore, queue: UploadQueue, scanId: string, at = new Date()): Promise<void> {
  await queue.addScan(scanId, async () => {
    // Loaded on demand: pdf-lib is most of the bundle, and only a finished scan needs it.
    const { buildImagePdf } = await import('../pdf/build.js');
    const pages = await store.getPages(scanId);
    return { blob: await buildImagePdf(pages.map((p) => p.blob)), name: scanFileName(at), source: 'scanner' };
  });
}

/**
 * Finished scans still on this device that are not already on their way:
 * saved before scans went to the server, or left behind when building their
 * PDF failed.
 */
export function useDeviceScans(store: ScansStore, queue: UploadQueue): { scans: Scan[]; reload: () => Promise<void> } {
  const [all, setAll] = useState<Scan[]>([]);
  const reload = async () => {
    try {
      await store.open(); // App's open, shared: this waits for it rather than racing it
      setAll(await store.listCompleted());
    } catch {
      setAll([]);
    }
  };
  useEffect(() => {
    void reload();
    // Reload when the queue's items change (an upload finished, and its scan
    // was deleted), not on every progress tick.
    let seen = queue.list();
    return queue.subscribe(() => {
      if (queue.list() === seen) return;
      seen = queue.list();
      void reload();
    });
  }, [store, queue]);
  return { scans: all.filter((s) => !queue.hasScan(s.id)), reload };
}
