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
/*
  ELEVATED, not outlined. Reported against the `+` menu as "вот этот бордер у
  меню выглядит очень странно… не так топорно": at full-strength `border-border`
  over the barely-there `shadow-panel-md`, the border was the strongest line on
  screen and the panel read as a wireframe rectangle drawn on the page rather
  than a surface hanging above it. The fix is to swap which one does the work —
  a hairline at 60% and a real two-layer float (`shadow-panel-lg`). The border
  stays because the palette is warm near-white on warm near-white and a shadow
  alone leaves the top edge, which no shadow reaches, undefined.
*/
export const popoverSurface =
  'absolute z-50 rounded-xl border border-border/60 bg-popover shadow-panel-lg';

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
  anchor = 'ancestor',
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
   *
   * REQUIRED for `anchor="viewport"`, which has nothing else to measure from.
   */
  triggerRef?: React.RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  /**
   * What the panel is positioned against.
   *
   * `ancestor` (the default) is absolute placement inside the nearest positioned
   * ancestor — right for a panel whose trigger sits in open layout.
   *
   * `viewport` measures the trigger and places the panel `fixed`, which is the
   * ONLY way out of a clipping ancestor: a trigger inside a scroll container
   * (`overflow: auto`) has its panel cut at that container's edge, and
   * `overflow-x: visible` cannot be restored on a box that scrolls vertically —
   * CSS forces both axes to be non-visible together. Measured in the agents
   * panel: a 390px panel hanging off a button at x=1354 was clipped at the
   * thread list's left edge (x=1121), so the first 233px — the whole first half
   * of the sentence, and of the copyable `--resume` command line — rendered
   * off-surface. `Dialog` escapes the same way, for the same reason.
   */
  anchor?: 'ancestor' | 'viewport';
  /** Accessible name for the panel. */
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [box, setBox] = React.useState<React.CSSProperties | null>(null);

  // Measured on open, and re-measured while open on scroll or resize — a fixed
  // panel does not travel with its trigger, so without this it would sit where
  // the trigger USED to be. `capture` because the scroll happens on an inner
  // container and scroll events do not bubble.
  React.useEffect(() => {
    if (!open || anchor !== 'viewport') {
      setBox(null);
      return;
    }
    const measure = (): void => {
      const trigger = triggerRef?.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setBox({
        position: 'fixed',
        ...(side === 'top'
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
        ...(align === 'end'
          ? { right: window.innerWidth - rect.right }
          : { left: rect.left }),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open, anchor, side, align, triggerRef]);

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
  // Held back until the trigger has been measured, so the panel never paints
  // for one frame at the ancestor-relative position before jumping.
  if (anchor === 'viewport' && box === null) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      style={box ?? undefined}
      className={cn(
        popoverSurface,
        // The placement utilities belong to the ancestor mode only: they are
        // `absolute` offsets, and the fixed mode carries its own inline box.
        box === null &&
          (side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'),
        box === null && (align === 'start' ? 'left-0' : 'right-0'),
        className,
      )}>
      {children}
    </div>
  );
}
