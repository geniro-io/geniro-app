/**
 * Minimal counting semaphore for callee sub-turn slots. Sub-turns draw from
 * their own pool, never from `MAX_PARALLEL_NODES` — a sync caller blocked on
 * its callee holds a DAG slot, so sharing one pool would deadlock a full
 * level of sync callers (four callers, zero slots left for their callees).
 */
export interface TurnSemaphore {
  /** Resolves with a release function once a slot frees up. */
  acquire(): Promise<() => void>;
}

export function createTurnSemaphore(slots: number): TurnSemaphore {
  let free = slots;
  const waiters: ((release: () => void) => void)[] = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) {
        return; // release is idempotent — a double call must not mint a slot
      }
      released = true;
      const next = waiters.shift();
      if (next) {
        next(makeRelease());
      } else {
        free += 1;
      }
    };
  };

  return {
    acquire(): Promise<() => void> {
      if (free > 0) {
        free -= 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
