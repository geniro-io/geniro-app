import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { ChipChevron, chipVariants } from './chip';
import { Menu, type MenuGroup, type MenuItem } from './menu';
import { cn } from './utils';

export type { MenuGroup as SelectGroup, MenuItem as SelectOption };

const triggerVariants = cva(
  'inline-flex min-w-0 cursor-pointer items-center outline-none disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        /** The form field: bordered, filled, sized like Input. */
        default:
          'h-9 w-full justify-between gap-2 rounded-md border border-border bg-input-background px-3 text-sm transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
        /** The composer footer's flat picker chip — see `chip.tsx`. */
        ghost: '',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

/** The label the trigger shows for the current value. */
function labelOf(groups: MenuGroup[], value: string | null): string | null {
  for (const group of groups) {
    for (const item of group.items) {
      if (!item.action && item.value === value) {
        return item.label;
      }
    }
  }
  return null;
}

/**
 * The app's one dropdown control.
 *
 * It is deliberately NOT a native `<select>`. macOS draws that as an Aqua popup
 * button whose menu is an OS surface: it ignores every design token, cannot
 * show section headers, leading icons, a checkmark on the current value or a
 * search field, and is invisible to the DOM — so it can be neither
 * screenshotted nor asserted on in a test. Everything below the trigger is
 * therefore ours; see `menu.tsx`.
 *
 * `default` is the bordered form field, `ghost` the composer's flat chip. Both
 * open the same menu, so a picker behaves identically wherever it appears.
 */
export function Select({
  groups,
  value,
  onValueChange,
  variant,
  placeholder,
  triggerLabel,
  searchPlaceholder,
  leadingIcon,
  disabled = false,
  className,
  id,
  title,
  'aria-label': ariaLabel,
  side,
  align,
}: {
  groups: MenuGroup[];
  value: string | null;
  onValueChange: (value: string) => void;
  /** Shown when `value` matches no option (a legacy/unset value). */
  placeholder?: string;
  /**
   * Overrides what the TRIGGER shows, when a compact form of the value reads
   * better there than the menu row does — the folder picker lists full paths
   * (two checkouts of one repo share a leaf name) but the chip shows the leaf.
   */
  triggerLabel?: string;
  /** Provided = the menu gets a filter field. */
  searchPlaceholder?: string;
  /** Glyph on the TRIGGER itself (the folder chip's folder icon). */
  leadingIcon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  title?: string;
  'aria-label'?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
} & VariantProps<typeof triggerVariants>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const ghost = variant === 'ghost';
  const label = labelOf(groups, value);

  return (
    <span
      data-slot={ghost ? 'select-chip' : 'select'}
      className={cn('relative inline-flex', ghost ? 'w-auto' : 'w-full')}>
      <button
        type="button"
        id={id}
        data-menu-trigger
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        className={cn(
          ghost
            ? cn(
                chipVariants({ interactive: true }),
                'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              )
            : triggerVariants({ variant }),
          className,
        )}
        onClick={() => setOpen((current) => !current)}>
        {leadingIcon}
        <span className={cn('truncate', !ghost && 'flex-1 text-left')}>
          {triggerLabel ?? label ?? placeholder ?? ''}
        </span>
        <ChipChevron className={cn(!ghost && 'size-4')} />
      </button>
      <Menu
        open={open && !disabled}
        groups={groups}
        value={value ?? undefined}
        searchPlaceholder={searchPlaceholder}
        side={side}
        align={align}
        labelledBy={id}
        onSelect={onValueChange}
        onClose={() => setOpen(false)}
      />
    </span>
  );
}
