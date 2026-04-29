/**
 * Wraps mailbox password bytes so they cannot be accidentally serialized,
 * logged, or returned. Public surface is intentionally minimal: callers must
 * use `.use(fn)` to get scoped access to the underlying bytes, then explicitly
 * `.dispose()` when no longer needed.
 *
 * This is a runtime guard in addition to the discipline of never persisting
 * mailbox passwords (Phase 2 design decision: memory-only).
 */
export class MailboxSecret {
  // Private; no getter exposed. The bytes are only accessible via `use(fn)`.
  readonly #bytes: Uint8Array;
  #disposed = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async use<T>(fn: (bytes: Uint8Array) => Promise<T> | T): Promise<T> {
    if (this.#disposed) throw new Error('MailboxSecret: already disposed');
    return await fn(this.#bytes);
  }

  dispose(): void {
    this.#bytes.fill(0);
    this.#disposed = true;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}
