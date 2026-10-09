import { randomUUID } from 'node:crypto';

import { type DaemonHandle, IPC } from '../shared/contracts';
import { reportMainLog } from './window-diagnostics';

/**
 * How long the QUIT waits for the windows to post what they hold. A window that never answers must not
 * hold the quit, so the wait is bounded — the same rule `teardownThenQuit` follows: a step that cannot
 * finish costs its own work, never the quit.
 *
 * Sized to a whole measurement rather than a post alone: one still in flight reads the folder's head,
 * asks the daemon for its baseline, reads the totals — the untracked half bounded by its own 5s budget —
 * and posts, and may ask for a replacement baseline and read once more. It is still a cap: a git call that
 * hangs toward its own 20s timeout outlasts it, and that measurement is reported lost. The wait ends as
 * soon as every window answers, so a stop with nothing in flight pays none of it.
 */
export const LINE_FLUSH_TIMEOUT_MS = 30_000;

/**
 * How long a daemon RESTART waits — shorter than the quit's, because a restart answers a settings
 * save the user is waiting on. A measurement still in flight past it is reported lost, like a quit's.
 */
export const LINE_FLUSH_RESTART_TIMEOUT_MS = 10_000;

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
 * has, before a quit or a restart stops the daemon.
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
          'a window did not post its line measurements before the daemon was stopped',
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

/** The one flush the desktop app runs: quit and restart ask through it, and each window's answer lands in it. */
export const lineMeasurementFlush = new LineMeasurementFlush();

/** What {@link windowTargets} needs of a window — the slice of a `BrowserWindow` it reads. */
export interface FlushableWindow {
  isDestroyed(): boolean;
  webContents: { id: number; send(channel: string, ...args: unknown[]): void };
}

/**
 * Every window that can still post, as a flush asks them. A window destroyed in the meantime has nothing
 * left to post, so it is not asked.
 */
export function windowTargets(
  windows: readonly FlushableWindow[],
  channel: string,
): FlushTarget[] {
  return windows
    .filter((win) => !win.isDestroyed())
    .map((win) => ({
      id: win.webContents.id,
      send: (requestId: string) => win.webContents.send(channel, requestId),
    }));
}

/**
 * Ask every window to post the line measurements it holds, and only then run `next` — the step that takes
 * the daemon away (a quit's stop, a settings change's restart). A window left holding one would otherwise
 * post it to a daemon already gone, and that thread's last turn would wait for its next one to be counted.
 * Bounded by the flush's own timeout, so a window that never answers cannot hold `next`.
 */
export async function flushThen<T>(
  flush: LineMeasurementFlush,
  targets: readonly FlushTarget[],
  report: FlushReport,
  next: () => Promise<T>,
  timeoutMs: number = LINE_FLUSH_TIMEOUT_MS,
): Promise<T> {
  await flush.request(targets, report, timeoutMs);
  return next();
}

/**
 * {@link flushThen} over every open window, through the one flush the desktop app runs, reporting a lost
 * measurement to the daemon's log — what the quit and the settings restart both call before they take the
 * daemon away, so the two cannot come to ask the windows, or report what they lost, differently.
 */
export function flushWindowsThen<T>(
  windows: readonly FlushableWindow[],
  daemon: () => DaemonHandle | null,
  next: () => Promise<T>,
  timeoutMs: number = LINE_FLUSH_TIMEOUT_MS,
): Promise<T> {
  return flushThen(
    lineMeasurementFlush,
    windowTargets(windows, IPC.onFlushLineMeasurements),
    (message, context) => {
      void reportMainLog(daemon(), 'warn', message, context);
    },
    next,
    timeoutMs,
  );
}
