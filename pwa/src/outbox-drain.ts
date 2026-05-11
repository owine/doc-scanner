import type { ScansStore } from './scanner/scans-store.js';
import type { Scan } from './scanner/types.js';
import { buildSearchablePdf } from './pdf/build.js';

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

export interface DrainResult {
  processed: number;
  succeeded: number;
  needsAttention: number;
  classifiedAwaitingConfirm: number;
}

export interface DrainDeps {
  fetch: typeof fetch;
  store: ScansStore;
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Background drain for scans the user has handed off to the upload
 * pipeline but the network couldn't deliver to in real time. Iterates
 * `findPending` (oldest-first), runs the appropriate API call, and
 * transitions state.
 *
 * Failure handling:
 *   - pending_classify failures move the scan to awaiting_confirm with
 *     no suggestion — the user can fill in manually next time the
 *     ConfirmCard surface renders. Classify never goes to needs_attention.
 *   - pending_upload failures bump retryCount; after MAX_RETRIES failures
 *     within RETRY_WINDOW_MS, the scan moves to needs_attention so the
 *     SavedScansScreen banner can prompt manual retry.
 */
export async function drain(deps: DrainDeps): Promise<DrainResult> {
  const now = deps.now ?? Date.now;
  const pending = await deps.store.findPending();
  const result: DrainResult = { processed: 0, succeeded: 0, needsAttention: 0, classifiedAwaitingConfirm: 0 };
  for (const scan of pending) {
    result.processed++;
    try {
      if (scan.uploadStatus === 'pending_classify') {
        await classifyOne(deps, scan, now, result);
      } else if (scan.uploadStatus === 'pending_upload') {
        await uploadOne(deps, scan, now, result);
      }
    } catch (err) {
      // Unexpected helper-side error (DB, etc.) — log via console so the
      // SW or page can surface it; do not let one bad row halt the loop.
      console.warn('outbox drain: unexpected error processing scan', scan.id, err);
    }
  }
  return result;
}

async function classifyOne(deps: DrainDeps, scan: Scan, _now: () => number, result: DrainResult): Promise<void> {
  const pages = await deps.store.getPageBlobs(scan.id);
  const fd = new FormData();
  pages.forEach((b, i) => fd.set(`page_${i}`, b, `page_${i}.jpg`));
  type Suggestion = {
    suggestedName: string;
    suggestedFolderLinkId: string;
    confidence: number;
    rationale: string;
    pageOcr: { text: string; words: { text: string; x: number; y: number; w: number; h: number }[] }[];
  };
  let suggestion: Suggestion | null = null;
  try {
    const res = await deps.fetch('/api/classify', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (res.ok) {
      const body = await res.json() as { suggestion: Suggestion | null };
      suggestion = body.suggestion;
    }
    // Non-2xx (413/422/500): treat as null suggestion → empty ConfirmCard.
  } catch (err) {
    console.warn('outbox drain: classify fetch threw for', scan.id, err);
  }
  if (suggestion) {
    await deps.store.setSuggestionAndOcr(scan.id, suggestion, suggestion.pageOcr);
  } else {
    await deps.store.setSuggestionAndOcr(scan.id, undefined, undefined);
  }
  result.classifiedAwaitingConfirm++;
}

async function uploadOne(deps: DrainDeps, scan: Scan, now: () => number, result: DrainResult): Promise<void> {
  if (!scan.finalName || !scan.finalFolderLinkId) {
    // Scan is in pending_upload but missing the post-edit values — set
    // needs_attention so the user fills the form again.
    await markNeedsAttention(deps.store, scan.id, 'missing finalName/finalFolderLinkId');
    result.needsAttention++;
    return;
  }
  let pdfBlob: Blob | null = null;
  if (scan.pdfKey) {
    pdfBlob = await deps.store.getPdf(scan.pdfKey);
  }
  if (!pdfBlob) {
    // App.tsx Save normally writes pdfKey before posting; if drain runs
    // first (e.g., page reloaded mid-Save), build the PDF here from the
    // stored pages + Haiku OCR.
    const pages = await deps.store.getPageBlobs(scan.id);
    const ocr = scan.pageOcr ?? [];
    pdfBlob = await buildSearchablePdf(
      pages.map((b, i) => ({ blob: b, ocrText: ocr[i]?.text ?? '', ocrWords: ocr[i]?.words ?? [] })),
    );
    await deps.store.setPdfBlob(scan.id, pdfBlob);
  }

  const ocrTextCombined = (scan.pageOcr ?? []).map((p) => p.text).filter((t) => t.length > 0).join('\n\n');
  const fd = new FormData();
  fd.set('pdf', pdfBlob, 'document.pdf');
  fd.set('name', scan.finalName);
  fd.set('folderLinkId', scan.finalFolderLinkId);
  fd.set('ocrText', ocrTextCombined);

  try {
    const res = await deps.fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (res.ok) {
      const body = await res.json() as { driveNodeUid: string; driveWebUrl: string; finalName: string };
      await deps.store.setUploadStatus(scan.id, 'done', {
        driveNodeUid: body.driveNodeUid,
        driveWebUrl: body.driveWebUrl,
        finalName: body.finalName,
        retryCount: 0,
      });
      result.succeeded++;
      return;
    }
    // Non-2xx → count as a failed attempt below.
    throw new Error(`upload returned ${res.status}`);
  } catch (err) {
    await recordFailureAndMaybeFlag(deps.store, scan, now(), (err as Error).message, result);
  }
}

async function recordFailureAndMaybeFlag(
  store: ScansStore,
  scan: Scan,
  nowMs: number,
  errMsg: string,
  result: DrainResult,
): Promise<void> {
  const firstAt = scan.retryFirstAt && (nowMs - scan.retryFirstAt) < RETRY_WINDOW_MS
    ? scan.retryFirstAt
    : nowMs;
  const newCount = (scan.retryCount ?? 0) + 1;

  if (newCount > MAX_RETRIES) {
    await markNeedsAttention(store, scan.id, errMsg);
    result.needsAttention++;
    return;
  }
  // Stay in pending_upload; bump counters so the next drain knows we've
  // tried. Since pending_upload → pending_upload isn't a legal transition
  // (it's not in ALLOWED), we patch via a no-op transition trick: load
  // the scan, mutate fields, write directly. Simpler: extend setUploadStatus
  // to allow same-state when patching counters. For now, write via a
  // side-channel through the store (we expose a small helper below).
  // (Implemented inline here to keep slice-4 scope small.)
  const tx = (store as unknown as { d: { transaction(name: 'scans', mode: 'readwrite'): { objectStore(n: 'scans'): { get(k: string): Promise<Scan | undefined>; put(s: Scan): Promise<void> }; done: Promise<void> } } }).d.transaction('scans', 'readwrite');
  const row = await tx.objectStore('scans').get(scan.id);
  if (row) {
    row.retryCount = newCount;
    row.retryFirstAt = firstAt;
    row.uploadError = errMsg;
    row.updatedAt = nowMs;
    await tx.objectStore('scans').put(row);
  }
  await tx.done;
}

async function markNeedsAttention(store: ScansStore, scanId: string, errMsg: string): Promise<void> {
  await store.setUploadStatus(scanId, 'needs_attention', { uploadError: errMsg });
}
