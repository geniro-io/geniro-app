import { describe, expect, it } from 'vitest';

import type { DayPoint } from '../chart-data';
import { loneDot } from './time-charts';

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
