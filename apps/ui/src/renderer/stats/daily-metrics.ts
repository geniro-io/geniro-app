import { formatTokens } from '../chats/agent-activity';
import type { DayPoint } from './chart-data';
import { SERIES } from './charts/chart-theme';
import { formatCountAxis, formatDuration, formatUsdAxis } from './stats-format';

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
}

const METRICS: Record<DailyMetricId, DailyMetric> = {
  cost: {
    id: 'cost',
    label: 'Spend',
    shape: 'area',
    series: [{ key: 'costUsd', label: 'Spend', color: SERIES.spend }],
    axis: formatUsdAxis,
  },
  tokens: {
    id: 'tokens',
    label: 'Tokens',
    shape: 'area',
    series: [{ key: 'totalTokens', label: 'Tokens', color: SERIES.tokens }],
    axis: formatTokens,
  },
  threads: {
    id: 'threads',
    label: 'Threads',
    shape: 'bars',
    series: [
      { key: 'threadsCreated', label: 'Threads', color: SERIES.threads },
    ],
    axis: formatCountAxis,
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
  },
  lines: {
    id: 'lines',
    label: 'Lines',
    shape: 'bars',
    series: [
      { key: 'linesAdded', label: 'Added', color: SERIES.linesAdded },
      { key: 'linesRemoved', label: 'Removed', color: SERIES.linesRemoved },
    ],
    axis: formatCountAxis,
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
