import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';

/** Why a command action was ended early: its run was archived or deleted, or the daemon is stopping. */
export type ActionCommandAbortReason = 'run' | 'shutdown';

/**
 * How long after a run's commands were ended a new one of it still starts
 * already ended: a press that passed its archived check just before the
 * archive must not start a command nobody will end.
 */
const ABORTED_RUN_MS = 10_000;

/** One running command action: what ends it, and how its runner lets go. */
export interface ActionCommandSlot {
  signal: AbortSignal;
  /** Called once the command's last row is written; a second call does nothing. */
  release: () => void;
}

interface RunningCommand {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * The command actions each run has running, so archive and delete can end
 * them: `runManagedCommand` files its child under a key no run id matches, so
 * `ProcessRegistry.cancel(runId)` never reaches it, and the run-tag reaper
 * leaves a run alone while its CLI is held.
 *
 * A leaf with no dependencies of its own: `RunTeardownService` injects it, and
 * the press side (which reaches the teardown through `ChatService`) does too.
 */
@Injectable()
export class ActionCommandRegistry implements BeforeApplicationShutdown {
  private readonly running = new Map<string, Set<RunningCommand>>();
  private readonly abortedAt = new Map<string, number>();
  private readonly idleListeners = new Set<(runId: string) => void>();
  private stopping = false;

  start(runId: string): ActionCommandSlot {
    const controller = new AbortController();
    if (this.stopping) {
      controller.abort('shutdown' satisfies ActionCommandAbortReason);
    } else if (this.isEnding(runId)) {
      controller.abort('run' satisfies ActionCommandAbortReason);
    }
    let release: () => void = () => undefined;
    const entry: RunningCommand = {
      controller,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const entries = this.running.get(runId) ?? new Set<RunningCommand>();
    entries.add(entry);
    this.running.set(runId, entries);
    return {
      signal: controller.signal,
      release: () => {
        const removed = entries.delete(entry);
        if (entries.size === 0 && this.running.get(runId) === entries) {
          this.running.delete(runId);
        }
        release();
        if (removed && !this.isRunning(runId)) {
          for (const listener of this.idleListeners) {
            listener(runId);
          }
        }
      },
    };
  }

  /** Be told when a run's last command action has let go of its slot. */
  onIdle(listener: (runId: string) => void): () => void {
    this.idleListeners.add(listener);
    return () => {
      this.idleListeners.delete(listener);
    };
  }

  /** Ends every command action the run has running, or starts in the next moments. */
  abortRun(runId: string): void {
    const now = Date.now();
    for (const [id, at] of this.abortedAt) {
      if (now - at >= ABORTED_RUN_MS) {
        this.abortedAt.delete(id);
      }
    }
    this.abortedAt.set(runId, now);
    for (const entry of this.running.get(runId) ?? []) {
      entry.controller.abort('run' satisfies ActionCommandAbortReason);
    }
  }

  /**
   * Whether the run has a command action running that nothing has ended: the
   * user is using the run, so its idle reap must not take the command's
   * tagged processes.
   */
  isRunning(runId: string): boolean {
    return [...(this.running.get(runId) ?? [])].some(
      (entry) => !entry.controller.signal.aborted,
    );
  }

  /** Whether a command started in the run now would start already ended. */
  isEnding(runId: string): boolean {
    const aborted = this.abortedAt.get(runId);
    return (
      this.stopping ||
      (aborted !== undefined && Date.now() - aborted < ABORTED_RUN_MS)
    );
  }

  /** The run is back (unarchived): its commands start normally again. */
  allowRun(runId: string): void {
    this.abortedAt.delete(runId);
  }

  /**
   * Ahead of `ProcessRegistry`'s drain, which would kill the children as
   * ordinary failures: ended here, they end `interrupted`, as after a crash.
   */
  beforeApplicationShutdown(): void {
    this.stopping = true;
    for (const entries of this.running.values()) {
      for (const entry of entries) {
        entry.controller.abort('shutdown' satisfies ActionCommandAbortReason);
      }
    }
  }

  /**
   * Resolves once every command the run has running has written its last
   * row, or `timeoutMs` has passed — a delete waits here so no row lands after
   * the run's rows are gone.
   */
  async settled(runId: string, timeoutMs: number): Promise<void> {
    const entries = [...(this.running.get(runId) ?? [])];
    if (entries.length === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(entries.map((entry) => entry.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }
}
