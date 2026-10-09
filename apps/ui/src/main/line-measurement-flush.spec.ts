import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LINE_FLUSH_TIMEOUT_MS,
  LineMeasurementFlush,
} from './line-measurement-flush';

afterEach(() => {
  vi.useRealTimers();
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
      'a window did not post its line measurements before the quit stopped the daemon',
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
