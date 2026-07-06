import * as React from 'react';

import { cn } from './utils';

/**
 * A token-driven on/off toggle (shadcn "switch" flavour) built on a native
 * `<button role="switch">` — no Radix dependency. Off track uses
 * `--switch-background`, on track uses `--primary`; the thumb is `--card`.
 */
function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onChange' | 'type'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-switch-background',
        className,
      )}
      {...props}>
      <span
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-card shadow-panel-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export { Switch };
