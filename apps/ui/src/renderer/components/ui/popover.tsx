import * as React from 'react';

import { cn } from './utils';

/**
 * The floating surface every anchored panel is drawn on — the dropdown `Menu`
 * and the {@link Popover} below. One source, so elevation, radius and border
 * cannot drift between two things the user reads as the same object.
 *
 * Deliberately WITHOUT `overflow-hidden`: a menu opened from a control inside a
 * popover has to escape it. `Menu` adds the clip itself, because its rows run
 * to the panel edge and need the radius to cut them.
 */
export const popoverSurface =
  'absolute z-50 rounded-xl border border-border bg-popover shadow-panel-md';

/**
 * An anchored panel holding ARBITRARY content, for the cases `Menu` cannot
 * serve — it renders a list of values, and the composer's overflow needs the
 * real controls (each with its own menu) rather than rows describing them.
 *
 * Positioned against the nearest positioned ancestor, like `Menu`, so the
 * caller decides what it hangs off. Closes on Escape and on a pointer press
 * outside itself; a press on the trigger is left alone, since the trigger owns
 * its own toggle and swallowing it here would make a second press reopen what
 * the toggle had just closed.
 */
export function Popover({
  open,
  onClose,
  triggerRef,
  side = 'top',
  align = 'start',
  label,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * The control that toggles this panel. Passed as a ref rather than found by
   * selector: the panel's ancestor holds several `[data-menu-trigger]`s (every
   * chip is one), and closing on a press meant for the toggle would fight it —
   * the press would close the panel and the click would reopen it.
   */
  triggerRef?: React.RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  /** Accessible name for the panel. */
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const panel = panelRef.current;
      const target = event.target as Node | null;
      if (!panel || !target || panel.contains(target)) {
        return;
      }
      if (!triggerRef?.current?.contains(target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, triggerRef]);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      className={cn(
        popoverSurface,
        side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        align === 'start' ? 'left-0' : 'right-0',
        className,
      )}>
      {children}
    </div>
  );
}
