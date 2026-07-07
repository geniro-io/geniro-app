/**
 * In-process asynchronous mutex per string key — the `.cursor/mcp.json`
 * write lock, keyed by cwd. In-process is sufficient by design: the daemon is
 * the only writer of the geniro entry, so cross-process locking would guard
 * against a writer that cannot exist. Waiting is BOUNDED — a caller that
 * cannot get the key within `waitMs` receives null and degrades, which also
 * breaks the deadlock where a lock-holding cursor caller synchronously waits
 * on a callee that needs the same cwd's lock.
 */
export class KeyedMutex {
  /** Tail of each key's wait chain; absent = key free. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Acquire `key`, waiting at most `waitMs` for the current holder(s).
   * Resolves with an idempotent release function, or null on timeout — a
   * timed-out waiter vacates its place in the chain, so later waiters never
   * queue behind a ghost.
   */
  async acquire(key: string, waitMs: number): Promise<(() => void) | null> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let releaseSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    const tail = prev.then(() => slot);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    const acquired = await Promise.race([
      prev.then(() => true as const),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs);
        timer.unref?.();
      }),
    ]);
    if (!acquired) {
      releaseSlot();
      return null;
    }
    let released = false;
    return () => {
      if (!released) {
        released = true;
        releaseSlot();
      }
    };
  }
}
