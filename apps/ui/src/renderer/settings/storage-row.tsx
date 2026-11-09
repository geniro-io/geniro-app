import { ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';

import { CARD_HOVER_CLASS } from '../components/card-hover';
import { cn } from '../components/ui/utils';

/**
 * One line of the Storage page: its dot, name, actions and figure at rest, what
 * it is and holds behind a press anywhere on the line. The figures of a panel
 * share one right-aligned column, and the unfolded entries line up under it.
 *
 * The fold button's `::after` stretches over the line; the actions are the one
 * positioned thing above it. No `z-index` there, because a stacking context
 * would put a picker's open menu under the actions of the rows below.
 */
export function StorageRow({
  name,
  figure,
  dot,
  quiet = false,
  details,
  children,
}: {
  name: string;
  figure: string;
  /** The row's bar colour (`bg-*` token), or null for a row the bar has no part for. */
  dot: string | null;
  /** Holds nothing: the row reads as a muted line. */
  quiet?: boolean;
  details: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div data-slot="storage-row" className="group/row">
      <div
        className={cn(
          'relative grid min-h-11 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 px-4 py-1.5 @[36rem]:grid-cols-[minmax(0,1fr)_auto_minmax(4.5rem,auto)_auto]',
          CARD_HOVER_CLASS,
          'group-first/row:rounded-t-lg group-last/row:rounded-b-lg has-[[data-slot=storage-row-actions]:hover]:bg-transparent',
          quiet && 'text-muted-foreground',
        )}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          aria-label={`${name}, ${figure}`}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left text-sm outline-none select-none after:absolute after:inset-0 group-first/row:after:rounded-t-lg group-last/row:after:rounded-b-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
          <span
            aria-hidden="true"
            className={cn('size-2 shrink-0 rounded-full', dot)}
          />
          {name}
        </button>
        {children === undefined || children === null ? null : (
          <div
            data-slot="storage-row-actions"
            className="relative order-last col-span-full flex min-w-0 flex-wrap items-center gap-1 pl-1.5 @[36rem]:order-none @[36rem]:col-auto @[36rem]:justify-end @[36rem]:pl-0">
            {children}
          </div>
        )}
        <span className="text-right text-sm tabular-nums @[36rem]:col-start-3">
          {figure}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform @[36rem]:col-start-4',
            open && 'rotate-90',
          )}
        />
      </div>
      {open ? (
        <div
          id={detailsId}
          className="flex flex-col gap-1.5 pt-0.5 pr-[2.625rem] pb-3 pl-[2.125rem] text-xs text-muted-foreground">
          {details}
        </div>
      ) : null}
    </div>
  );
}
