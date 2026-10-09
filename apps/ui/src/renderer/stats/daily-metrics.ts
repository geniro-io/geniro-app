import { formatTokens } from '../chats/agent-activity';
import type { DayPoint } from './chart-data';
import { SERIES } from './charts/chart-theme';
import { formatCountAxis, formatDuration, formatUsdAxis } from './stats-format';

/**
 * How the value axis places its ticks. `whole` for counts, which have no fractional values to
 * label; `duration` for times, ticked on whole seconds, minutes or hours; `auto` lets the
 * chart choose, for money and tokens, whose formatters label fractions honestly.
 */
export type DailyAxisTicks = 'auto' | 'whole' | 'duration';

/** The switch's choices, in the order it shows them. */
export const DAILY_METRIC_IDS = [
  'cost',
  'tokens',
  'threads',
  'pullRequests',
  'lines',
  'avgTime',
] as const;

export type DailyMetricId = (typeof DAILY_METRIC_IDS)[number];

/**
 * A DayPoint field a daily metric plots. `Extract` rather than a bare union, so a
 * key that stopped existing on DayPoint is a compile error at the table below
 * rather than a series that silently draws nothing.
 */
export type DailySeriesKey = Extract<
  keyof DayPoint,
  | 'costUsd'
  | 'totalTokens'
  | 'threadsCreated'
  | 'pullRequests'
  | 'linesAdded'
  | 'linesRemoved'
  | 'avgWorkedMs'
>;

export interface DailySeries {
  key: DailySeriesKey;
  /** The name in the legend, and in the chart's own hover row. */
  label: string;
  color: string;
  /** Opacity of the fill, for a series that should read quieter than its neighbours. */
  fillOpacity?: number;
}

export interface DailyMetric {
  id: DailyMetricId;
  /** The switch's label. */
  label: string;
  /**
   * How the series is drawn.
   *
   * An area for the dense, ordered money and token series, where the shape of the
   * curve is what is read. Bars for counts and per-day averages: each day is a
   * figure of its own, and a curve through them would read as a trend nothing
   * measured.
   */
  shape: 'area' | 'bars';
  series: readonly DailySeries[];
  /** The axis tick format, in this metric's own unit. */
  axis: (value: number) => string;
  ticks: DailyAxisTicks;
}

const METRICS: Record<DailyMetricId, DailyMetric> = {
  cost: {
    id: 'cost',
    label: 'Spend',
    shape: 'area',
    series: [{ key: 'costUsd', label: 'Spend', color: SERIES.spend }],
    axis: formatUsdAxis,
    ticks: 'auto',
  },
  tokens: {
    id: 'tokens',
    label: 'Tokens',
    shape: 'area',
    series: [{ key: 'totalTokens', label: 'Tokens', color: SERIES.tokens }],
    axis: formatTokens,
    ticks: 'auto',
  },
  threads: {
    id: 'threads',
    label: 'Threads',
    shape: 'bars',
    series: [
      { key: 'threadsCreated', label: 'Threads', color: SERIES.threads },
    ],
    axis: formatCountAxis,
    ticks: 'whole',
  },
  pullRequests: {
    id: 'pullRequests',
    label: 'Pull requests',
    shape: 'bars',
    series: [
      {
        key: 'pullRequests',
        label: 'Pull requests',
        color: SERIES.pullRequests,
      },
    ],
    axis: formatCountAxis,
    ticks: 'whole',
  },
  lines: {
    id: 'lines',
    label: 'Lines',
    shape: 'bars',
    series: [
      { key: 'linesAdded', label: 'Added', color: SERIES.linesAdded },
      // Lighter as well as another hue: the two hues are of near-equal lightness, so to
      // a red-green colour-blind reader they are one colour without it.
      {
        key: 'linesRemoved',
        label: 'Removed',
        color: SERIES.linesRemoved,
        fillOpacity: 0.5,
      },
    ],
    axis: formatCountAxis,
    ticks: 'whole',
  },
  avgTime: {
    id: 'avgTime',
    label: 'Avg time',
    shape: 'bars',
    series: [
      {
        key: 'avgWorkedMs',
        label: 'Avg time per thread',
        color: SERIES.avgTime,
        fillOpacity: 0.6,
      },
    ],
    axis: formatDuration,
    ticks: 'duration',
  },
};

/** The switch's options, in its order. */
export const DAILY_METRIC_OPTIONS = DAILY_METRIC_IDS.map((id) => ({
  id,
  label: METRICS[id].label,
}));

/** The metric a switch choice names. */
export function dailyMetricOf(id: DailyMetricId): DailyMetric {
  return METRICS[id];
}
