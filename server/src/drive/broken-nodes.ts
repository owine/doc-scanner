import { AbortError, ConnectionError, ProtonDriveError, ServerError } from '@protontech/drive-sdk';

/**
 * The leaf errors behind an SDK wrapper: `cause` may be an error or an array
 * of them, and wrappers can nest.
 */
function leafErrors(error: unknown): unknown[] {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause === undefined || cause === null) return [];
  const out: unknown[] = [];
  for (const c of Array.isArray(cause) ? cause : [cause]) {
    const inner = leafErrors(c);
    if (inner.length > 0) out.push(...inner);
    else out.push(c);
  }
  return out;
}

/**
 * The SDK's `iterateNodes` yields every node it can load, then throws a base
 * ProtonDriveError wrapping whatever failed. Returns normally when every
 * cause is a per-node problem (an undecryptable or missing node), so the
 * caller can skip those nodes and keep what was yielded. Otherwise throws:
 * the first transport leaf (ServerError incl. 401/429, ConnectionError,
 * AbortError), or `error` itself when it is not that wrapper or wraps nothing.
 */
export function rethrowUnlessBrokenNodes(error: unknown): void {
  if (error?.constructor !== ProtonDriveError) throw error;
  const leaves = leafErrors(error);
  const transport = leaves.find((e) => e instanceof ServerError || e instanceof ConnectionError || e instanceof AbortError);
  if (transport !== undefined) throw transport;
  if (leaves.length === 0) throw error;
}
