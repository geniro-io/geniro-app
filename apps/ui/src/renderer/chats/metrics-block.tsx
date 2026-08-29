import { Gauge } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import type { MetricSpec, MetricsSpec } from './metrics-payload';

/**
 * A scorecard an agent handed over: a few headline figures with their changes.
 *
 * NOT behind a disclosure, unlike the chart card beside it, and that is the one
 * real decision in this file. A chart is 190px of plot that would push the
 * reply off screen, so it earns a fold; a scorecard is two lines of large text
 * and exists to be read at a glance. A card you have to open before you can
 * glance at it is not a scorecard, it is a link to one.
 *
 * Everything a figure needs is on the wire already formatted — see
 * `metrics-payload.ts`. This file lays out and colours; it parses nothing and
 * computes nothing.
 */

/** How the three sentiments read as colour. */
const SENTIMENT_CLASS = {
  good: 'text-success',
  bad: 'text-destructive',
  // The muted tone rather than the body colour: a delta is context for the
  // figure above it, and a neutral one competing with the figure for attention
  // is the scorecard failing at the only thing it does.
  neutral: 'text-muted-foreground',
} as const;

function Figure({ metric }: { metric: MetricSpec }): React.JSX.Element {
  return (
    <div
      data-slot="metric"
      data-sentiment={metric.sentiment}
      className="flex min-w-0 flex-col gap-0.5">
      {/* The label ABOVE the figure. A scorecard is scanned by looking for the
          thing you want and then reading its number, which is the opposite
          order to a caption underneath. */}
      <span className="truncate text-[11px] text-muted-foreground">
        {metric.label}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        {/* `tabular-nums` so a column of figures lines up on its digits —
            proportional numerals make "1.2 MB" and "82%" sit at different
            widths and the row reads as ragged. */}
        <span className="truncate text-lg leading-tight font-medium tabular-nums">
          {metric.value}
        </span>
        {metric.delta === null ? null : (
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              SENTIMENT_CLASS[metric.sentiment],
            )}>
            {metric.delta}
          </span>
        )}
      </span>
      {metric.note === null ? null : (
        <span className="text-[11px] leading-snug text-muted-foreground break-words">
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
          show. Wrapping to two rows costs nothing. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-4 gap-y-2.5 rounded-lg border border-border bg-card p-3">
        {metrics.metrics.map((metric, index) => (
          <Figure key={index} metric={metric} />
        ))}
      </div>
    </div>
  );
}
