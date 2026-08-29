import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
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

import { cn } from '../components/ui/utils';
import {
  AXIS,
  categoryToken,
  CHART_MARGIN,
  ChartTooltip,
  SeriesLegend,
} from '../stats/charts/chart-theme';
import { SectionLabel } from './block-shell';
import {
  type ChartRow,
  chartRows,
  type ChartSpec,
  seriesKey,
  X_KEY,
} from './chart-payload';

/**
 * A chart an agent handed over as typed numbers, plotted by the app.
 *
 * The second card of the render family, and it reuses the Stats page's chart
 * theme wholesale — `categoryToken`, `AXIS`, `CHART_MARGIN`, `ChartTooltip`,
 * `SeriesLegend` — rather than growing a second one. That is the point of the
 * theme being a module: a plot in a transcript and a plot on the Stats page are
 * the same object drawn in two places, and the moment they diverge the app has
 * two chart languages. The tooltip in particular is REAL DOM built from the
 * app's tokens, not something the library paints, which is why an unmeasured
 * point can be said rather than left blank.
 *
 * Plot height is fixed and small: this sits in a conversation, between two
 * paragraphs, and a chart tall enough to push the reply off screen would cost
 * more than it shows.
 */

const PLOT_HEIGHT = 190;

/** How many x ticks to aim for, thinning them the way the time charts do. */
const TICK_TARGET = 8;

/**
 * The agent's numbers are unitless to us — seconds, kilobytes, percentages —
 * so the only safe formatting is to keep them readable and never round to a
 * different figure than was reported.
 */
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

/**
 * A stroke pattern per series, on TOP of its colour.
 *
 * Because colour alone does not carry it here. `chart-theme`'s own note says
 * the category ramp was chosen for RANKED ROWS, where each row carries its own
 * label on the same line and "colour identifies nothing" — so a cohesive warm
 * ramp was the right call there. A multi-series line chart is the opposite
 * case: the legend is the only thing tying a curve to its name, and five shades
 * of one caramel hue are not five identities. Measured on the first real chart
 * this drew — two lines, both plainly readable as *lines*, neither obviously
 * the one in the legend.
 *
 * A pattern rather than a second, louder palette: the ramp is what makes the
 * app look like itself, and a dash is legible in greyscale and to a reader who
 * cannot separate the hues at all. Index 0 stays solid so the common
 * single-series chart is untouched.
 *
 * Lines only. Bars sit side by side and areas stack, so neither has two shapes
 * overlapping in the same space — a dashed outline there is noise buying
 * nothing.
 */
const SERIES_DASH = [undefined, '6 3', '2 3', '8 3 2 3', '1 3'] as const;

function dashOf(index: number): string | undefined {
  return SERIES_DASH[index % SERIES_DASH.length];
}

/** What recharts hands a tooltip; typed here for the reason `time-charts` is. */
interface TooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: readonly { payload?: ChartRow }[];
}

