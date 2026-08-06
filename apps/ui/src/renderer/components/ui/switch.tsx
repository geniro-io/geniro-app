import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from './utils';

/**
 * The track. Off uses `--switch-background`, on uses `--primary`.
 *
 * The SIZE is a variant rather than something a caller shrinks with utility
 * classes, and that is the whole point of this file's shape: the thumb's travel
 * is a hardcoded distance, so a track resized from outside leaves the thumb
 * travelling the old distance inside the new box. That shipped — the MCP panel
 * passed `h-4 w-7` while the thumb kept `size-4` and `translate-x-4`, so an ON
 * switch put a 16px thumb at x=16 in a 28px track and it hung 4px past the
 * edge, its own drop shadow reading as an unexplained smudge. A number that has
 * to agree with another number cannot live on the other side of a prop.
 */
const switchVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-5 w-9',
        /** For dense rows — a list of servers, not a settings form. */
        sm: 'h-4 w-7',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

/**
 * The thumb, whose travel is stated ONCE per size beside the track it belongs
 * to. Each ON distance is `trackWidth - 2*border - thumb - inset`, so the thumb
 * lands the same 2px from the right edge that it starts from on the left:
 * default 36-2-16-2 = 16 (`translate-x-4`), sm 28-2-12-2 = 12 (`translate-x-3`).
 */
const switchThumbVariants = cva(
  'pointer-events-none block rounded-full bg-card shadow-panel-sm transition-transform',
  {
    variants: {
      size: { default: 'size-4', sm: 'size-3' },
      checked: { true: '', false: 'translate-x-0.5' },
    },
    compoundVariants: [
      { size: 'default', checked: true, class: 'translate-x-4' },
      { size: 'sm', checked: true, class: 'translate-x-3' },
    ],
    defaultVariants: { size: 'default', checked: false },
  },
);

/**
 * A token-driven on/off toggle (shadcn "switch" flavour) built on a native
 * `<button role="switch">` — no Radix dependency.
 *
 * Pick a `size`; do not resize it through `className`, which moves the track
 * without telling the thumb.
 */
function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  size,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onChange' | 'type' | 'size'> &
  VariantProps<typeof switchVariants> & {
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
        switchVariants({ size }),
        checked ? 'bg-primary' : 'bg-switch-background',
        className,
      )}
      {...props}>
      <span className={cn(switchThumbVariants({ size, checked }))} />
    </button>
  );
}

export { Switch };
