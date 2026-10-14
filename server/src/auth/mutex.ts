/**
 * Runs async work one call at a time, in arrival order. Each call does its
 * own work when its turn comes and gets its own result: a call never
 * receives another's (passkey-unlock spec, Concurrency). Sharing results
 * could turn a wrong password into a success.
 */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => fn());
    // The next call waits for this one to settle, however it ends.
    this.#tail = result.catch(() => {});
    return result;
  }
}
