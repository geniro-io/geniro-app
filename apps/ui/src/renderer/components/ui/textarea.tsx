import * as React from 'react';

import { cn } from './utils';

/**
 * `ref` rides the PROPS, which React 19 supports directly — no `forwardRef`,
 * which nothing else in this directory uses either. It exists because
 * `ExpandableTextarea` measures the element to grow it with its text.
 */
function Textarea({
  className,
  ...props
}: React.ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // `border-border-strong` for the same reason as `Input` — a field's
        // edge is a control boundary, not a divider. See the note there.
        // `max-sm:text-[16px]` is iOS's no-zoom floor, in px because this
        // app's rem is 15px — see `input.spec.tsx`.
        'resize-none border-border-strong placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive flex min-h-16 w-full rounded-md border bg-input-background px-3 py-2 text-sm transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 max-sm:text-[16px]',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
