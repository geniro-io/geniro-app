import { describe, expect, it } from 'vitest';

import { eachLocalDay, localDateKey } from './usage-fold';
describe('localDateKey', () => {
  it('names the calendar day in the machine’s own timezone', () => {
    const at = new Date(2026, 7, 9, 23, 30);

    // Built from local parts, so this holds in every timezone — a UTC-derived
    // key would name the 10th here for anyone east of Greenwich.
    expect(localDateKey(at)).toBe('2026-08-09');
  });

  it('zero-pads month and day so the keys sort lexicographically', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});

describe('eachLocalDay', () => {
  it('lists every day the half-open range touches', () => {
    expect(
      eachLocalDay(new Date(2026, 7, 9, 18), new Date(2026, 7, 12, 3)),
    ).toEqual(['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('includes the day a range starts on even when it ends the same day', () => {
    expect(
      eachLocalDay(new Date(2026, 7, 9, 1), new Date(2026, 7, 9, 23)),
    ).toEqual(['2026-08-09']);
  });

  it('is empty for a range with no duration', () => {
    // The walk begins at the local midnight BEFORE `from`, which is earlier
    // than `from` itself — so without an explicit guard an empty range still
    // emits the day it began on.
    const from = new Date(2026, 7, 9, 12);
    expect(eachLocalDay(from, from)).toEqual([]);
    expect(eachLocalDay(from, new Date(2026, 7, 9, 11))).toEqual([]);
  });

  it('walks calendar days without skipping or repeating one across a long span', () => {
    // Starts INSIDE daylight saving, deliberately. A fixed 86,400,000ms step
    // drifts an hour at each transition; from a January (standard-time) start
    // the drift goes to 01:00 in spring and back to 00:00 in autumn without
    // ever crossing midnight, so the bug stayed invisible. From a June start
    // the autumn transition pushes the cursor back past midnight and the walk
    // emits 2025-11-02 twice — which the uniqueness assertion catches.
    const days = eachLocalDay(new Date(2025, 5, 1), new Date(2026, 6, 5));

    expect(new Set(days).size).toBe(days.length);
    expect(days[0]).toBe('2025-06-01');
    expect(days.at(-1)).toBe('2026-07-04');
    for (let i = 1; i < days.length; i += 1) {
      const previous = new Date(`${days[i - 1]}T00:00:00Z`).getTime();
      const current = new Date(`${days[i]}T00:00:00Z`).getTime();
      expect(current - previous).toBe(86_400_000);
    }
  });
});
