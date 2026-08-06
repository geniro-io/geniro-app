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
 *
 * `tone` says whether the value is the USER'S to change, and it is the one
 * thing a reader scanning the composer footer needs: the folder and branch a
 * run was started in are facts about it and can never be edited from there,
 * while the model, effort and approval mode are live controls. The two used to
 * render identically, so the row read as five equal pickers of which two
 * silently did nothing.
 *
 * It is a separate axis from `interactive` on purpose. `interactive` is about
 * BEHAVIOUR (does this open a menu, does it take focus); `tone` is about
 * AUTHORITY (is this value yours). A disabled picker is interactive-but-locked
 * and still `active` — greying it would say "not yours to change" about a
 * control that is yours as soon as the turn ends.
 */
const chipVariants = cva(
  "inline-flex h-8 w-fit min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-medium [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      interactive: {
        true: 'cursor-pointer outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        false: '',
      },
      tone: {
        /** The user's to change: full-contrast label. */
        active: 'text-foreground',
        /** Stated for context, not editable here: recedes. */
        muted: 'text-muted-foreground',
      },
    },
    defaultVariants: { interactive: false, tone: 'muted' },
  },
);

function Chip({
  className,
  interactive,
  tone,
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
      data-tone={tone ?? 'muted'}
      className={cn(chipVariants({ interactive, tone }), className)}
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
