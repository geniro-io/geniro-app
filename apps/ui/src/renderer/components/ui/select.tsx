import * as React from 'react';

import { cn } from './utils';

/**
 * A styled native `<select>`. The renderer keeps native selects (rather than the
 * Radix listbox) for the few simple pickers in M2; it shares the token-driven
 * control chrome with Input so every form control looks the same.
 */
function Select({
  className,
  ...props
}: React.ComponentProps<'select'>): React.JSX.Element {
  return (
    <select
      data-slot="select"
      className={cn(
        'border-border flex h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base bg-input-background transition-[color,box-shadow] outline-none cursor-pointer',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Select };
