import { cva } from 'class-variance-authority';

import { cn } from './ui/utils';

/** One column of a {@link FigureTable}. */
export interface FigureColumn<Row> {
  header: string;
  /** Figures read right-aligned, labels left. */
  align?: 'start' | 'end';
  cell: (row: Row) => React.ReactNode;
  /** A tooltip for the cell, when its text may be cut. */
  title?: (row: Row) => string | undefined;
}

const cellVariants = cva('px-2 py-1.5 align-baseline', {
  variants: {
    align: {
      start: 'text-left',
      end: 'text-right tabular-nums whitespace-nowrap',
    },
  },
  defaultVariants: { align: 'start' },
});

/**
 * A compact ruled table of daemon figures: one row per thing measured, one column
 * per figure. A figure nothing measured is the caller's dash, never a zero.
 */
export function FigureTable<Row>({
  columns,
  rows,
  rowKey,
  emptyLabel,
  ariaLabel,
  className,
}: {
  columns: readonly FigureColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  emptyLabel: string;
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <p
        data-slot="figure-table-empty"
        className="text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className={cn('min-w-0 overflow-x-auto', className)}>
      <table
        data-slot="figure-table"
        aria-label={ariaLabel}
        className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={cn(
                  cellVariants({ align: column.align }),
                  'font-medium',
                )}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-border/60 last:border-b-0">
              {columns.map((column) => (
                <td
                  key={column.header}
                  title={column.title?.(row)}
                  className={cellVariants({ align: column.align })}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
