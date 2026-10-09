import { describe, expect, it } from 'vitest';

import type { DayPoint } from '../chart-data';
import { dailyMetricOf } from '../daily-metrics';
import { SERIES } from './chart-theme';
import { dailyValueAxis, dayRows, loneDot, seriesMax } from './time-charts';

const day = (date: string): DayPoint => ({
  date,
  label: date.slice(5),
  title: date,
  turns: 1,
  costUsd: 1,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cumulativeUsd: 1,
  threadsCreated: 1,
  pullRequests: 0,
  linesAdded: null,
  linesRemoved: null,
  linesPartial: false,
  avgWorkedMs: null,
});

/**
 * What this DOES pin: the rule deciding whether a curve carries markers.
 *
 * What it does NOT: that the two charts pass it to Recharts. Neither can be
 * asserted here — `ResponsiveContainer` measures 0×0 in jsdom, so these charts
 * render no SVG at all (which is also why `chart-data.spec.ts` tests the series
 * and `chart-theme.spec.tsx` the tooltip, and neither touches a plot). The
 * wiring is checked in a browser against the real Today period.
 */
describe('loneDot', () => {
  it('marks a series of ONE, which a line and an area cannot draw at all', () => {
    // Both are drawn BETWEEN points, so a single day rendered as bare axes —
    // which reads as "no data" about a day that may well have cost money. The
    // bar chart beside them was unaffected, so one card in the row sat visibly
    // empty. Reachable long before the Today period made it routine: the daemon
    // clamps a range to what its ledger holds, so a fresh install's first day
    // answers every period with one bucket.
    expect(loneDot([day('2026-08-20')], 'var(--chart-1)')).toEqual({
      r: 3,
      strokeWidth: 0,
      fill: 'var(--chart-1)',
    });
  });

  it('leaves every longer series unmarked', () => {
    // At 30 points the same markers are a beaded string over a curve whose
    // SHAPE is the thing being read — which is why `dot` was false to begin
    // with, and why this is not a general option.
    expect(loneDot([day('2026-08-19'), day('2026-08-20')], 'x')).toBe(false);
    expect(loneDot([], 'x')).toBe(false);
  });
});

describe('dayRows', () => {
  it('puts the swatch on the figure the chart is drawing, and on no other', () => {
    // The hover panel states every figure, so the plotted one is the only way
    // to tell which of them the curve or the bars are made of.
    const rows = dayRows(day('2026-08-10'), dailyMetricOf('lines'));

    expect(rows.find((row) => row.label === 'Lines added')?.color).toBe(
      SERIES.linesAdded,
    );
    expect(rows.find((row) => row.label === 'Lines removed')?.color).toBe(
      SERIES.linesRemoved,
    );
    // Every other row, not a sample of them: a swatch on any of them would name a
    // series the chart is not drawing.
    for (const row of rows) {
      if (row.label !== 'Lines added' && row.label !== 'Lines removed') {
        expect(row.color, row.label).toBeUndefined();
      }
    }
  });

  it('reads a figure nothing measured as unmeasured, never as zero', () => {
    const rows = dayRows(day('2026-08-10'), dailyMetricOf('lines'));

    // A zero would claim the threads changed no lines that day. Nothing measured
    // them, which is a different statement — and the one the tooltip must make.
    expect(rows.find((row) => row.label === 'Lines added')).toMatchObject({
      value: '',
      unmeasured: true,
    });
  });

  it('says a line count that is a lower bound is one', () => {
    const measured = {
      ...day('2026-08-10'),
      linesAdded: 12,
      linesRemoved: 3,
      linesPartial: false,
    };
    const partial = { ...measured, linesPartial: true };

    const exact = dayRows(measured, dailyMetricOf('lines'));
    expect(exact.find((row) => row.label === 'Lines added')?.value).toBe('+12');
    expect(exact.find((row) => row.label === 'Lines removed')?.value).toBe(
      '−3',
    );

    const bounded = dayRows(partial, dailyMetricOf('lines'));
    expect(bounded.find((row) => row.label === 'Lines added')?.value).toBe(
      'at least +12',
    );
    expect(bounded.find((row) => row.label === 'Lines removed')?.value).toBe(
      'at least −3',
    );
  });
});

describe('seriesMax', () => {
  it('is the largest value any of the series reached', () => {
    const points = [
      { ...day('2026-10-01'), linesAdded: 4, linesRemoved: 9 },
      { ...day('2026-10-02'), linesAdded: 7, linesRemoved: null },
    ];
    expect(seriesMax(points, ['linesAdded', 'linesRemoved'])).toBe(9);
  });

  it('is null when no day measured any of them, so the chart can say so', () => {
    expect(
      seriesMax([day('2026-10-01')], ['linesAdded', 'linesRemoved']),
    ).toBeNull();
  });
});

describe('daily metric axes', () => {
  it('labels no fraction on a count axis, and lets money and tokens have them', () => {
    const points = [day('2026-10-01')];
    for (const metric of ['threads', 'pullRequests', 'lines'] as const) {
      expect(dailyValueAxis(dailyMetricOf(metric), points).allowDecimals).toBe(
        false,
      );
    }
    expect(dailyValueAxis(dailyMetricOf('cost'), points)).toEqual({
      tickFormatter: dailyMetricOf('cost').axis,
      allowDecimals: true,
    });
  });

  it('ticks a time axis on whole minutes past a minute, with a domain that ends on the last tick', () => {
    const points = [
      { ...day('2026-10-01'), avgWorkedMs: 100_000 },
      { ...day('2026-10-02'), avgWorkedMs: 40_000 },
    ];

    expect(dailyValueAxis(dailyMetricOf('avgTime'), points)).toMatchObject({
      ticks: [0, 60_000, 120_000],
      domain: [0, 120_000],
    });
  });

  it('leaves a time axis to the chart when no day measured a time', () => {
    expect(
      dailyValueAxis(dailyMetricOf('avgTime'), [day('2026-10-01')]).ticks,
    ).toBeUndefined();
  });

  it('draws removed lines lighter than added ones, not only in another hue', () => {
    const [added, removed] = dailyMetricOf('lines').series;
    expect(added?.fillOpacity).toBeUndefined();
    expect(removed?.fillOpacity).toBeLessThan(1);
  });
});
