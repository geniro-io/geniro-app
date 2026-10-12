import { vi } from 'vitest';

/**
 * Put the machine to sleep for `ms` under vitest's fake timers, the way macOS
 * does: the wall clock AND the clock behind node's timers both move by `ms`,
 * nothing runs in between, and every timer that came due meanwhile fires ONCE,
 * at the wake instant, seeing the wake time on `Date.now()`.
 *
 * `vi.advanceTimersByTime` cannot model this — it runs a ticker on every one of
 * its intervals, each seeing a consistent clock, so no gap is ever visible.
 * The fake-timer library underneath has exactly this operation (`jump`, "to
 * simulate the JS engine being put to sleep and resumed later"), and exposes
 * its clock on every function it fakes; vitest just does not re-export it.
 * Those timers run in creation order. Node runs overdue timers by due time, so
 * at a real wake the 10s ticker usually runs before a silence deadline. Here a
 * deadline armed before the ticker (as `awakeTimeout` arms it) runs first and
 * must find the gap itself; a spec that needs the real order re-arms the
 * deadline after a tick, so its timer is newer than the ticker's.
 *
 * Requires `vi.useFakeTimers()` first. Woken timers run back to back in one
 * tick; their promise callbacks run only after all of them, unlike a real
 * wake. Async so those callbacks have run when it returns.
 */
export async function simulateSleep(ms: number): Promise<void> {
  const clock = (
    setTimeout as unknown as { clock?: { jump(ms: number): number } }
  ).clock;
  if (!clock) {
    throw new Error('simulateSleep needs vi.useFakeTimers() first');
  }
  clock.jump(ms);
  await vi.advanceTimersByTimeAsync(0);
}
