import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatTokens, formatUsd } from '../../chats/agent-activity';
import type { DayPoint } from '../chart-data';
import {
  type DailyMetric,
  type DailyMetricId,
  dailyMetricOf,
  type DailySeriesKey,
} from '../daily-metrics';
import {
  formatCount,
  formatDuration,
  formatLineCount,
  formatTurns,
  formatUsdAxis,
} from '../stats-format';
import {
  AXIS,
  CHART_MARGIN,
  ChartTooltip,
  SERIES,
  SeriesLegend,
  type TooltipRow,
} from './chart-theme';

/** Plot height in px — the hero gets more room than the two supporting charts. */
const HERO_HEIGHT = 240;
const SUPPORT_HEIGHT = 180;

/**
 * How many x ticks to aim for. Recharts would otherwise draw one per day and
 * let them collide; `interval` thins them to roughly this many.
 */
const TICK_TARGET = 8;

function tickInterval(points: readonly DayPoint[]): number {
  return Math.max(0, Math.ceil(points.length / TICK_TARGET) - 1);
}

/**
 * What Recharts hands a tooltip. Typed here rather than imported: the library's
 * own generic is loose enough that it would not catch a renamed data key, which
 * is the mistake this shape exists to make impossible.
 */
interface TooltipProps {
  active?: boolean;
  /**
   * Readonly to match what Recharts declares. The content prop is checked
   * contravariantly, so a mutable array here makes the whole callback
   * unassignable — the compiler is right, and the fix is to promise less.
   */
  payload?: readonly { payload?: DayPoint }[];
}

/** The day a tooltip is hovering, or null when it is not showing. */
function hoveredDay(props: TooltipProps): DayPoint | null {
  return props.active && props.payload?.length
    ? (props.payload[0]?.payload ?? null)
    : null;
}

/**
 * The marker a curve shows only when it has ONE point, and `false` otherwise.
 *
 * A line and an area are both drawn BETWEEN points, so a series holding a single
 * day has nothing to draw: the panel rendered as bare axes, which reads as "no
 * data" about a day that may well have cost money. The bar chart beside them was
 * unaffected, so one card in a row of three sat visibly empty.
 *
 * Reachable long before the Today period made it routine — the daemon clamps a
 * range to what its ledger holds, so a fresh install's first day answers every
 * period with one bucket.
 *
 * A dot only in that case, never as a general option: at 30 points the same
 * markers are a beaded string over a curve whose shape is the thing being read,
 * which is why `dot` was false to begin with.
 */
export function loneDot(
  points: readonly DayPoint[],
  color: string,
): { r: number; strokeWidth: number; fill: string } | false {
  return points.length === 1 ? { r: 3, strokeWidth: 0, fill: color } : false;
}

/** Shared axis pair — same ticks, same gridlines, so the charts stack legibly. */
function Axes({
  points,
  tickFormatter,
}: {
  points: readonly DayPoint[];
  tickFormatter: (value: number) => string;
}): React.JSX.Element {
  return (
    <>
      <CartesianGrid
        vertical={false}
        stroke={AXIS.stroke}
        strokeDasharray="3 3"
      />
      <XAxis
        dataKey="label"
        interval={tickInterval(points)}
        tickLine={false}
        axisLine={{ stroke: AXIS.stroke }}
        tick={AXIS.tick}
      />
      <YAxis
        width={52}
        tickLine={false}
        axisLine={false}
        tick={AXIS.tick}
        tickFormatter={tickFormatter}
      />
    </>
  );
}

/**
 * One day per column, or one curve across the days, for whichever figure the
 * switch names.
 *
 * Money and tokens are areas: a dense, ordered series whose shape is what is read
 * — a fortnight's spend. Counts and per-day averages are bars: each day is a
 * figure of its own, and a curve would join two days' threads into a trend nothing
 * measured. Either way a day nobody measured is left EMPTY — no column, a gap in
 * the curve — because joining across it would invent a figure for that day.
 *
 * The hover panel states every figure the day measured, not only the one plotted:
 * the question this chart answers is comparing days, and a comparison that shows
 * one figure per hover sends the reader across the period once per metric.
 */
