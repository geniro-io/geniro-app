import { Logger } from '@nestjs/common';

/** How often the watch reads the wall clock while anything is subscribed. */
export const SLEEP_WATCH_TICK_MS = 10_000;

/**
 * How far past {@link SLEEP_WATCH_TICK_MS} a gap must run to read as a wake: a
 * minute is far beyond scheduling jitter and far below the shortest window this
 * protects (ten minutes).
 */
export const SLEEP_GAP_THRESHOLD_MS = 60_000;

/**
 * Notices that the MACHINE slept, so a deadline that measures silence stops
 * counting the time it was asleep. On macOS node's timers keep counting through
 * a sleep, so every deadline that ran out while the lid was shut fires at the
 * wake (2026-10-10: a card turn ~45s quiet, asleep 20:02 → 00:01, failed at
 * 00:01:00 as "produced nothing for 30 minutes").
 *
 * The daemon runs without the UI, so Electron's `powerMonitor` is out of reach
 * and a sleep is INFERRED: a gap of over a minute past the tick between two
 * clock reads. An event loop blocked that long reads the same, which is
 * harmless, since a detected gap only ever pushes deadlines LATER.
 */
export class SleepWatch {
  private readonly listeners = new Set<() => void>();
  private readonly logger: Pick<Logger, 'warn'>;
  private ticker: ReturnType<typeof setTimeout> | null = null;
  private lastTick = 0;

  constructor({ logger }: { logger?: Pick<Logger, 'warn'> } = {}) {
    this.logger = logger ?? new Logger(SleepWatch.name);
  }

  /** Listen for gaps; the returned function stops listening. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.ticker === null) {
      this.lastTick = Date.now();
      this.scheduleTick();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopTicker();
      }
    };
  }

  /**
   * A `setTimeout` chain, not a `setInterval`, so it runs on the deadlines' own
   * clock even where a spec fakes `setTimeout` alone. A listener only re-arms a
   * timer, so a check never stops the chain it runs in.
   */
  private scheduleTick(): void {
    this.ticker = setTimeout(() => {
      this.check();
      this.scheduleTick();
    }, SLEEP_WATCH_TICK_MS);
    this.ticker.unref();
  }

  /**
   * For specs only (`__tests__/setup.ts`, between tests): drop every listener
   * and stop the ticker, leaving their timers armed but unprotected. A turn
   * left unsettled would otherwise carry a ticker started under real timers
   * into a fake-timer test, where every deadline then reads as a wake.
   */
  reset(): void {
    this.listeners.clear();
    this.stopTicker();
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearTimeout(this.ticker);
      this.ticker = null;
    }
  }

  /**
   * Read the clock now; answers whether a gap was found, every listener having
   * re-armed. Synchronous, so a deadline that fires at the wake ahead of the
   * ticker still sees the gap.
   */
  check(): boolean {
    if (this.ticker === null) {
      return false;
    }
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    // A clock set BACKWARDS is not a sleep; it only moves the baseline.
    if (elapsed <= SLEEP_WATCH_TICK_MS + SLEEP_GAP_THRESHOLD_MS) {
      return false;
    }
    // Listeners only re-arm their own timer, so the set is walked as it is.
    const count = this.listeners.size;
    this.listeners.forEach((listener) => listener());
    this.logger.warn(
      `wall clock gap of ${Math.round(elapsed / 1000)}s (sleep or a blocked event loop) — re-armed ${count} silence deadline(s) from now`,
    );
    return true;
  }
}

/** The daemon's one watch. */
export const sleepWatch = new SleepWatch();

/** A pending {@link awakeTimeout}. */
export interface AwakeTimer {
  clear(): void;
  /** Start the same window again from now, watching again if it was cleared or fired. */
  refresh(): void;
  /**
   * Change the window's length to `ms`, keeping where it started: a pending
   * window now runs out at its start plus `ms` — at once when that has already
   * passed. Its start is the arm, the last refresh, or the last wake, so time
   * asleep is still not counted. Every later start (a refresh, a wake) runs
   * the new length whole. On a cleared or fired timer it only sets the length
   * the next refresh uses.
   */
  retime(ms: number): void;
}

/**
 * `setTimeout` for a deadline that measures SILENCE: on a detected gap it
 * starts again, for its full length, from the wake. Not for a deadline that
 * names an INSTANT (a usage-limit reset), which should fire after a wake.
 * Unref'd, like the ticker: a pending deadline never keeps an otherwise
 * finished daemon alive.
 */
export function awakeTimeout(
  callback: () => void,
  ms: number,
  watch: SleepWatch = sleepWatch,
): AwakeTimer {
  let length = ms;
  /** When the pending window started: its arm, refresh, or the last wake. */
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | null = null;
  const schedule = (delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // At a wake the ticker usually runs first and has already re-armed this
      // one. A deadline that fell due early in the sleep can run ahead of it,
      // so it reads the clock itself; a gap found here has already re-armed it.
      if (!watch.check()) {
        clear();
        callback();
      }
    }, delay);
    timer.unref();
  };
  const arm = (): void => {
    startedAt = Date.now();
    schedule(length);
  };
  const clear = (): void => {
    clearTimeout(timer);
    unsubscribe?.();
    unsubscribe = null;
  };
  const start = (): void => {
    arm();
    unsubscribe ??= watch.subscribe(arm);
  };
  const retime = (next: number): void => {
    length = next;
    if (unsubscribe === null) {
      return;
    }
    // A sleep the ticker has not noticed yet re-arms this window from the wake
    // here, before its start is read.
    watch.check();
    schedule(Math.max(0, startedAt + next - Date.now()));
  };
  start();
  return { clear, refresh: start, retime };
}
