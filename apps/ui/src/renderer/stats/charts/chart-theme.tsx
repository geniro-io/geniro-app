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
 *
 * Colour on this page names the QUANTITY, and there are two: money is caramel,
 * tokens are cool. That is a rule the charts did not follow — the daily spend
 * area was caramel while the cumulative spend line directly under it was teal,
 * so one quantity was drawn in two colours on two panels a scroll apart, and a
 * reader who takes a repeated colour to mean something was being misled by
 * both. Within one chart the series still have to differ from each other, which
 * is what the two token hues are for; ACROSS charts, the hue answers "what is
 * this measuring".
 */
export const SERIES = {
  /** Money — the daily area and the running total, which are one quantity. */
  spend: 'var(--color-chart-1)',
  /** Tokens — the daily area when it is plotting them, and the stack's input. */
  tokens: 'var(--color-chart-3)',
  tokensIn: 'var(--color-chart-3)',
  tokensOut: 'var(--color-chart-4)',
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
  /**
   * The series' stroke pattern, where it has one — an SVG `stroke-dasharray`.
   *
   * Optional, and absent for every chart on this page: a legend entry is a
   * swatch, and a swatch only needs to show a pattern the CURVE has. It exists
   * because the transcript's chart card gives multi-series lines a dash on top
   * of their colour (the ramp is five shades of one hue, which is not five
   * identities), and a legend that answered such a chart with plain dots would
   * show the reader a key they cannot match to anything on the plot.
   */
  dash?: string | undefined;
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
          {entry.dash === undefined ? (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
          ) : (
            // A short piece of the actual line, drawn with the actual pattern —
            // the swatch has to be the thing it stands for, or it is a second
            // code the reader has to learn.
            <svg
              aria-hidden="true"
              width="14"
              height="8"
              className="shrink-0"
              viewBox="0 0 14 8">
              <line
                x1="0"
                y1="4"
                x2="14"
                y2="4"
                stroke={entry.color}
                strokeWidth="2"
                strokeDasharray={entry.dash}
              />
            </svg>
          )}
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
