import { describe, expect, it, vi } from 'vitest';

import { teardownThenQuit } from './quit-teardown';

describe('teardownThenQuit', () => {
  it('QUITS even when a step throws synchronously — and still runs the steps after it', async () => {
    // The shape of the defect: `remoteAccess.stop()` read before `whenReady`
    // had assigned it throws a TypeError while the promise chain is still being
    // built, so the `.finally(app.quit)` hung on it was never attached and every
    // ⌘Q was cancelled by `before-quit` and never re-issued.
    const quit = vi.fn();
    const report = vi.fn();
    const after = vi.fn(async () => undefined);
    const unassigned = null as { stop(): Promise<void> } | null;

    await teardownThenQuit(
      [() => (unassigned as { stop(): Promise<void> }).stop(), after],
      quit,
      report,
    );

    expect(quit).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(TypeError));
  });

  it('QUITS when an asynchronous step rejects', async () => {
    const quit = vi.fn();
    const report = vi.fn();

    await teardownThenQuit(
      [() => Promise.reject(new Error('daemon refused to stop'))],
      quit,
      report,
    );

    expect(quit).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'daemon refused to stop' }),
    );
  });

  it('does not quit before every asynchronous step has finished', async () => {
    const quit = vi.fn();
    let finishDaemon = (): void => undefined;
    const daemonStopped = new Promise<void>((resolve) => {
      finishDaemon = resolve;
    });

    const done = teardownThenQuit([() => daemonStopped], quit);
    await Promise.resolve();
    expect(quit).not.toHaveBeenCalled();

    finishDaemon();
    await done;
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
