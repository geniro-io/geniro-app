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
import { formatTurns, formatUsdAxis } from '../stats-format';
import {
  AXIS,
  CHART_MARGIN,
  ChartTooltip,
  SERIES,
  SeriesLegend,
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
 * The page's centrepiece: what each day cost, or how many tokens it moved.
 *
 * An area rather than columns because the series is dense and ordered — the
 * shape of a fortnight's spend is the thing being read, and a filled curve shows
 * it at a glance where 30 separate bars ask the eye to compare heights.
 *
 * A day nobody reported is left as `null`, and `connectNulls` stays FALSE so the
 * curve breaks there. Bridging it would draw a straight line across the gap —
 * inventing a figure for a day on which nothing was measured, which is the
 * single claim this page must never make.
 */
export function DailySeriesChart({
  points,
  metric,
}: {
  points: readonly DayPoint[];
  metric: 'cost' | 'tokens';
}): React.JSX.Element {
  const isCost = metric === 'cost';
  const dataKey = isCost ? 'costUsd' : 'totalTokens';
  const format = isCost ? formatUsd : formatTokens;
  // Exact in the tooltip, compact on the axis — see `formatUsdAxis`.
  const axisFormat = isCost ? formatUsdAxis : formatTokens;

  return (
    <ResponsiveContainer width="100%" height={HERO_HEIGHT}>
      <AreaChart data={points as DayPoint[]} margin={CHART_MARGIN}>
        <defs>
          <linearGradient id="stats-spend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES.spend} stopOpacity={0.55} />
            <stop offset="100%" stopColor={SERIES.spend} stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <Axes points={points} tickFormatter={axisFormat} />
        <Tooltip
          cursor={{ stroke: AXIS.stroke }}
          content={(props: TooltipProps) => {
            const day = hoveredDay(props);
            if (!day) {
              return null;
            }
            const value = isCost ? day.costUsd : day.totalTokens;
            return (
              <ChartTooltip
                title={day.title}
                rows={[
                  {
                    label: isCost ? 'Spend' : 'Tokens',
                    value: value === null ? '' : format(value),
                    color: SERIES.spend,
                    unmeasured: value === null,
                  },
                  { label: 'Turns', value: formatTurns(day.turns) },
                ]}
              />
            );
          }}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={SERIES.spend}
          strokeWidth={2}
          fill="url(#stats-spend-fill)"
          connectNulls={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
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
                    color: SERIES.cumulative,
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
          stroke={SERIES.cumulative}
          strokeWidth={2}
          dot={false}
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
