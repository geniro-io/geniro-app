import { cva } from 'class-variance-authority';
import { Check } from 'lucide-react';
import * as React from 'react';

import { cn } from './utils';

const checkIndicatorVariants = cva(
  'flex size-4 shrink-0 items-center justify-center border transition-colors',
  {
    variants: {
      shape: {
        square: 'rounded-[4px]',
        round: 'rounded-full',
      },
      checked: {
        true: 'border-primary bg-primary text-primary-foreground',
        // NOT `border-input`: that token is tuned for a field's own edge against
        // page cream, where it is meant to recede. At 16px it disappeared, and an
        // invisible checkbox is exactly the state this control exists to make visible.
        false: 'border-muted-foreground/50',
      },
    },
    defaultVariants: { shape: 'square', checked: false },
  },
);

/**
 * The box (`square`, "as many as apply") or dot (`round`, "one of these") that
 * marks a pickable option and its pick. The shape is what tells a reader, before
 * they click, whether a second pick adds to the first or replaces it.
 */
function CheckIndicator({
  checked,
  shape,
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  checked: boolean;
  shape: 'square' | 'round';
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="check-indicator"
      className={cn(checkIndicatorVariants({ shape, checked }), className)}
      {...props}>
      {checked ? (
        shape === 'square' ? (
          <Check className="size-3" strokeWidth={3} />
        ) : (
          <span className="size-1.5 rounded-full bg-primary-foreground" />
        )
      ) : null}
    </span>
  );
}

/**
 * A square checkbox with its label beside it, as a native `<button role="checkbox">`.
 *
 * Space and Enter toggle it through the button's own activation, which every
 * browser fires as a click; a handler of its own would toggle twice on the same key.
 */
function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
  id?: string;
  /** For a short label that only makes sense beside what it ticks. */
  'aria-label'?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-slot="checkbox"
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => onCheckedChange(!checked)}
      className="inline-flex max-w-full cursor-pointer items-start gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50">
      <CheckIndicator checked={checked} shape="square" className="mt-0.5" />
      <span className="min-w-0 break-words">{label}</span>
    </button>
  );
}

export { Checkbox, CheckIndicator };
