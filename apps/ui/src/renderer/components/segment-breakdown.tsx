import type * as React from 'react';

import { cn } from './ui/utils';

/** One part of a whole: a bar segment and its legend row. */
export interface BreakdownSegment {
  key: string;
  label: React.ReactNode;
  /** The part's size, in the same unit as `denominator`. */
  value: number;
  /** A background utility for its segment and dot (`bg-*` token). */
  colorClass: string;
  /** The row's figures, right-aligned in columns. */
  figures: React.ReactNode[];
}

/**
 * What a budget is made of: one bar, segments proportional to `denominator`,
 * over a legend row per segment — the context readout's window and an agent
 * node's always-on instructions both draw it.
 *
 * A `remainder` row is listed muted and drawn as no segment, so the bar's empty
 * tail stays what the readout means by it (the window's free space).
 */
export function SegmentBreakdown({
  segments,
  denominator,
  remainder,
}: {
  segments: readonly BreakdownSegment[];
  denominator: number;
  remainder?: { label: React.ReactNode; figures: React.ReactNode[] };
}): React.JSX.Element {
  return (
    <>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={cn('h-full', segment.colorClass)}
            style={{ width: `${share(segment.value, denominator)}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-0.5">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span
              className={cn('size-2 shrink-0 rounded-full', segment.colorClass)}
            />
            <span className="truncate text-foreground">{segment.label}</span>
            <Figures figures={segment.figures} />
          </li>
        ))}
        {remainder ? (
          <li className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full bg-muted" />
            <span className="truncate text-muted-foreground">
              {remainder.label}
            </span>
            <Figures figures={remainder.figures} />
          </li>
        ) : null}
      </ul>
    </>
  );
}

/** The first figure takes the row's slack; later ones sit in fixed columns. */
function Figures({
  figures,
}: {
  figures: React.ReactNode[];
}): React.JSX.Element {
  return (
    <>
      {figures.map((figure, index) => (
        <span
          // Positional by nature: column N is the same figure on every row.
          key={index}
          className={cn(
            'shrink-0 tabular-nums text-muted-foreground',
            index === 0 ? 'ml-auto' : 'w-12 text-right',
          )}>
          {figure}
        </span>
      ))}
    </>
  );
}

/**
 * One segment's width as a percentage.
 *
 * Clamped at both ends: a zero denominator would produce `Infinity%`, and a
 * part reported as larger than the whole (a context category past the window)
 * would push every other segment off the bar.
 */
function share(value: number, of: number): number {
  if (of <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / of) * 100));
}
