import { cn } from '../../components/ui/utils';
import { NOT_MEASURED } from '../stats-format';

/**
 * Chart colours, named as the TOKENS themselves.
 *
 * Recharts takes colours as SVG attribute strings, and `var(--color-chart-1)`
 * IS a legal one — so the palette stays a reference into `global.css` rather
 * than a copy of its values. That matters twice over here: the renderer's eslint
 * config makes a colour literal an error, and a hardcoded hex would not follow
 * the theme when the tokens change underneath it.
 */
export const SERIES = {
  spend: 'var(--color-chart-1)',
  spendSoft: 'var(--color-chart-2)',
  cumulative: 'var(--color-chart-3)',
  tokensIn: 'var(--color-chart-4)',
  tokensOut: 'var(--color-chart-2)',
} as const;

/**
 * The palette for breakdown rows, by POSITION.
 *
 * The warm chart ramp, not the avatar hues the ring used. A ring NEEDED hues far
 * apart — its slices touch, and colour was the only thing tying a wedge to its
 * legend entry. A ranked row carries its own label on the same line, so colour
 * identifies nothing and is free to be cohesive instead: saturated blue and
 * purple bars read as a foreign element on a page that is otherwise entirely
 * cream and caramel.
 *
 * Indexing wraps, so a breakdown longer than the ramp repeats rather than
 * running out — which matters now that the list has no fold and no length limit.
 */
const CATEGORY_TOKENS = [
  'var(--color-chart-1)',
  'var(--color-chart-3)',
  'var(--color-chart-2)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
] as const;

/** The category colour at `index`, wrapping past the end of the palette. */
export function categoryToken(index: number): string {
  // `noUncheckedIndexedAccess` is on, and a modulo into a non-empty tuple can
  // never miss — but the compiler cannot know that, and the fallback is one
  // character cheaper than an assertion.
  return CATEGORY_TOKENS[index % CATEGORY_TOKENS.length] ?? CATEGORY_TOKENS[0];
}

/** Axis + grid styling, shared so the three time charts line up exactly. */
export const AXIS = {
  stroke: 'var(--color-border)',
  tick: {
    fill: 'var(--color-muted-foreground)',
    fontSize: 11,
  },
} as const;

/**
 * The chart area's inner padding.
 *
 * The right margin is the widest because the LAST x tick is centred on the last
 * point, which sits on the plot's right edge — at 8px its label was clipped
 * mid-word ("Aug 1" for "Aug 16"), and the final day is the one a reader looks
 * for first.
 */
export const CHART_MARGIN = { top: 8, right: 24, bottom: 0, left: 8 } as const;

/** A named series with its colour — one row of a {@link SeriesLegend}. */
export interface SeriesKey {
  label: string;
  color: string;
}

/**
 * Which colour is which series.
 *
 * Needed wherever a chart draws more than one: a stack of two token series is
 * unreadable without it, and doubly so on real data, where one segment can be
 * so much larger than the other that the smaller is a sliver.
 */
export function SeriesLegend({
  series,
}: {
  series: readonly SeriesKey[];
}): React.JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((entry) => (
        <li
          key={entry.label}
          className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/** One row of a tooltip: a swatch, a name, and the figure. */
export interface TooltipRow {
  label: string;
  /** Already formatted — the tooltip does not know what units it is showing. */
  value: string;
  /** A series colour, or undefined for a row that names no series. */
  color?: string;
  /** True when the figure was never measured, so it reads as such. */
  unmeasured?: boolean;
}

/**
 * The shared hover panel.
 *
 * Real DOM rather than something the chart library paints, which is the whole
 * reason for choosing an SVG chart library here: the panel is built from the
 * same tokens as every other surface in the app, and a not-measured figure can
 * be SAID rather than left as a blank the reader has to interpret.
 */
export function ChartTooltip({
  title,
  rows,
}: {
  title: string;
  rows: readonly TooltipRow[];
}): React.JSX.Element {
  return (
    <div className="pointer-events-none rounded-lg border border-border/60 bg-popover px-3 py-2 shadow-panel-lg">
      <p className="mb-1.5 text-xs font-medium text-popover-foreground">
        {title}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center gap-2 text-xs text-muted-foreground">
            {row.color ? (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
            ) : null}
            <span className="flex-1 whitespace-nowrap">{row.label}</span>
            <span
              className={cn(
                'shrink-0 pl-3 font-medium tabular-nums',
                row.unmeasured ? 'text-muted-foreground' : 'text-foreground',
              )}>
              {row.unmeasured ? NOT_MEASURED : row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
