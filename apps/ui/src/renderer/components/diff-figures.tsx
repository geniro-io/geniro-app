import { cn } from './ui/utils';

/**
 * `+N −M` — the ONE place the app decides how a diff's size reads.
 *
 * Three surfaces state it (the changes tree's rows, the header's changes chip,
 * a pull request's own row and chip) and only one rule about it is subtle, so
 * it lives here rather than three times:
 *
 * **Null is NOT MEASURED, and never `0`.** A binary file, an untracked file past
 * the read's body budget, a pull request `gh` could not be asked about — all
 * report null, and drawing a zero for them asserts a change of nothing, which is
 * the one thing these figures must never say. Each side is independent, so a
 * file can honestly show `+12` alone.
 *
 * **A measured ZERO is drawn, and MUTED.** It has to be drawn — `+12` alone
 * cannot be told apart from `+12` beside an unmeasured side — and it must not be
 * toned, because a pure addition is most of any diff, so a red `−0` on fifty
 * rows colours the column for loss over files that lost nothing. Same rule the
 * changes dialog states for leaving `modified` muted: the tone is for what is
 * notable.
 */
export function DiffFigures({
  added,
  removed,
  /**
   * `columns` reserves each side's width so figures line up DOWN a list, and
   * keeps the reservation even where a row has nothing measured — that gap is
   * what stops one unmeasured row pulling its neighbours' numbers out of line.
   * `inline` takes its natural width, for a chip in a row of chips where there
   * is nothing below to line up with and the reservation would just be padding.
   */
  layout = 'inline',
  className,
}: {
  added: number | null;
  removed: number | null;
  layout?: 'inline' | 'columns';
  className?: string;
}): React.JSX.Element | null {
  const columns = layout === 'columns';
  if (!columns && added === null && removed === null) {
    return null;
  }
  return (
    <span
      className={cn(
        'flex shrink-0 gap-1.5 font-mono text-xs tabular-nums',
        columns && 'gap-2',
        className,
      )}>
      <span
        className={cn(
          columns && 'w-12 text-right',
          added ? 'text-success' : 'text-muted-foreground',
        )}>
        {added === null ? null : `+${added}`}
      </span>
      <span
        className={cn(
          columns && 'w-10 text-right',
          removed ? 'text-destructive' : 'text-muted-foreground',
        )}>
        {removed === null ? null : `−${removed}`}
      </span>
    </span>
  );
}
