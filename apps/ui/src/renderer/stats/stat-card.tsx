import type { LucideIcon } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { NOT_MEASURED, NOT_MEASURED_TITLE } from './stats-format';

/**
 * The enclosure every figure on this page sits in — ONE surface, ruled into
 * cells.
 *
 * It replaced a row of individually-bordered `Card`s, which is the same move
 * the Settings panels made and for the same reason: eight cards is eight
 * borders, eight radii and eight shadows drawn around eight short numbers, so
 * the chrome outweighed the content it was framing. Ruling one surface says the
 * cells belong together, which is the true statement — they are all one
 * period's reading.
 *
 * The rules are the container's own background showing through a `gap-px`,
 * NEVER `divide-x`. Tailwind's divide utilities put a border on every child but
 * the first IN DOCUMENT ORDER, so on a wrapping grid the first cell of the
 * second row wears a left rule that opens onto nothing. A one-pixel gap over a
 * `bg-border` ground is correct on every row by construction, needs no
 * per-child exceptions, and clips to the enclosure's own radius.
 */
const CELL_GRID =
  'grid gap-px overflow-hidden rounded-xl border border-border bg-border shadow-panel-sm';

/** One ruled surface of figures. `className` carries the column count. */
export function StatGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section data-slot="stat-grid" className={cn(CELL_GRID, className)}>
      {children}
    </section>
  );
}

/**
 * One measured figure, as a cell of a {@link StatGrid}.
 *
 * The icon is not decoration: a reader looking for spend or for time finds the
 * shape before they finish reading the label. It is a bare glyph beside the
 * label rather than the filled tile it used to sit in — a 32px accent square
 * per cell was the loudest thing in the grid, so eight of them read as eight
 * buttons rather than as eight numbers.
 *
 * A NOT-MEASURED value is styled DOWN — muted, lighter weight — because it is
 * not a figure at all, and giving it the same visual weight as a real one is
 * how "—" starts reading as a number.
 */
export function StatCell({
  label,
  value,
  icon,
  hint,
  footnote,
  size = 'md',
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  hint?: string;
  /** A second line under the figure — a rate, a share, a denominator. */
  footnote?: string;
  /**
   * `lead` is the figure a reader opened the page for; `md` is the rest.
   *
   * TYPE carries the hierarchy rather than a wider cell, so the grid stays a
   * plain equal-column one at every breakpoint — a spanning hero cell has to be
   * re-spanned at each, and lands as a half-width orphan on the breakpoint
   * nobody checked.
   */
  size?: 'lead' | 'md';
}): React.JSX.Element {
  // Bound to a local rather than renamed in the destructure: a PascalCase
  // PARAMETER is an eslint error, and JSX needs the capital to read it as a
  // component. Same shape `nav-rail` uses for the same reason.
  const Icon = icon;
  const unmeasured = value === NOT_MEASURED;
  return (
    <div
      data-slot="stat"
      className={cn(
        'flex min-w-0 flex-col gap-1 bg-card px-4',
        size === 'lead' ? 'py-5' : 'py-4',
      )}
      title={unmeasured ? NOT_MEASURED_TITLE : hint}>
      <span
        data-slot="stat-label"
        className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? (
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      <span
        data-slot="stat-value"
        className={cn(
          'truncate tabular-nums',
          size === 'lead'
            ? 'text-3xl font-semibold tracking-tight'
            : 'text-xl font-semibold',
          unmeasured && 'font-normal text-muted-foreground',
        )}>
        {value}
      </span>
      {footnote ? (
        <span className="text-xs leading-snug text-muted-foreground">
          {footnote}
        </span>
      ) : null}
    </div>
  );
}
