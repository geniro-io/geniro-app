import { describe, expect, it } from 'vitest';

import {
  cacheHitRate,
  formatDayLabel,
  formatDayTitle,
  formatDuration,
} from './stats-format';
import { periodRange, STATS_PERIODS } from './use-stats';

describe('formatDayLabel', () => {
  it('reads the key as a LOCAL calendar day', () => {
    // `new Date('2026-08-10')` is UTC midnight, which renders as the 9th for
    // everyone west of Greenwich — the label would then disagree with the
    // bucket the daemon put the turns in.
    expect(formatDayLabel('2026-08-10')).toBe(
      new Date(2026, 7, 10).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    );
  });

  it('hands back anything that is not a day key untouched', () => {
    expect(formatDayLabel('not-a-day')).toBe('not-a-day');
  });
});

describe('formatDayTitle', () => {
  it('spells the day out for the hover text', () => {
    expect(formatDayTitle('2026-08-10')).toBe(
      new Date(2026, 7, 10).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    );
  });
});

describe('formatDuration', () => {
  it('says seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('says minutes under an hour', () => {
    expect(formatDuration(12 * 60_000)).toBe('12m');
  });

  it('says hours and minutes above an hour', () => {
    expect(formatDuration((3 * 60 + 12) * 60_000)).toBe('3h 12m');
  });

  it('drops the minutes on a whole number of hours', () => {
    expect(formatDuration(2 * 60 * 60_000)).toBe('2h 0m');
  });
});

describe('cacheHitRate', () => {
  it('is the share of prompt tokens served from cache', () => {
    expect(cacheHitRate(750, 250)).toBe(75);
  });

  it('is null when NEITHER figure was reported', () => {
    // Not 0%: a CLI that reports no token counts has not told us its cache was
    // cold.
    expect(cacheHitRate(null, null)).toBeNull();
  });

  it('is null when both figures are present but empty', () => {
    expect(cacheHitRate(0, 0)).toBeNull();
  });

  it('is null when the cache figure was never reported at all', () => {
    // The cursor-agent shape: prompt tokens counted, no cache accounting on
    // the wire whatsoever. "0%" states that nothing was served from cache —
    // a measurement that CLI never took, and the same false claim as a $0.00.
    expect(cacheHitRate(null, 5_000)).toBeNull();
  });

  it('counts a reported zero against a reported total', () => {
    // Cache read genuinely 0 with real input tokens IS a measured 0% — the one
    // case that must not collapse into "not measured".
    expect(cacheHitRate(0, 500)).toBe(0);
  });
});

describe('periodRange', () => {
  const now = new Date(2026, 7, 16, 14, 30);

  it('starts a fixed period at a local midnight', () => {
    const range = periodRange('7d', now);

    // Mid-afternoon would make the oldest column a part-day, drawing a short
    // bar that means nothing.
    const from = new Date(range.from!);
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
  });

  it('counts the period INCLUDING today', () => {
    const range = periodRange('7d', now);

    // 7 days means a week of columns, not eight.
    expect(new Date(range.from!).getDate()).toBe(10);
    expect(new Date(range.to).getDate()).toBe(16);
  });

  it('names no lower bound for all time', () => {
    const range = periodRange('all', now);

    // The daemon answers from its own first recorded turn — the renderer has no
    // way to know how far back the ledger goes.
    expect(range.from).toBeUndefined();
    expect(range.to).toBe(now.toISOString());
  });

  it('offers a usable range for every id it advertises', () => {
    // `not.toThrow()` held for any string at all, including ids the control
    // does not offer — so it pinned nothing. Assert the shape each id must
    // actually produce.
    for (const period of STATS_PERIODS) {
      const range = periodRange(period.id, now);
      expect(range.to).toBe(now.toISOString());
      if (period.days === null) {
        expect(range.from).toBeUndefined();
      } else {
        expect(range.from).toBeDefined();
        expect(new Date(range.from!).getTime()).toBeLessThan(now.getTime());
      }
    }
  });
});
