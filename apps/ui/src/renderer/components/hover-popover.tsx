import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover } from './ui/popover';
import { cn } from './ui/utils';

/**
 * How long a pointer must REST on the trigger before the panel opens.
 *
 * Opening is not always free — the context meter's readout is a control write
 * onto the live agent's stdin, measured at 1.2–3.3s — so a pointer that merely
 * crossed the trigger on its way somewhere else must not put that question to
 * anybody: five sweeps across the composer queued five of them, and the CLI
 * serialises them.
 *
 * Only the HOVER path waits. A press and a keyboard focus are both deliberate,
 * and open at once.
 */
const HOVER_OPEN_DELAY_MS = 250;

/**
 * How long an open panel survives the pointer leaving it.
 *
 * The panel is anchored 6px clear of the trigger (`Popover`'s viewport box), so
 * the path from the trigger to the thing it opened crosses 6px that belong to
 * neither. Closing on that crossing is what made the context breakdown
 * unreachable: a scrolling panel that unmounts before the pointer arrives can
 * only ever be read by pinning it, and nothing on screen says a click pins.
 *
 * Short enough that a pointer merely passing THROUGH does not leave a panel
 * hanging behind it, long enough to cross the gap at any hand speed.
 */
const HOVER_CLOSE_GRACE_MS = 120;

/**
 * A small control that reveals a panel on hover, and PINS it on a press.
 *
 * The app's one implementation of that behaviour. It began as the context
 * meter's own — the pin/hover pair took two attempts to get right — and became
 * shared the moment a second readout wanted it (the chat header's sub-agent and
 * task counts, which say a number and hold the list behind it). A second copy
 * would be a second chance to get the same four timers wrong.
 *
 * What it owns: the open state, the two timers, and the rule that every path
 * out of "open" cancels both. What the CALLER owns: what the trigger looks
 * like, what the panel says, and where it opens — none of which this can know.
 */
export function HoverPopover({
  trigger,
  label,
  panelLabel,
  side = 'bottom',
  align = 'end',
  slot,
  className,
  triggerClassName,
  panelClassName,
  onOpenChange,
  children,
}: {
  /** What the trigger button draws — a ring, a glyph and a count, … */
  trigger: React.ReactNode;
  /**
   * The trigger's accessible name. It carries the whole reading where there is
   * one, so a screen-reader user gets it without opening anything.
   */
  label: string;
  /** Names the panel itself, for the same reason. */
  panelLabel: string;
  /**
   * Which way the panel opens. `Popover` does no collision detection — its
   * placement is two static ternaries — so a caller near an edge has to say.
   */
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  /** `data-slot` for the wrapper, so a test can find this one by name. */
  slot?: string;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  /**
   * Told when the panel opens and closes — for a caller whose CONTENT depends
   * on it. The context meter fetches its breakdown on open and never polls,
   * which is only expressible if the open state reaches it.
   *
   * Must be stable (a `useCallback`, or a setter): it is a dependency of the
   * effect that reports the change.
   */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = pinned || hovered;
  // Every path OUT of the open state cancels the pending hover, including the
  // two that close an already-open panel: a timer left running fires after the
  // close and reopens the panel the user just dismissed.
  const cancelHoverOpen = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  const cancelHoverClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      cancelHoverOpen();
      cancelHoverClose();
    },
    [cancelHoverOpen, cancelHoverClose],
  );
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  const close = useCallback(() => {
    cancelHoverOpen();
    cancelHoverClose();
    setPinned(false);
    setHovered(false);
  }, [cancelHoverOpen, cancelHoverClose]);
  return (
    <span
      data-slot={slot}
      data-open={open ? 'true' : undefined}
      className={cn('relative flex items-center', className)}
      // The pointer handlers belong to the WRAPPER, not to the trigger inside
      // it: the panel is a DOM child of this span (`Popover` renders in place
      // and positions itself `fixed`), so moving from the trigger onto the
      // panel stays inside this element's subtree, and only the 6px anchor gap
      // between them registers as a leave — which the close grace covers. Hung
      // off the button instead, every reading ended the moment the pointer left
      // a target smaller than the cursor.
      onMouseEnter={() => {
        cancelHoverClose();
        // Already open on the hover term — re-arming would queue a second
        // timer per crossing between the trigger and the panel.
        if (hovered) {
          return;
        }
        cancelHoverOpen();
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          setHovered(true);
        }, HOVER_OPEN_DELAY_MS);
      }}
      onMouseLeave={() => {
        cancelHoverOpen();
        cancelHoverClose();
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null;
          setHovered(false);
        }, HOVER_CLOSE_GRACE_MS);
      }}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={label}
        className={cn(
          'flex cursor-pointer items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          triggerClassName,
        )}
        onBlur={() => {
          cancelHoverOpen();
          cancelHoverClose();
          setHovered(false);
        }}
        // A press on an UNPINNED panel pins it; a press on a pinned one closes
        // it, clearing the hover term too.
        //
        // Both halves matter. A press that beats `HOVER_OPEN_DELAY_MS` arrives
        // with `hovered` still false, and one that follows a resting pointer
        // arrives with it true — so a toggle of `pinned` alone would close what
        // the user was reaching for in the second case. And on the way back
        // out, unpinning without clearing `hovered` leaves `pinned || hovered`
        // true, so the press the user reads as "close this" does nothing until
        // the pointer wanders off. A jsdom `.click()` neither hovers nor
        // focuses, which is why the first spec written here missed both.
        onClick={() => {
          cancelHoverOpen();
          cancelHoverClose();
          if (pinned) {
            setPinned(false);
            setHovered(false);
            return;
          }
          setPinned(true);
        }}
        // Focus is the keyboard's press, not its hover: it is already
        // deliberate, so it opens without the delay a pointer has to earn.
        onFocus={() => setHovered(true)}>
        {trigger}
      </button>
      <Popover
        open={open}
        onClose={close}
        triggerRef={triggerRef}
        side={side}
        align={align}
        // Callers sit inside clipping ancestors — a scrolling thread list, the
        // composer inside the shell's `overflow-hidden` main — so an
        // ancestor-positioned panel is CUT. It was: the meter's readout is the
        // only place a sighted user gets the figures at all, and it rendered
        // with its first two thirds off-surface.
        anchor="viewport"
        label={panelLabel}
        className={cn('px-2.5 py-2', panelClassName)}>
        {children}
      </Popover>
    </span>
  );
}
