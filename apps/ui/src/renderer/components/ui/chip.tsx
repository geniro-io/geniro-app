import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from './utils';

/**
 * The flat control chip: muted text with a tight leading icon, no border and
 * no fill until hover — the composer footer's one visual language, in the
 * spirit of Cursor's own footer controls.
 *
 * It is the SINGLE source of that look: `Select`'s `ghost` variant is built
 * from these very classes, so a picker chip and a static chip cannot drift
 * apart. A static chip states a fixed choice; an interactive one opens a
 * picker and carries a trailing {@link ChipChevron} — the chevron is what
 * tells the two apart, so never put one on a static chip.
 */
const chipVariants = cva(
  "inline-flex h-8 w-fit min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-medium text-muted-foreground [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      interactive: {
        true: 'cursor-pointer outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        false: '',
      },
    },
    defaultVariants: { interactive: false },
  },
);

function Chip({
  className,
  interactive,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof chipVariants> & {
    asChild?: boolean;
  }): React.JSX.Element {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      data-slot="chip"
      className={cn(chipVariants({ interactive }), className)}
      {...props}
    />
  );
}

/**
 * The affordance marking a chip as a picker. Sized explicitly so the chip's
 * `[&>svg]` sizing rule leaves it alone, and click-through so it never eats a
 * press meant for the control underneath it.
 */
function ChipChevron({ className }: { className?: string }): React.JSX.Element {
  return (
    <ChevronDown
      aria-hidden
      className={cn('pointer-events-none size-3 opacity-60', className)}
    />
  );
}

export { Chip, ChipChevron, chipVariants };
