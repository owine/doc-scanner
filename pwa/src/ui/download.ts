import { ScansStore } from '../scanner/scans-store.js';
import type { Scan } from '../scanner/types.js';

export async function downloadPdf(s: Scan, store: ScansStore): Promise<void> {
  if (!s.pdfKey) return;
  const blob = await store.getPdf(s.pdfKey);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scan-${new Date(s.updatedAt).toISOString().replace(/[:.]/g, '-')}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}
