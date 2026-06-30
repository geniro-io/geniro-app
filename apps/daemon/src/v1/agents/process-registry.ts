import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import type { ExecutorHandle } from './executor.types';

/**
 * Tracks the in-flight turn (one per run for single-agent M2) so spawned CLI
 * processes can be terminated on cancel and — crucially — on daemon shutdown.
 *
 * The M1 shutdown path only removes the pidfile; nothing kills grandchildren,
 * and the UI's `SIGKILL` escalation bypasses Nest hooks. `OnApplicationShutdown`
 * runs on the graceful `SIGTERM` path (the normal case), so cancelling every
 * active handle here stops `claude -p` / `cursor-agent -p` orphaning mid-turn.
 *
 * A run slot is reserved with {@link tryClaim} BEFORE the chat service does any
 * async work, then upgraded to the real handle by {@link register}. The claim
 * closes the check-then-act window between "is a turn running?" and "start the
 * turn": without it two concurrent messages on one run would both pass a plain
 * `has()` check, allocate overlapping `seq` values, and spawn two CLIs. A
 * `null` value means "claimed, process not started yet".
 */
@Injectable()
export class ProcessRegistry implements OnApplicationShutdown {
  private readonly active = new Map<string, ExecutorHandle | null>();

  /**
   * Atomically reserve the run if no turn is in flight or already claimed.
   * Returns false when the run is busy. Synchronous, so concurrent callers
   * cannot both win.
   */
  tryClaim(runId: string): boolean {
    if (this.active.has(runId)) {
      return false;
    }
    this.active.set(runId, null);
    return true;
  }

  /** Release a claim taken by {@link tryClaim} when the turn fails to start. */
  release(runId: string): void {
    if (this.active.get(runId) === null) {
      this.active.delete(runId);
    }
  }

  /** Upgrade a claim to the live handle; it auto-unregisters once it settles. */
  register(runId: string, handle: ExecutorHandle): void {
    this.active.set(runId, handle);
    void handle.done.finally(() => {
      // Only clear if this exact handle is still the registered one — a fast
      // restart could have replaced it before the old `done` settled.
      if (this.active.get(runId) === handle) {
        this.active.delete(runId);
      }
    });
  }

  /** True when a turn is claimed or in flight for the run. */
  has(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Cancel the in-flight turn for a run; returns false if none is active (or it
   * is only claimed, with no process spawned yet).
   */
  cancel(runId: string): boolean {
    const handle = this.active.get(runId);
    if (!handle) {
      return false;
    }
    handle.cancel();
    return true;
  }

  /** Cancel every in-flight turn (graceful-shutdown handler). */
  onApplicationShutdown(): void {
    for (const handle of this.active.values()) {
      handle?.cancel();
    }
    this.active.clear();
  }
}
