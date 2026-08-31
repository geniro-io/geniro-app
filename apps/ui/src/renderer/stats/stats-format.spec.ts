import { describe, expect, it } from 'vitest';

import {
  cacheHitRate,
  dayRangeTitle,
  formatCount,
  formatDayLabel,
  formatDayTitle,
  formatDuration,
  formatPercent,
  formatTurns,
  formatUsdAxis,
} from './stats-format';
import { periodRange, STATS_PERIODS } from './use-stats';

describe('formatCount', () => {
  it('groups a four-figure count', () => {
    // The turn count was the one figure on the page still rendered by
    // `String(n)`, so beside a grouped `$21,547.80` it read as an oversight.
    expect(formatCount(1_882)).toBe('1,882');
    expect(formatCount(4)).toBe('4');
  });
});

describe('formatPercent', () => {
  it('never rounds UP to a whole the rate did not reach', () => {
    // Measured: 16.6e9 cache reads against 155e3 input tokens is 99.999%, which
    // `Math.round` printed as `100%` — a claim that not one prompt token in the
    // period was ever a cache miss. A reader who knows that cannot be true stops
    // trusting the rest of the page.
    expect(formatPercent(99.999)).toBe('99.9%');
    expect(formatPercent(99.6)).toBe('99.9%');
    // A genuine whole still prints as one.
    expect(formatPercent(100)).toBe('100%');
  });

  it('never rounds a real rate DOWN to nothing', () => {
    // The mirror of the same error: a measured 0% and a rate too small to round
    // to one percent are different claims about the cache.
    expect(formatPercent(0.2)).toBe('<1%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('leaves an ordinary rate whole', () => {
    expect(formatPercent(75)).toBe('75%');
    expect(formatPercent(74.4)).toBe('74%');
  });
});

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

describe('formatUsdAxis', () => {
  it('drops the cents an axis tick cannot justify', () => {
    // The full formatter rendered ticks as `$2000.00`, a column of noise wider
    // than the plot it labels. The exact value still lives in the tooltip.
    expect(formatUsdAxis(0)).toBe('$0');
    expect(formatUsdAxis(500)).toBe('$500');
    expect(formatUsdAxis(12.5)).toBe('$13');
  });

  it('compacts thousands, with one decimal only where it distinguishes', () => {
    expect(formatUsdAxis(1_500)).toBe('$1.5k');
    expect(formatUsdAxis(3_337.95)).toBe('$3.3k');
    // Past 10k a tenth of a thousand is false precision on a tick.
    expect(formatUsdAxis(12_000)).toBe('$12k');
    expect(formatUsdAxis(12_400)).toBe('$12k');
  });

  it('drops a trailing .0 rather than printing $2.0k', () => {
    expect(formatUsdAxis(2_000)).toBe('$2k');
  });
});

describe('formatTurns', () => {
  it('agrees with a count of one', () => {
    // Live against the real ledger, a period holding a single cursor-agent turn
    // rendered its legend row as "1 turns". The count of one is the whole point
    // of this helper — every other count was already right.
    expect(formatTurns(1)).toBe('1 turn');
  });

  it('pluralizes every other count, zero included', () => {
    expect(formatTurns(0)).toBe('0 turns');
    expect(formatTurns(2)).toBe('2 turns');
    expect(formatTurns(114)).toBe('114 turns');
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

describe('dayRangeTitle', () => {
  it('states a one-day span ONCE instead of dashing a date to itself', () => {
    // "Thursday, August 20, 2026 – Thursday, August 20, 2026" is a range that
    // is not one, and the dash invites reading its halves as two different
    // days. Reachable on every period, not only Today: the daemon clamps a
    // request to what its ledger holds, so a first-day install answers
    // "90 days" with one.
    // Built from LOCAL midnight, which is what the Today period actually sends
    // — see the timezone test below for why that matters.
    const midnight = new Date(2026, 7, 20);
    const afternoon = new Date(2026, 7, 20, 14, 30);
    const oneDay = dayRangeTitle(
      midnight.toISOString(),
      afternoon.toISOString(),
    );

    expect(oneDay).toBe(formatDayTitle('2026-08-20'));
    expect(oneDay).not.toContain('\u2013');
  });

  it('names the LOCAL calendar day, never the UTC one the ISO string spells', () => {
    // The daemon buckets by local day (`usage-fold.ts` `localDateKey`), so the
    // span has to read the same calendar its columns do. Slicing the ISO string
    // reads UTC instead, and the two disagree in BOTH directions — this is one
    // bug with two faces, and each zone can only see one of them:
    //
    //   east of Greenwich, a local MIDNIGHT is the previous UTC day. Measured
    //   at UTC+5 on the Today period: "August 20 – August 21" over a chart
    //   holding one column, labelled Aug 21.
    //
    //   west of it — this suite's own zone — a local EVENING is the next UTC
    //   day. `to` is always now, so every period opened after about 16:00 local
    //   claimed to run a day past its last column.
    //
    // The second is what this asserts, because it is the one this suite's
    // timezone can actually tell apart.
    const from = new Date(2026, 7, 21).toISOString();
    const lateEvening = new Date(2026, 7, 21, 23, 30).toISOString();

    expect(dayRangeTitle(from, lateEvening)).toBe(formatDayTitle('2026-08-21'));
  });

  it('keeps both ends of a real span', () => {
    expect(
      dayRangeTitle(
        new Date(2026, 7, 14).toISOString(),
        new Date(2026, 7, 20, 14, 30).toISOString(),
      ),
    ).toBe(
      `${formatDayTitle('2026-08-14')} \u2013 ${formatDayTitle('2026-08-20')}`,
    );
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

  it('reads Today as the calendar day, not the last 24 hours', () => {
    // The distinction is the whole point of the period: a rolling window slides
    // into yesterday as the afternoon wears on, so the same page would report a
    // different "today" every time it was opened.
    const range = periodRange('today', now);
    const from = new Date(range.from!);

    expect(from.getDate()).toBe(16);
    expect(from.getHours()).toBe(0);
    expect(new Date(range.to).getDate()).toBe(16);
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
