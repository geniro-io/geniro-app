import { Pencil } from 'lucide-react';
import { useRef, useState } from 'react';

import { PROFILE_COLORS, type ProfileColor } from '../../shared/contracts';
import { Menu } from './ui/menu';
import { PaletteDot } from './ui/palette-dot';
import { paletteMenuItems } from './ui/palette-menu';
import { cn } from './ui/utils';

const RENAME_ROW = 'rename';
const NO_COLOR_ROW = 'no-color';

function isProfileColor(value: string): value is ProfileColor {
  return (PROFILE_COLORS as readonly string[]).includes(value);
}

/**
 * A tab's colour dot that opens its colour menu and Rename row — a terminal
 * tab's and a browser tab's. With no colour set it shows `emptyIcon`.
 */
export function ColorRenameMenu({
  color,
  onRecolor,
  onRename,
  ariaLabel,
  emptyIcon,
  side,
  className,
  triggerSlot,
  dotSlot,
  focusable = true,
}: {
  color: ProfileColor | null;
  onRecolor: (color: ProfileColor | null) => void;
  onRename: () => void;
  ariaLabel: string;
  emptyIcon: React.ReactNode;
  side: 'top' | 'bottom';
  className?: string;
  triggerSlot?: string;
  dotSlot?: string;
  /** False keeps the trigger out of the tab order, as beside a tab strip's own keyboard roving. */
  focusable?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        tabIndex={focusable ? undefined : -1}
        data-menu-trigger
        data-slot={triggerSlot}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title="Colour and name"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={cn(
          'flex size-5 items-center justify-center rounded-sm text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          className,
        )}>
        {color === null ? (
          emptyIcon
        ) : (
          <PaletteDot data-slot={dotSlot} color={color} size="sm" />
        )}
      </button>
      <Menu
        open={open}
        side={side}
        align="start"
        anchor="viewport"
        triggerRef={triggerRef}
        className="w-44 min-w-0"
        groups={[
          {
            label: 'Colour',
            items: paletteMenuItems({
              colors: PROFILE_COLORS,
              current: color,
              valueOf: (value) => value,
              noneValue: NO_COLOR_ROW,
            }),
          },
          {
            items: [
              {
                value: RENAME_ROW,
                label: 'Rename tab…',
                icon: <Pencil className="size-3.5" />,
                action: true,
              },
            ],
          },
        ]}
        onSelect={(value) => {
          setOpen(false);
          if (value === RENAME_ROW) {
            onRename();
          } else if (value === NO_COLOR_ROW) {
            onRecolor(null);
          } else if (isProfileColor(value)) {
            onRecolor(value);
          }
        }}
        onClose={() => setOpen(false)}
      />
    </span>
  );
}
