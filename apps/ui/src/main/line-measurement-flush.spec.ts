import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  flushThen,
  flushWindowsThen,
  LINE_FLUSH_TIMEOUT_MS,
  LineMeasurementFlush,
  windowTargets,
} from './line-measurement-flush';

const mocks = vi.hoisted(() => ({ reportMainLog: vi.fn() }));

vi.mock('./window-diagnostics', () => ({
  reportMainLog: mocks.reportMainLog,
}));

afterEach(() => {
  vi.useRealTimers();
  mocks.reportMainLog.mockReset();
});

/** A window that records each request it was asked with, so a test can answer it. */
function askedWindow(id: number) {
  const asked: string[] = [];
  return {
    asked,
    target: {
      id,
      send: (requestId: string) => {
        asked.push(requestId);
      },
    },
  };
}

describe('LineMeasurementFlush', () => {
  it('resolves at once when there is no window to ask', async () => {
    const report = vi.fn();

    await expect(
      new LineMeasurementFlush().request([], report),
    ).resolves.toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it('holds the quit until every asked window has posted what it held', async () => {
    const flush = new LineMeasurementFlush();
    const first = askedWindow(1);
    const second = askedWindow(2);
    let settled = false;
    const done = flush
      .request([first.target, second.target], vi.fn())
      .then(() => {
        settled = true;
      });

    // Both windows were asked with the same request, which is what their answers name.
    expect(first.asked).toHaveLength(1);
    expect(second.asked).toEqual(first.asked);
    const [requestId] = first.asked;
    flush.acknowledge(1, requestId ?? '');
    await Promise.resolve();
    expect(settled).toBe(false);

    flush.acknowledge(2, requestId ?? '');
    await done;
    expect(settled).toBe(true);
  });

  it('stops waiting on a window that never answers once the bound has passed, and says so in the log', async () => {
    vi.useFakeTimers();
    const flush = new LineMeasurementFlush();
    const silent = askedWindow(1);
    const report = vi.fn();
    let settled = false;
    void flush.request([silent.target], report).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(LINE_FLUSH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(report).toHaveBeenCalledWith(
      'a window did not post its line measurements before the daemon was stopped',
      { windows: '1', timeoutMs: String(LINE_FLUSH_TIMEOUT_MS) },
    );
  });

  it('does not wait for a window it could not ask, and says so in the log', async () => {
    // Fake timers, so a wait for the bound would never finish inside this test: a revert that waited on
    // it would fail here rather than pass slowly.
    vi.useFakeTimers();
    const flush = new LineMeasurementFlush();
    const destroyed = {
      id: 9,
      send: (): void => {
        throw new Error('Object has been destroyed');
      },
    };
    const report = vi.fn();
    let settled = false;
    void flush.request([destroyed], report).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(report).toHaveBeenCalledWith(
      'a window could not be asked to post its line measurements',
      { window: '9', error: 'Object has been destroyed' },
    );
  });

  it('ignores an answer to a request nobody is waiting on', () => {
    const flush = new LineMeasurementFlush();

    expect(() => flush.acknowledge(1, 'never-asked')).not.toThrow();
  });
});

describe('flushThen', () => {
  it('runs the next step only once every asked window has posted', async () => {
    const flush = new LineMeasurementFlush();
    const window = askedWindow(1);
    const next = vi.fn(async () => 'stopped');

    const done = flushThen(flush, [window.target], vi.fn(), next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();

    flush.acknowledge(1, window.asked[0]!);

    await expect(done).resolves.toBe('stopped');
    expect(next).toHaveBeenCalledOnce();
  });

  it('runs the next step once the bound passes, when a window never answers', async () => {
    vi.useFakeTimers();
    const flush = new LineMeasurementFlush();
    const next = vi.fn(async () => undefined);

    const done = flushThen(flush, [askedWindow(1).target], vi.fn(), next);
    await vi.advanceTimersByTimeAsync(LINE_FLUSH_TIMEOUT_MS - 1);
    expect(next).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('windowTargets', () => {
  it('asks each live window on the channel it is given, and skips a destroyed one', () => {
    const sendLive = vi.fn();
    const sendGone = vi.fn();

    const targets = windowTargets(
      [
        { isDestroyed: () => false, webContents: { id: 4, send: sendLive } },
        { isDestroyed: () => true, webContents: { id: 5, send: sendGone } },
      ],
      'flush-channel',
    );
    for (const target of targets) {
      target.send('req-1');
    }

    expect(targets.map((target) => target.id)).toEqual([4]);
    expect(sendLive).toHaveBeenCalledWith('flush-channel', 'req-1');
    expect(sendGone).not.toHaveBeenCalled();
  });
});

describe('flushWindowsThen', () => {
  it('logs a window that never answered to the daemon, then runs the stop', async () => {
    vi.useFakeTimers();
    const handle = { port: 1 } as never;
    const stop = vi.fn(async () => 'stopped');
    const silent = {
      isDestroyed: () => false,
      webContents: { id: 4, send: vi.fn() },
    };

    const done = flushWindowsThen([silent], () => handle, stop, 500);
    await vi.advanceTimersByTimeAsync(500);

    expect(await done).toBe('stopped');
    expect(mocks.reportMainLog).toHaveBeenCalledWith(
      handle,
      'warn',
      'a window did not post its line measurements before the daemon was stopped',
      { windows: '1', timeoutMs: '500' },
    );
  });
});
