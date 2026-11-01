/**
 * The run-wide cap on active callee turns (`Team.maxActiveTurns`). Callee
 * turns draw from their own gate, never from the pool members' own turns start in —
 * a sync caller blocked on its callee holds a slot there, so sharing one pool would
 * deadlock a full level of sync callers (every slot a caller, none left for
 * their callees).
 *
 * Only STARTING a fresh turn waits. A turn counts against the cap while it
 * works and stops counting while it is blocked ({@link TurnSlot.block}) — on
 * its own calls, its own question or an approval card — because a blocked
 * turn that held its slot could leave every slot held by turns waiting on
 * turns that cannot start. A blocked turn that resumes, and a wake that
 * serves calls already running, are counted again at once rather than queued
 * ({@link TurnSemaphore.admit}): queuing them is the same deadlock one step
 * later. The cap can therefore be overshot, by at most the blocked turns
 * that resume plus the wakes admitted while it is full.
 */
export interface TurnSemaphore {
  /**
   * Resolves with a slot once the turn may start, in arrival order; resolves
   * null when `signal` aborts first, the waiter leaving the queue.
   */
  acquire(signal?: AbortSignal): Promise<TurnSlot | null>;
  /**
   * A slot now if one is free, else null. Never jumps the queue: a freed slot
   * goes straight to the next waiter, so none is free while anyone waits.
   */
  tryAcquire(): TurnSlot | null;
  /** A slot now, over the cap if need be — never queued. */
  admit(): TurnSlot;
  /** Turns counted against the cap right now. */
  active(): number;
  /** Fresh turns waiting to start. */
  queued(): number;
}

/** One turn's hold on the gate. */
export interface TurnSlot {
  /**
   * Stop counting this turn while it is blocked. Nests: the slot is given
   * back on the first block and taken again on the matching last unblock.
   */
  block(): void;
  /** Count the turn again — at once, over the cap if need be. */
  unblock(): void;
  /** The turn is over. Idempotent — a double call must not mint a slot. */
  release(): void;
}

export function createTurnSemaphore(slots: number): TurnSemaphore {
  let active = 0;
  const waiters: ((slot: TurnSlot) => void)[] = [];

  const pump = (): void => {
    while (active < slots && waiters.length > 0) {
      active += 1;
      waiters.shift()!(makeSlot());
    }
  };

  /** A slot already counted in `active`. */
  const makeSlot = (): TurnSlot => {
    let counted = true;
    let blocks = 0;
    let released = false;
    return {
      block(): void {
        if (released) {
          return;
        }
        blocks += 1;
        if (blocks === 1 && counted) {
          counted = false;
          active -= 1;
          pump();
        }
      },
      unblock(): void {
        if (released || blocks === 0) {
          return;
        }
        blocks -= 1;
        if (blocks === 0) {
          counted = true;
          active += 1;
        }
      },
      release(): void {
        if (released) {
          return;
        }
        released = true;
        if (counted) {
          counted = false;
          active -= 1;
          pump();
        }
      },
    };
  };

  return {
    acquire(signal?: AbortSignal): Promise<TurnSlot | null> {
      const now = this.tryAcquire();
      if (now !== null) {
        return Promise.resolve(now);
      }
      if (signal?.aborted) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const waiter = (slot: TurnSlot): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve(slot);
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          resolve(null);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    tryAcquire(): TurnSlot | null {
      if (active >= slots) {
        return null;
      }
      active += 1;
      return makeSlot();
    },
    admit(): TurnSlot {
      active += 1;
      return makeSlot();
    },
    active: () => active,
    queued: () => waiters.length,
  };
}
