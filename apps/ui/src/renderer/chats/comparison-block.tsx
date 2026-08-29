import { Check, Columns3 } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import type { ComparisonSpec } from './comparison-payload';
import type { Sentiment } from './metrics-payload';

/**
 * A decision table an agent handed over: options across the top, criteria down
 * the side, and the answer underneath.
 *
 * The card that has to beat MARKDOWN, since a markdown table renders perfectly
 * well in this transcript. It earns its place on the two things the table
 * cannot hold, and the layout is built around exactly those two:
 *
 * 1. A per-cell VERDICT, tinted. The whole point is that the winning option's
 *    column looks greener from a metre away, so the tint is on the CELL rather
 *    than on a glyph inside it — colour has to be the largest thing the eye
 *    gets, not a mark it has to find first.
 * 2. The RECOMMENDATION, which marks its column at the head AND states its
 *    reason at the foot. Only the head would leave a verdict with no argument;
 *    only the foot would leave the reader matching a name back to a column.
 *
 * Not behind a disclosure, on the scorecard's rule: this is the answer to a
 * question that was just asked, and folding away an answer is absurd.
 *
 * The table scrolls HORIZONTALLY inside its own container rather than letting
 * the page do it — the repo rule for wide content, and the reason the option
 * cap is four: past that the thing a side-by-side is for stops working.
 */

/** How a verdict tints its cell. Neutral is untinted, not grey-tinted. */
const CELL_CLASS: Record<Sentiment, string> = {
  good: 'bg-success/10 text-foreground',
  bad: 'bg-destructive/10 text-foreground',
  neutral: '',
};

export function ComparisonCard({
  comparison,
}: {
  comparison: ComparisonSpec;
}): React.JSX.Element {
  const { options, criteria, recommendation, recommendedIndex } = comparison;
  return (
    <div data-slot="comparison-card" className="min-w-0">
      <SectionLabel>
        <span className="flex min-w-0 items-center gap-1.5">
          <Columns3 aria-hidden="true" className="size-3 shrink-0" />
          {comparison.title}
        </span>
      </SectionLabel>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {/* The corner cell: empty, because the criteria column has no
                  heading worth writing — "Criterion" is a word that tells the
                  reader nothing they cannot see. */}
              <th className="w-px px-3 py-2 text-left align-bottom" />
              {options.map((option, index) => (
                <th
                  key={index}
                  data-slot="comparison-option"
                  data-recommended={index === recommendedIndex}
                  scope="col"
                  className={cn(
                    'min-w-[7rem] px-3 py-2 text-left align-bottom font-medium',
                    index === recommendedIndex && 'bg-primary/8',
                  )}>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1">
                      {index === recommendedIndex ? (
                        <Check
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-primary"
                        />
                      ) : null}
                      <span className="min-w-0 break-words">{option.name}</span>
                    </span>
                    {option.note === null ? null : (
                      <span className="text-[11px] leading-snug font-normal text-muted-foreground break-words">
                        {option.note}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {criteria.map((criterion, row) => (
              <tr key={row} className="border-t border-border">
                <th
                  scope="row"
                  // Wraps. `whitespace-nowrap` kept rows a line shorter and
                  // widened the table by whatever the longest criterion is —
                  // enough to force a horizontal scroll the cells themselves
                  // never needed. A row is already as tall as its tallest cell,
                  // so wrapping the label costs nothing.
                  className="px-3 py-2 text-left align-top text-xs font-normal text-muted-foreground">
                  {criterion.label}
                </th>
                {criterion.cells.map((cell, column) => (
                  <td
                    key={column}
                    data-slot="comparison-cell"
                    data-verdict={cell.verdict}
                    className={cn(
                      'px-3 py-2 align-top text-xs leading-snug break-words',
                      CELL_CLASS[cell.verdict],
                    )}>
                    {/* An em dash for a cell the agent left empty. A blank
                        looks like a rendering failure; a dash says "nothing
                        here", which is what the daemon's blank means. */}
                    {cell.value === '' ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      cell.value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {recommendation === null ? null : (
        <p
          data-slot="comparison-recommendation"
          className="m-0 mt-1.5 text-xs leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">
            {recommendation.option}
          </span>
          {' — '}
          {recommendation.reason}
        </p>
      )}
    </div>
  );
}
