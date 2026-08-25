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
  ELEVATED, not outlined. Reported against the `+` menu as "this border on the
  menu looks very strange… not so crude": at full-strength `border-border`
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
 * The gap between a trigger and the panel it opens.
 *
 * It belongs to NEITHER, which is why `HoverPopover` delays its close: the
 * pointer crosses 6px that are not the trigger and not yet the panel.
 */
const GAP_PX = 6;

/** How close to the window edge a panel may come before it is pushed back. */
const EDGE_MARGIN_PX = 8;

/**
 * The floor under a flipped panel's `max-height`.
 *
 * A trigger pinned against an edge can leave a side with almost nothing, and
 * clamping to that produces a panel a few pixels tall — less readable than one
 * that overhangs slightly and scrolls. Reaching this means the window is too
 * short for the content either way.
 */
const MIN_PANEL_PX = 120;

/** The other side. */
function flip(side: 'top' | 'bottom'): 'top' | 'bottom' {
  return side === 'top' ? 'bottom' : 'top';
}

/**
 * Keep an offset inside the window: never under the margin, never so far that
 * the panel's far edge crosses the other one.
 *
 * `max` LAST, so a panel wider than the window keeps its near edge on screen
 * rather than being pushed off the opposite side to satisfy a bound it cannot
 * meet.
 */
function clamp(offset: number, ceiling: number): number {
  return Math.max(
    EDGE_MARGIN_PX,
    Math.min(offset, Math.max(EDGE_MARGIN_PX, ceiling)),
  );
}

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
  /**
   * The mounted panel, as STATE rather than only a ref, so measuring can
   * re-run once it exists.
   *
   * Placement is two passes and has to be: the panel is not rendered until the
   * trigger has been measured (see the hold below), so the first pass cannot
   * know how tall it is. The second pass, which this dependency schedules, is
   * the one that can flip it.
   */
  const [panelEl, setPanelEl] = React.useState<HTMLDivElement | null>(null);
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
      const panel = panelEl?.getBoundingClientRect();
      const height = panel?.height ?? 0;
      const width = panel?.width ?? 0;
      // What each side actually has, once the 6px gap and the edge margin are
      // taken out of it.
      const below = window.innerHeight - rect.bottom - GAP_PX - EDGE_MARGIN_PX;
      const above = rect.top - GAP_PX - EDGE_MARGIN_PX;
      // FLIP rather than let it run off the edge. REPORTED as "этот поповер
      // иногда заезжает за пределы окна видимого", against a group's options
      // opened on the last row of the sidebar: the panel is `fixed` precisely
      // so no ancestor can clip it, which also means no ancestor can stop it.
      // The requested side is kept whenever it fits, so a panel that has room
      // never moves; the other side is taken only when it has more.
      const wanted = side === 'top' ? above : below;
      const other = side === 'top' ? below : above;
      // An UNMEASURED panel (the first pass, before it mounts) keeps the
      // requested side. `height === 0` is not "fits in no space" — it is "we
      // do not know yet", and flipping on it would move every panel on the
      // frame before the one that could tell.
      const fits = height === 0 || height <= wanted;
      const placed = !fits && other > wanted ? flip(side) : side;
      const room = placed === 'top' ? above : below;
      // A panel too tall for EITHER side scrolls inside itself rather than
      // overflowing — the last resort, and the reason this is a max rather
      // than a height.
      const maxHeight = Math.max(MIN_PANEL_PX, room);
      // The same clamp across, and each alignment keeps its OWN edge pinned:
      // swapping `end` to a computed `left` would make the panel paint at the
      // trigger's right edge on the first pass (width is 0 until it mounts)
      // and jump left on the second — the very flicker the hold below exists
      // to prevent.
      const across =
        align === 'end'
          ? {
              right: clamp(
                window.innerWidth - rect.right,
                window.innerWidth - width - EDGE_MARGIN_PX,
              ),
            }
          : {
              left: clamp(
                rect.left,
                window.innerWidth - width - EDGE_MARGIN_PX,
              ),
            };
      setBox({
        position: 'fixed',
        ...(placed === 'top'
          ? { bottom: window.innerHeight - rect.top + GAP_PX }
          : { top: rect.bottom + GAP_PX }),
        ...across,
        maxHeight,
        overflowY: 'auto',
      });
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open, anchor, side, align, triggerRef, panelEl]);

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
      ref={(node) => {
        panelRef.current = node;
        setPanelEl(node);
      }}
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