export function ChartCard({ chart }: { chart: ChartSpec }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const rows = chartRows(chart);
  const interval = Math.max(0, Math.ceil(rows.length / TICK_TARGET) - 1);
  // A line and an area are drawn BETWEEN points, so a single-point series has
  // nothing to draw and the card would render as bare axes. Same fix, and same
  // reason, as `loneDot` in the Stats time charts — inlined rather than shared
  // because that helper is typed to the ledger's own point shape.
  const lonely = rows.length === 1;
  const heading = [
    chart.title ?? 'Chart',
    chart.series.length > 1 ? `${chart.series.length} series` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  const tooltip = (props: TooltipProps): React.JSX.Element | null => {
    const row = props.active ? (props.payload?.[0]?.payload ?? null) : null;
    if (row === null) {
      return null;
    }
    return (
      <ChartTooltip
        title={String(row[X_KEY] ?? '')}
        rows={chart.series.map((series, index) => {
          const value = row[seriesKey(index)];
          const measured = typeof value === 'number';
          return {
            label: series.name,
            value: measured ? NUMBER.format(value) : '',
            color: categoryToken(index),
            // A gap is SAID rather than shown as a blank or a zero: the whole
            // reason nulls survive the payload is that they are not zeroes.
            unmeasured: !measured,
          };
        })}
      />
    );
  };

  const axes = (
    <>
      <CartesianGrid
        stroke={AXIS.stroke}
        strokeDasharray="3 3"
        vertical={false}
      />
      <XAxis
        dataKey={X_KEY}
        stroke={AXIS.stroke}
        tick={AXIS.tick}
        interval={interval}
      />
      <YAxis
        stroke={AXIS.stroke}
        tick={AXIS.tick}
        width={48}
        tickFormatter={(value: number) => NUMBER.format(value)}
      />
      <Tooltip content={tooltip} cursor={{ stroke: AXIS.stroke }} />
    </>
  );

  return (
    <div
      data-slot="chart-card"
      data-open={open}
      data-kind={chart.kind}
      className="min-w-0">
      <SectionLabel>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1">
          <ChevronRight
            aria-hidden="true"
            className={cn('size-3 transition-transform', open && 'rotate-90')}
          />
          {heading}
        </button>
      </SectionLabel>
      {open ? (
        <div className="flex flex-col gap-1">
          {chart.yLabel === null ? null : (
            <p className="m-0 px-1 text-[11px] text-muted-foreground">
              {chart.yLabel}
            </p>
          )}
          <div style={{ height: PLOT_HEIGHT }} className="w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chart.kind === 'bar' ? (
                <BarChart data={rows} margin={CHART_MARGIN}>
                  {axes}
                  {chart.series.map((series, index) => (
                    <Bar
                      key={seriesKey(index)}
                      dataKey={seriesKey(index)}
                      name={series.name}
                      fill={categoryToken(index)}
                      radius={[2, 2, 0, 0]}
                    />
                  ))}
                </BarChart>
              ) : chart.kind === 'area' ? (
                <AreaChart data={rows} margin={CHART_MARGIN}>
                  {axes}
                  {chart.series.map((series, index) => (
                    <Area
                      key={seriesKey(index)}
                      dataKey={seriesKey(index)}
                      name={series.name}
                      // Stacked, because that is what the tool's own
                      // description promises an area chart means: parts of one
                      // total. Overlaid areas would hide the smaller series
                      // behind the larger and say nothing the lines do not.
                      stackId="total"
                      stroke={categoryToken(index)}
                      fill={categoryToken(index)}
                      fillOpacity={0.25}
                      dot={
                        lonely
                          ? { r: 3, strokeWidth: 0, fill: categoryToken(index) }
                          : false
                      }
                    />
                  ))}
                </AreaChart>
              ) : (
                <LineChart data={rows} margin={CHART_MARGIN}>
                  {axes}
                  {chart.series.map((series, index) => (
                    <Line
                      key={seriesKey(index)}
                      dataKey={seriesKey(index)}
                      name={series.name}
                      stroke={categoryToken(index)}
                      strokeWidth={2}
                      strokeDasharray={dashOf(index)}
                      // Left false so a gap READS as a gap. Joining across it
                      // would draw a straight segment through points nobody
                      // measured, which is a claim the agent never made.
                      connectNulls={false}
                      dot={
                        lonely
                          ? { r: 3, strokeWidth: 0, fill: categoryToken(index) }
                          : false
                      }
                    />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
          {chart.xLabel === null ? null : (
            <p className="m-0 text-center text-[11px] text-muted-foreground">
              {chart.xLabel}
            </p>
          )}
          {/* Only where colour is carrying information: one series needs no key
              to tell it from the others. */}
          {chart.series.length > 1 ? (
            <div className="px-1">
              <SeriesLegend
                series={chart.series.map((series, index) => ({
                  label: series.name,
                  color: categoryToken(index),
                  // Only where the curve actually carries one, so a bar or
                  // area chart's key stays the dots it has always been.
                  dash: chart.kind === 'line' ? dashOf(index) : undefined,
                }))}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
