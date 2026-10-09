import { randomUUID } from 'node:crypto';

/**
 * How long the quit waits for the windows to post what they hold. A window that never answers must not
 * hold the quit, so the wait is bounded — the same rule `teardownThenQuit` follows: a step that cannot
 * finish costs its own work, never the quit.
 */
export const LINE_FLUSH_TIMEOUT_MS = 3_000;

/** One window that can be asked to flush: its WebContents id, and the way to ask it. */
export interface FlushTarget {
  readonly id: number;
  send(requestId: string): void;
}

/**
 * Where a flush reports a measurement it could not get posted: a window it could not ask, and a window that
 * did not answer in time. Both are lost measurements, so both go to the daemon's log.
 */
export type FlushReport = (
  message: string,
  context: Record<string, string>,
) => void;

/**
 * Asks every open window to post the line measurements it is still holding, and waits for each to say it
 * has, before the quit stops the daemon.
 *
 * A thread's lines are measured a moment after its turn ends: a burst of turns settles first, so the
 * measurement is debounced. That measurement is posted to the daemon, and the quit stops the daemon. A
 * window still holding one at that point posts to a daemon that is already gone, so the thread's last turn
 * is never counted — and nothing re-measures it until that thread's next turn, which may never come.
 * Asking first closes that window.
 */
export class LineMeasurementFlush {
  private readonly awaiting = new Map<
    string,
    { windows: Set<number>; settle: () => void }
  >();

  /**
   * Ask each target to flush, and resolve once every one has answered or the timeout has passed. A target
   * that cannot be asked — a window already destroyed — is not waited for, since it has nothing left to
   * post. Never rejects.
   */
  request(
    targets: readonly FlushTarget[],
    report: FlushReport,
    timeoutMs: number = LINE_FLUSH_TIMEOUT_MS,
  ): Promise<void> {
    if (targets.length === 0) {
      return Promise.resolve();
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve) => {
      const windows = new Set<number>();
      const settle = (): void => {
        clearTimeout(timer);
        this.awaiting.delete(requestId);
        resolve();
      };
      // It fires only while a window has not answered, so the measurements still outstanding are the ones
      // the quit is about to lose.
      const timer = setTimeout(() => {
        report(
          'a window did not post its line measurements before the quit stopped the daemon',
          { windows: String(windows.size), timeoutMs: String(timeoutMs) },
        );
        settle();
      }, timeoutMs);
      this.awaiting.set(requestId, { windows, settle });
      for (const target of targets) {
        try {
          target.send(requestId);
          windows.add(target.id);
        } catch (error) {
          report('a window could not be asked to post its line measurements', {
            window: String(target.id),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (windows.size === 0) {
        settle();
      }
    });
  }

  /**
   * A window has posted what it held. An answer to a request nobody is waiting on is ignored: by then there
   * is nothing left to wait for.
   */
  acknowledge(windowId: number, requestId: string): void {
    const pending = this.awaiting.get(requestId);
    if (pending === undefined) {
      return;
    }
    pending.windows.delete(windowId);
    if (pending.windows.size === 0) {
      pending.settle();
    }
  }
}

/** The one flush the desktop app runs: the quit asks through it, and each window's answer lands in it. */
export const lineMeasurementFlush = new LineMeasurementFlush();
