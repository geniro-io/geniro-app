/**
 * Run every step of the app's quit teardown, then quit — whatever any step
 * does.
 *
 * `before-quit` cancels the quit (`preventDefault`) so the daemon and the LAN
 * gateway can stop cleanly, and the teardown's own completion is the ONLY
 * thing that quits again. So a teardown that can fail to reach its end is a
 * ⌘Q that is swallowed — every time, since each press lands in the same place.
 * That was reachable: a step that threw SYNCHRONOUSLY while the promise chain
 * was still being built (the remote-access service, read before `whenReady`
 * had assigned it) took `.finally(app.quit)` down with it.
 *
 * So each step is called in isolation — a throw, or a rejection, is reported
 * and the next step still runs — the asynchronous ones are awaited together
 * (they are independent: neither the daemon nor the gateway owns the other),
 * and `quit` runs in a `finally`.
 */
export async function teardownThenQuit(
  steps: readonly (() => unknown)[],
  quit: () => void,
  report: (error: unknown) => void = (error) => {
    console.error('[ui] a quit teardown step failed:', error);
  },
): Promise<void> {
  try {
    const pending: Promise<unknown>[] = [];
    for (const step of steps) {
      try {
        pending.push(Promise.resolve(step()).catch(report));
      } catch (error) {
        report(error);
      }
    }
    await Promise.all(pending);
  } finally {
    quit();
  }
}
