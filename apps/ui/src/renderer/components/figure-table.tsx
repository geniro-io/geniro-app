import { cva } from 'class-variance-authority';
import { ArrowDown } from 'lucide-react';

import { cn } from './ui/utils';

/** One column of a {@link FigureTable}. */
export interface FigureColumn<Row> {
  header: string;
  /** Figures read right-aligned, labels left. */
  align?: 'start' | 'end';
  cell: (row: Row) => React.ReactNode;
  /** A tooltip for the cell, when its text may be cut. */
  title?: (row: Row) => string | undefined;
  /** Takes the width the other columns leave, for a bar drawn in the cell. */
  fill?: boolean;
  /** Pressing the header sorts the table by this key, when the table is sortable. */
  sortKey?: string;
}

/** Which column a sortable {@link FigureTable} is sorted by, and how a header press asks for another. */
export interface FigureTableSort {
  key: string;
  onSort: (key: string) => void;
}

const cellVariants = cva('px-2 py-1.5 align-baseline', {
  variants: {
    align: {
      start: 'text-left',
      end: 'text-right tabular-nums whitespace-nowrap',
    },
    fill: { true: 'w-full', false: '' },
  },
  defaultVariants: { align: 'start', fill: false },
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
  sort,
}: {
  columns: readonly FigureColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  emptyLabel: string;
  ariaLabel: string;
  className?: string;
  sort?: FigureTableSort;
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
            {columns.map((column) => {
              const sortKey = sort === undefined ? undefined : column.sortKey;
              const sorted = sortKey !== undefined && sort?.key === sortKey;
              return (
                <th
                  key={column.header}
                  scope="col"
                  aria-sort={sorted ? 'descending' : undefined}
                  className={cn(
                    cellVariants({ align: column.align, fill: column.fill }),
                    'font-medium',
                  )}>
                  {sortKey === undefined ? (
                    column.header
                  ) : (
                    <button
                      type="button"
                      data-slot="figure-table-sort"
                      title={`Sort by ${column.header}`}
                      onClick={() => sort?.onSort(sortKey)}
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        sorted && 'text-foreground',
                      )}>
                      {column.header}
                      <ArrowDown
                        aria-hidden
                        className={cn('size-3', !sorted && 'invisible')}
                      />
                    </button>
                  )}
                </th>
              );
            })}
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
                  className={cellVariants({
                    align: column.align,
                    fill: column.fill,
                  })}>
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