export function DailySeriesChart({
  points,
  metric,
}: {
  points: readonly DayPoint[];
  metric: DailyMetricId;
}): React.JSX.Element {
  const spec = dailyMetricOf(metric);
  const tooltip = (props: TooltipProps) => {
    const day = hoveredDay(props);
    return day ? (
      <ChartTooltip title={day.title} rows={dayRows(day, spec)} />
    ) : null;
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Named when a metric draws two series, for the reason TokenSplitChart
          names its stack: a legend-less pair is two unlabelled colours. */}
      {spec.series.length > 1 ? (
        <SeriesLegend
          series={spec.series.map((series) => ({
            label: series.label,
            color: series.color,
          }))}
        />
      ) : null}
      <ResponsiveContainer width="100%" height={HERO_HEIGHT}>
        {spec.shape === 'area' ? (
          <AreaChart data={points as DayPoint[]} margin={CHART_MARGIN}>
            <defs>
              {/* Keyed by metric, because an SVG gradient is referenced by ID and
                  a single one would keep the previous metric's stops after the
                  switch — the fill and the stroke would then disagree about the
                  colour. */}
              <linearGradient
                id={`stats-fill-${metric}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1">
                <stop
                  offset="0%"
                  stopColor={spec.series[0]?.color}
                  stopOpacity={0.55}
                />
                <stop
                  offset="100%"
                  stopColor={spec.series[0]?.color}
                  stopOpacity={0.04}
                />
              </linearGradient>
            </defs>
            <Axes points={points} tickFormatter={spec.axis} />
            <Tooltip cursor={{ stroke: AXIS.stroke }} content={tooltip} />
            {spec.series.map((series) => (
              <Area
                key={series.key}
                type="monotone"
                dataKey={series.key}
                stroke={series.color}
                strokeWidth={2}
                fill={`url(#stats-fill-${metric})`}
                // Deliberately NOT bridged: a day nobody measured is a gap, and
                // bridging it draws a straight line that invents its figure.
                connectNulls={false}
                dot={loneDot(points, series.color)}
                activeDot={{ r: 4, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={points as DayPoint[]} margin={CHART_MARGIN}>
            <Axes points={points} tickFormatter={spec.axis} />
            <Tooltip
              cursor={{ fill: 'var(--color-muted)' }}
              content={tooltip}
            />
            {spec.series.map((series) => (
              <Bar
                key={series.key}
                dataKey={series.key}
                fill={series.color}
                fillOpacity={series.fillOpacity}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Every figure one day measured, for its hover panel, in the order a reader
 * compares them.
 *
 * The plotted metric's rows carry its swatch, so the eye lands on what the chart
 * draws without losing the rest. A figure nothing measured says so rather than
 * reading as zero, and a line count that is a lower bound says so too: "at least
 * +12" is a claim the bare "+12" would not make.
 */
export function dayRows(day: DayPoint, metric: DailyMetric): TooltipRow[] {
  return [
    figureRow('Spend', 'costUsd', day.costUsd, formatUsd, metric),
    figureRow('Tokens', 'totalTokens', day.totalTokens, formatTokens, metric),
    figureRow(
      'Threads',
      'threadsCreated',
      day.threadsCreated,
      formatCount,
      metric,
    ),
    figureRow(
      'Pull requests',
      'pullRequests',
      day.pullRequests,
      formatCount,
      metric,
    ),
    figureRow(
      'Lines added',
      'linesAdded',
      day.linesAdded,
      (value) => formatLineCount(value, 'added'),
      metric,
      day.linesPartial,
    ),
    figureRow(
      'Lines removed',
      'linesRemoved',
      day.linesRemoved,
      (value) => formatLineCount(value, 'removed'),
      metric,
      day.linesPartial,
    ),
    figureRow(
      'Avg time per thread',
      'avgWorkedMs',
      day.avgWorkedMs,
      formatDuration,
      metric,
    ),
    { label: 'Turns', value: formatTurns(day.turns) },
  ];
}

function figureRow(
  label: string,
  key: DailySeriesKey,
  value: number | null,
  format: (value: number) => string,
  metric: DailyMetric,
  lowerBound = false,
): TooltipRow {
  return {
    label,
    value:
      value === null ? '' : `${lowerBound ? 'at least ' : ''}${format(value)}`,
    color: metric.series.find((series) => series.key === key)?.color,
    unmeasured: value === null,
  };
}

/**
 * The running total across the period — how fast this is adding up.
 *
 * Reads a question the daily chart cannot answer: a fortnight of modest days
 * and a fortnight with one huge day look completely different per-day and can
 * land in the same place, and it is where they land that a budget is about.
 *
 * Monotonic by construction (`cumulativeUsd` only ever grows), so a flat stretch
 * is a real statement — nothing was spent — rather than missing data.
 */
export function CumulativeSpendChart({
  points,
}: {
  points: readonly DayPoint[];
}): React.JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={SUPPORT_HEIGHT}>
      <LineChart data={points as DayPoint[]} margin={CHART_MARGIN}>
        <Axes points={points} tickFormatter={formatUsdAxis} />
        <Tooltip
          cursor={{ stroke: AXIS.stroke }}
          content={(props: TooltipProps) => {
            const day = hoveredDay(props);
            return day ? (
              <ChartTooltip
                title={day.title}
                rows={[
                  {
                    label: 'Total so far',
                    value: formatUsd(day.cumulativeUsd),
                    color: SERIES.spend,
                  },
                  {
                    label: 'That day',
                    value: day.costUsd === null ? '' : formatUsd(day.costUsd),
                    unmeasured: day.costUsd === null,
                  },
                ]}
              />
            ) : null;
          }}
        />
        <Line
          type="monotone"
          dataKey="cumulativeUsd"
          stroke={SERIES.spend}
          strokeWidth={2}
          dot={loneDot(points, SERIES.spend)}
          activeDot={{ r: 4, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * Prompt against completion tokens, stacked per day.
 *
 * Split rather than summed because the two are priced differently and behave
 * differently — a day heavy on input is a day of large contexts, one heavy on
 * output is a day of long generations, and one summed bar hides which.
 *
 * Recharts draws nothing for a null, so an unreported half is absent from the
 * stack instead of sitting on the axis as a measured zero.
 */
export function TokenSplitChart({
  points,
}: {
  points: readonly DayPoint[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {/* Named, because a stack of two is unreadable otherwise — and on real
          data one segment routinely dwarfs the other, so the smaller cannot be
          identified by looking at it. */}
      <SeriesLegend
        series={[
          { label: 'In', color: SERIES.tokensIn },
          { label: 'Out', color: SERIES.tokensOut },
        ]}
      />
      <ResponsiveContainer width="100%" height={SUPPORT_HEIGHT}>
        <BarChart data={points as DayPoint[]} margin={CHART_MARGIN}>
          <Axes points={points} tickFormatter={formatTokens} />
          <Tooltip
            cursor={{ fill: 'var(--color-muted)' }}
            content={(props: TooltipProps) => {
              const day = hoveredDay(props);
              return day ? (
                <ChartTooltip
                  title={day.title}
                  rows={[
                    {
                      label: 'In',
                      value:
                        day.inputTokens === null
                          ? ''
                          : formatTokens(day.inputTokens),
                      color: SERIES.tokensIn,
                      unmeasured: day.inputTokens === null,
                    },
                    {
                      label: 'Out',
                      value:
                        day.outputTokens === null
                          ? ''
                          : formatTokens(day.outputTokens),
                      color: SERIES.tokensOut,
                      unmeasured: day.outputTokens === null,
                    },
                  ]}
                />
              ) : null;
            }}
          />
          <Bar
            dataKey="inputTokens"
            stackId="tokens"
            fill={SERIES.tokensIn}
            isAnimationActive={false}
          />
          <Bar
            dataKey="outputTokens"
            stackId="tokens"
            fill={SERIES.tokensOut}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
