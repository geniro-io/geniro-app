import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from './utils';

const tableRowVariants = cva('', {
  variants: {
    interactive: {
      true: 'cursor-pointer hover:bg-muted/40 focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-ring/50 focus-within:ring-inset',
      false: '',
    },
  },
  defaultVariants: {
    interactive: false,
  },
});

const tableHeadVariants = cva(
  // The shadow draws the bottom rule: a border on a sticky cell stays behind
  // when the header sticks under `border-collapse`.
  'sticky top-0 z-10 h-8 bg-card bg-linear-to-b from-muted/30 to-muted/30 px-3 text-[10px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase shadow-[inset_0_-1px_0_var(--border)]',
  {
    variants: {
      align: {
        left: 'text-left',
        right: 'text-right',
      },
    },
    defaultVariants: {
      align: 'left',
    },
  },
);

const tableCellVariants = cva('px-3 py-2 align-top', {
  variants: {
    align: {
      left: '',
      right: 'text-right tabular-nums',
    },
  },
  defaultVariants: {
    align: 'left',
  },
});

function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<'table'> & {
  containerClassName?: string;
}): React.JSX.Element {
  return (
    <div
      data-slot="table-container"
      className={cn(
        'relative w-full overflow-auto rounded-xl border border-border bg-card',
        containerClassName,
      )}>
      <table
        data-slot="table"
        className={cn(
          'w-full caption-bottom border-collapse text-xs',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({
  className,
  ...props
}: React.ComponentProps<'thead'>): React.JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn('bg-muted/30', className)}
      {...props}
    />
  );
}

function TableBody({
  className,
  ...props
}: React.ComponentProps<'tbody'>): React.JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        '[&_tr:not(:first-child)]:border-t [&_tr:not(:first-child)]:border-border/60',
        className,
      )}
      {...props}
    />
  );
}

function TableFooter({
  className,
  ...props
}: React.ComponentProps<'tfoot'>): React.JSX.Element {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        'border-t border-border bg-muted/30 font-medium',
        className,
      )}
      {...props}
    />
  );
}

function TableRow({
  className,
  interactive,
  ...props
}: React.ComponentProps<'tr'> &
  VariantProps<typeof tableRowVariants>): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn(tableRowVariants({ interactive }), className)}
      {...props}
    />
  );
}

function TableHead({
  className,
  align,
  scope = 'col',
  ...props
}: React.ComponentProps<'th'> &
  VariantProps<typeof tableHeadVariants>): React.JSX.Element {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(tableHeadVariants({ align }), className)}
      {...props}
    />
  );
}

function TableCell({
  className,
  align,
  ...props
}: React.ComponentProps<'td'> &
  VariantProps<typeof tableCellVariants>): React.JSX.Element {
  return (
    <td
      data-slot="table-cell"
      className={cn(tableCellVariants({ align }), className)}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<'caption'>): React.JSX.Element {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-2 text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  tableRowVariants,
};
