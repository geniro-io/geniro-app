import { cn } from './utils';

/** One column of a {@link BarChart}. */
export interface BarChartPoint {
  /** Stable identity for the column — never rendered. */
  key: string;
  /** The x-axis label. Only some are drawn when the series is dense. */
  label: string;
  /**
   * The measured value, or null when this point was NOT MEASURED.
   *
   * Null and 0 are drawn differently on purpose: a day on which an agent
   * reported no cost is not a day that cost nothing, and a chart that flattened
   * the two would state the stronger claim.
   */
  value: number | null;
  /** The sentence shown on hover. Composed by the caller, who knows the units. */
  title?: string;
}

/** How many x labels to aim for, however many columns there are. */
const LABEL_TARGET = 8;

/**
 * A column chart for a dense, ordered series — the shape of "per day over a
 * period".
 *
 * Built from flex-sized elements rather than a plotted SVG: the columns are
 * evenly spaced by construction, the chart reflows with its container at any
 * width without viewBox arithmetic, and every colour stays a token class
 * instead of an attribute the design-system rule cannot see.
 *
 * A measured-but-zero column keeps a hairline so the series reads as
 * continuous; an unmeasured one draws nothing at all, and the two are told
 * apart in the hover text rather than by guessing from the picture.
 */
export function BarChart({
  points,
  height = 160,
  ariaLabel,
  className,
}: {
  points: readonly BarChartPoint[];
  /** Plot height in px; the width always fills the container. */
  height?: number;
  /** Accessible name — say what the series measures and over what period. */
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  const measured = points.filter(
    (point): point is BarChartPoint & { value: number } => point.value !== null,
  );
  const peak = measured.reduce((max, point) => Math.max(max, point.value), 0);
  // Every label would collide past a couple of weeks, so thin them to a target
  // count and always keep the last one — the right edge is "now", which is the
  // column a reader looks for first.
  const labelEvery = Math.max(1, Math.ceil(points.length / LABEL_TARGET));

  return (
    <div
      data-slot="bar-chart"
      role="img"
      aria-label={ariaLabel}
      className={cn('flex w-full flex-col gap-2', className)}>
      <div
        className="flex w-full items-end gap-px border-b border-border"
        style={{ height }}>
        {points.map((point) => (
          <Column key={point.key} point={point} peak={peak} />
        ))}
      </div>
      <div className="flex w-full gap-px text-[11px] text-muted-foreground">
        {points.map((point, index) => (
          <div key={point.key} className="min-w-0 flex-1 truncate text-center">
            {index % labelEvery === 0 || index === points.length - 1
              ? point.label
              : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function Column({
  point,
  peak,
}: {
  point: BarChartPoint;
  peak: number;
}): React.JSX.Element {
  // A flat series (every value equal, or all zero) has no meaningful scale —
  // drawing it against a zero peak would divide by zero, and drawing it full
  // height would imply a maximum nothing established.
  const fraction = point.value !== null && peak > 0 ? point.value / peak : 0;
  return (
    <div
      title={point.title}
      data-slot="bar-chart-column"
      className="group flex min-w-0 flex-1 items-end justify-center self-stretch">
      {point.value === null ? null : (
        <div
          data-slot="bar-chart-bar"
          className="w-full rounded-t-[2px] bg-chart-1 transition-colors group-hover:bg-primary"
          // Percentage of the plot, with a floor so a real but tiny value is
          // still visible rather than rounding away to nothing.
          style={{ height: `${Math.max(fraction * 100, 1.5)}%` }}
        />
      )}
    </div>
  );
}
