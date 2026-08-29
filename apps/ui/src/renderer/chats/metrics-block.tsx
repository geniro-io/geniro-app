import { Gauge } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import type { MetricSpec, MetricsSpec } from './metrics-payload';

/**
 * A scorecard an agent handed over: a few headline figures with their changes.
 *
 * NOT behind a disclosure, unlike the chart card beside it, and that is the one
 * structural decision here. A chart is 190px of plot that would push the reply
 * off screen, so it earns a fold; a scorecard is a couple of lines of large
 * text and exists to be read at a glance. A card you have to open before you
 * can glance at it is not a scorecard, it is a link to one.
 *
 * The LAYOUT is one tile per figure rather than columns in a shared box, and
 * that is not decoration. Columns floating in one box have no edge to align
 * against, so a figure carrying a note grew taller than its neighbours and the
 * row read as broken rather than as one item having more to say; the tiles
 * stretch to a common height, so a note lengthens a panel instead of unbalancing
 * a row. It is also what lets the grid wrap without the wrapped figures looking
 * orphaned.
 *
 * Everything on the wire is already formatted — see `metrics-payload.ts`. This
 * file lays out and colours; it parses nothing and computes nothing.
 */

/**
 * How the three sentiments read as a delta pill.
 *
 * A tinted pill rather than coloured text, because the delta is the second
 * thing on the tile and has to be findable next to a figure twice its size —
 * bare coloured text at 11px loses that contest. `neutral` gets the muted
 * surface rather than no surface at all, so the three read as one control in
 * three states instead of two pills and a stray word.
 */
const DELTA_CLASS = {
  good: 'bg-success/10 text-success',
  bad: 'bg-destructive/10 text-destructive',
  neutral: 'bg-muted text-muted-foreground',
} as const;

function Figure({ metric }: { metric: MetricSpec }): React.JSX.Element {
  return (
    <div
      data-slot="metric"
      data-sentiment={metric.sentiment}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
      {/* The label ABOVE the figure. A scorecard is scanned by looking for the
          thing you want and then reading its number, which is the opposite
          order to a caption underneath.

          Sentence case, NOT the uppercase the section caption uses. Both are
          small muted text a line apart, so styling them alike collapsed two
          levels of hierarchy into one — seen live, a card headed "TYPESCRIPT
          FILES IN SANDBOX/" over a tile labelled "TYPESCRIPT FILES" read as
          the same caption printed twice. The caption above names the card; a
          label here names one figure inside it. */}
      <span className="truncate text-[11px] font-medium text-muted-foreground">
        {metric.label}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* The figure is the point of the card, so it is the biggest thing on
            it. `tabular-nums` so a wrapped row lines up on its digits —
            proportional numerals make "1.2 MB" and "82%" sit at different
            widths and the row reads as ragged. */}
        <span
          data-slot="metric-value"
          className="min-w-0 truncate text-2xl leading-none font-semibold tabular-nums">
          {metric.value}
        </span>
        {metric.delta === null ? null : (
          <span
            data-slot="metric-delta"
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-tight font-medium tabular-nums',
              DELTA_CLASS[metric.sentiment],
            )}>
            {metric.delta}
          </span>
        )}
      </span>
      {metric.note === null ? null : (
        // Directly under the figure, in normal flow — NOT pushed to the bottom
        // of the stretched tile. Bottom-pinning looked tidier in the abstract
        // and read as broken with five figures on screen: one long note set the
        // row's height, and every other note floated a centimetre below the
        // number it belongs to, reading as an unrelated line rather than as
        // that figure's footnote. Trailing space inside a short tile is what a
        // row of panels is supposed to look like.
        <span
          data-slot="metric-note"
          className="text-[11px] leading-snug text-muted-foreground break-words">
          {metric.note}
        </span>
      )}
    </div>
  );
}

export function MetricsCard({
  metrics,
}: {
  metrics: MetricsSpec;
}): React.JSX.Element {
  return (
    <div data-slot="metrics-card" className="min-w-0">
      <SectionLabel>
        <span className="flex min-w-0 items-center gap-1.5">
          <Gauge aria-hidden="true" className="size-3 shrink-0" />
          {metrics.title ?? 'Figures'}
        </span>
      </SectionLabel>
      {/* `auto-fit` with a min track rather than a fixed column count: the
          transcript narrows with the side panel, and a scorecard that keeps
          four columns in a 300px pane truncates every figure it exists to
          show. Wrapping to two rows costs nothing.

          The track is 11rem because that is what fits a figure AND its delta
          pill on one line. Measured at 9rem with five figures: `1.2 MB` plus
          `−120 kB` overran by a few pixels, so that one delta dropped below its
          number while the four beside it stayed inline — the row read as a
          mistake rather than as a layout. A wider track means one column fewer
          and every delta in the same place. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
        {metrics.metrics.map((metric, index) => (
          <Figure key={index} metric={metric} />
        ))}
      </div>
    </div>
  );
}
