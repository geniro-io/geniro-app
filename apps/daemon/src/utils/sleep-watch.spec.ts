import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { simulateSleep } from '../__tests__/simulate-sleep';
import {
  awakeTimeout,
  SLEEP_GAP_THRESHOLD_MS,
  SLEEP_WATCH_TICK_MS,
  SleepWatch,
} from './sleep-watch';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
let watch: SleepWatch;

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.fn<(message: string) => void>();
  watch = new SleepWatch({ logger: { warn } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('awakeTimeout', () => {
  it('fires after its window of awake time, like setTimeout', async () => {
    const fired = vi.fn();
    awakeTimeout(fired, 30 * MINUTE, watch);

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not fire at the wake for a window that ran out while asleep, and restarts it whole from the wake', async () => {
    // The incident: 45s of silence, then hours asleep. On macOS every overdue
    // timer fires the instant the lid opens. Armed before the ticker, this
    // deadline runs ahead of it at the wake and must find the gap itself.
    const fired = vi.fn();
    awakeTimeout(fired, 30 * MINUTE, watch);
    await vi.advanceTimersByTimeAsync(45_000);

    await simulateSleep(4 * HOUR);
    expect(fired).not.toHaveBeenCalled();

    // A FULL window from the wake, not the remainder of the old one.
    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('re-arms a deadline armed just after a tick, the order a real wake runs', async () => {
    // Needs the ticker to run first at the wake: refreshed after a tick, the
    // deadline's timer is newer than the ticker's.
    const fired = vi.fn();
    const timer = awakeTimeout(fired, 30 * MINUTE, watch);
    await vi.advanceTimersByTimeAsync(SLEEP_WATCH_TICK_MS);
    timer.refresh();

    await simulateSleep(4 * HOUR);

    expect(fired).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('re-armed 1 silence deadline'),
    );

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('re-arms EVERY pending deadline on one gap, whichever of them fires first', async () => {
    // One gap is detected once: the first timer to look re-arms all the
    // others before they get their turn.
    const first = vi.fn();
    awakeTimeout(first, 2 * HOUR, watch);
    const later = vi.fn();
    awakeTimeout(later, 30 * MINUTE, watch);
    await vi.advanceTimersByTimeAsync(45_000);

    await simulateSleep(4 * HOUR);

    expect(first).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(later).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('a gap that is a blocked event loop only pushes the deadline later, never earlier', async () => {
    // From inside the loop a stalled loop and a sleep look the same. Treating
    // it as a sleep is safe exactly because the only effect is a later deadline.
    const fired = vi.fn();
    awakeTimeout(fired, 30 * MINUTE, watch);
    await vi.advanceTimersByTimeAsync(29 * MINUTE);

    await simulateSleep(2 * MINUTE);
    expect(fired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('a cleared deadline stops the ticker and is not re-armed by a later gap', async () => {
    const fired = vi.fn();
    const timer = awakeTimeout(fired, 30 * MINUTE, watch);
    timer.clear();
    expect(vi.getTimerCount()).toBe(0);

    await simulateSleep(4 * HOUR);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(fired).not.toHaveBeenCalled();
  });

  it('a deadline that fired on its own unsubscribes, so a later gap cannot run it again', async () => {
    const fired = vi.fn();
    awakeTimeout(fired, 30 * MINUTE, watch);

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fired).toHaveBeenCalledTimes(1);
    // The ticker stops with the last listener. Left subscribed, the next gap
    // re-arms this deadline and it fires again a window later.
    expect(vi.getTimerCount()).toBe(0);

    await simulateSleep(4 * HOUR);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('a deadline cleared while another is pending leaves the other protected', async () => {
    // Only the LAST listener leaving stops the ticker.
    const cleared = vi.fn();
    const timer = awakeTimeout(cleared, 30 * MINUTE, watch);
    const kept = vi.fn();
    awakeTimeout(kept, 30 * MINUTE, watch);
    await vi.advanceTimersByTimeAsync(45_000);
    timer.clear();

    await simulateSleep(4 * HOUR);
    expect(kept).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(kept).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kept).toHaveBeenCalledTimes(1);
    expect(cleared).not.toHaveBeenCalled();
  });

  it('a refresh after a clear watches again, so a sleep cannot fire it at the wake', async () => {
    const fired = vi.fn();
    const timer = awakeTimeout(fired, 30 * MINUTE, watch);
    timer.clear();
    timer.refresh();
    await vi.advanceTimersByTimeAsync(45_000);

    await simulateSleep(4 * HOUR);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe('awakeTimeout — retime', () => {
  it('ends a pending window at its start plus the new length', async () => {
    const fired = vi.fn();
    const timer = awakeTimeout(fired, HOUR, watch);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    timer.retime(30 * MINUTE);

    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('fires at once when the new length has already passed', async () => {
    const fired = vi.fn();
    const timer = awakeTimeout(fired, HOUR, watch);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);

    timer.retime(30 * MINUTE);

    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('does not count a sleep toward the new length', async () => {
    // Retimed after a wake: the window's start is the wake, not its arm.
    const fired = vi.fn();
    const timer = awakeTimeout(fired, HOUR, watch);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await simulateSleep(4 * HOUR);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    timer.retime(30 * MINUTE);

    await vi.advanceTimersByTimeAsync(25 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('runs the new length whole from a later refresh', async () => {
    const fired = vi.fn();
    const timer = awakeTimeout(fired, HOUR, watch);
    timer.retime(30 * MINUTE);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    timer.refresh();

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('only sets the next length on a cleared timer', async () => {
    const fired = vi.fn();
    const timer = awakeTimeout(fired, HOUR, watch);
    timer.clear();

    timer.retime(MINUTE);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(fired).not.toHaveBeenCalled();

    timer.refresh();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe('SleepWatch', () => {
  it('logs one line per gap with its length, without asserting it was a sleep, and the count of re-armed deadlines', async () => {
    awakeTimeout(() => {}, 30 * MINUTE, watch);
    awakeTimeout(() => {}, 10 * MINUTE, watch);
    await vi.advanceTimersByTimeAsync(45_000);

    await simulateSleep(4 * HOUR);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toMatch(/gap of 14\d{3}s/);
    expect(line).toContain('sleep or a blocked event loop');
    expect(line).toContain('re-armed 2 silence deadline(s)');
  });

  it('reads a gap of exactly tick + threshold as ordinary jitter', async () => {
    const fired = vi.fn();
    awakeTimeout(fired, 30 * MINUTE, watch);
    // Interval + threshold is the largest gap that is NOT a wake.
    await simulateSleep(SLEEP_WATCH_TICK_MS + SLEEP_GAP_THRESHOLD_MS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('finds no gap with nothing subscribed, however long ago the last listener left', () => {
    awakeTimeout(() => {}, 30 * MINUTE, watch).clear();
    vi.setSystemTime(Date.now() + 4 * HOUR);
    expect(watch.check()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a clock set backwards', () => {
    awakeTimeout(() => {}, 30 * MINUTE, watch);
    vi.setSystemTime(Date.now() - 2 * HOUR);
    expect(watch.check()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
