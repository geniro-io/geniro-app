import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import type { AgentTurnHandle } from '../adapters/adapter.types';

/** Max time graceful shutdown waits for cancelled children to exit before clearing. */
const SHUTDOWN_DRAIN_MS = 5000;

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
  private readonly active = new Map<string, AgentTurnHandle | null>();
  /**
   * Runs whose cancel arrived during the claim→register window (no live handle
   * yet). {@link register} consults this so a Stop pressed in that window isn't a
   * silent no-op — it cancels the turn the moment its process is registered.
   */
  private readonly cancelRequested = new Set<string>();

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
      this.cancelRequested.delete(runId);
    }
  }

  /** Upgrade a claim to the live handle; it auto-unregisters once it settles. */
  register(runId: string, handle: AgentTurnHandle): void {
    this.active.set(runId, handle);
    // A cancel that landed during the claim→register window applies now, so the
    // just-spawned CLI is killed instead of running on after the user hit Stop.
    if (this.cancelRequested.delete(runId)) {
      handle.cancel();
    }
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
   * Cancel the in-flight turn for a run. Returns false only when nothing is
   * tracked for the run; a claimed-but-not-yet-registered run records the intent
   * (see {@link cancelRequested}) and returns true, so the caller can tell the
   * user the cancel was accepted rather than silently dropped.
   */
  cancel(runId: string): boolean {
    const handle = this.active.get(runId);
    if (handle) {
      handle.cancel();
      return true;
    }
    if (this.active.has(runId)) {
      this.cancelRequested.add(runId);
      return true;
    }
    return false;
  }

  /**
   * Cancel every in-flight turn on graceful shutdown and await child exit, so the
   * daemon does not exit before its CLI children (and their grandchildren) die.
   * Bounded by {@link SHUTDOWN_DRAIN_MS} so a wedged child can't hang shutdown —
   * `cancel()` already escalates SIGTERM→SIGKILL inside that window.
   */
  async onApplicationShutdown(): Promise<void> {
    const live = [...this.active.values()].filter(
      (handle): handle is AgentTurnHandle => handle !== null,
    );
    for (const handle of live) {
      handle.cancel();
    }
    if (live.length > 0) {
      const drained = Promise.allSettled(live.map((handle) => handle.done));
      const deadline = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        timer.unref?.();
      });
      await Promise.race([drained, deadline]);
    }
    this.active.clear();
    this.cancelRequested.clear();
  }
}
