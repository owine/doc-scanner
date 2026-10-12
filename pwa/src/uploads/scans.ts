import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';
import type { UploadQueue } from './queue.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** "Scan 2026-10-12 09.05.pdf", in local time. The analyzer names it properly. */
export function scanFileName(at: Date): string {
  return `Scan ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.pdf`;
}

/**
 * Queues a finished scan as one image-only PDF, named by when it was scanned:
 * the analyzer reads the name, so a scan sent months later keeps its own date.
 * Its local copy is deleted once the server has it (App). If the PDF can't be
 * built (say, its chunk can't load while offline), the scan stays on the
 * device and shows under "Scans on this device".
 */
export async function sendScanToInbox(store: ScansStore, queue: UploadQueue, scanId: string): Promise<void> {
  await queue.addScan(scanId, async () => {
    const scan = await store.get(scanId);
    if (!scan) throw new Error('the scan is no longer on this device');
    // Loaded on demand: pdf-lib is most of the bundle, and only a finished scan needs it.
    const { buildImagePdf } = await import('../pdf/build.js');
    const pages = await store.getPages(scanId);
    return { blob: await buildImagePdf(pages.map((p) => p.blob)), name: scanFileName(new Date(scan.createdAt)), source: 'scanner' };
  });
}

/**
 * Finished scans still on this device that are not already on their way:
 * saved before scans went to the server, or left behind when building their
 * PDF failed.
 */
export function useDeviceScans(store: ScansStore, queue: UploadQueue): { scans: Scan[]; reload: () => Promise<void> } {
  const [all, setAll] = useState<Scan[]>([]);
  // Reads can finish out of order: only the latest one's list is shown.
  const latest = useRef(0);
  // Set in a layout-effect cleanup: an effect cleanup can run after paint, too late to stop a read landing.
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    const read = ++latest.current;
    let scans: Scan[];
    try {
      await store.open(); // App's open, shared: this waits for it rather than racing it
      scans = await store.listCompleted();
    } catch {
      scans = [];
    }
    if (mounted.current && read === latest.current) setAll(scans);
  }, [store]);
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
  }, [reload, queue]);
  return { scans: all.filter((s) => !queue.hasScan(s.id)), reload };
}
