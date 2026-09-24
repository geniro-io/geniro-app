import { useEffect, useRef } from 'react';

/** Which way the finger travelled — `right` is a swipe from left to right. */
export type SwipeDirection = 'left' | 'right';

/**
 * Answers one swipe. Returns `true` when it ACTED on it, which ends the
 * gesture there; `false` passes it on to the next handler down.
 */
export type SwipeHandler = (direction: SwipeDirection) => boolean;

/**
 * How far the finger must travel sideways before a touch counts as a swipe.
 * Short enough for a thumb flick, long enough that a tap with a little drift
 * in it never opens a drawer.
 */
export const SWIPE_MIN_DISTANCE_PX = 60;

/**
 * How much more sideways than vertical the travel must be. A reader scrolling
 * a transcript drifts sideways too; at 2:1 the gesture is unmistakably
 * horizontal, so a scroll is never read as a request for a drawer.
 */
const SWIPE_AXIS_RATIO = 2;

/** A touch held longer than this is a drag or a selection, not a swipe. */
const SWIPE_MAX_DURATION_MS = 800;

/**
 * The strip at each screen edge where a touch is left to the BROWSER.
 *
 * iOS Safari (and Chrome on iOS) take an edge swipe for history back/forward,
 * and nothing a page does can stop it. Answering the same gesture as well
 * would do two things at once — open the drawer AND step the hash route back
 * a view — so a swipe that starts in the strip is the browser's alone.
 */
const SWIPE_EDGE_GUARD_PX = 20;

/**
 * Where a touch belongs to what it started on rather than to the shell: text
 * being edited (a drag there moves the caret or the selection), anything with
 * its own pan or drag (the workflow canvas, the image viewer's zoom), a modal
 * (a drawer opening behind a dialog is invisible and still steals the next
 * tap), and an explicit opt-out.
 */
const IGNORED_TARGET_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="dialog"]',
  '.react-flow',
  '[data-swipe-ignore]',
].join(',');

interface Registration {
  priority: number;
  handler: { current: SwipeHandler };
}

/**
 * Every live handler, highest priority first. Module state rather than a
 * context because the two parties that answer a swipe — the shell's nav
 * drawer (`App.tsx`) and the chat screen's two drawers (`Chats.tsx`) — are a
 * parent and a child with no shared provider between them, and one swipe must
 * reach them in ONE order: two independent listeners would both act on it,
 * opening a drawer and closing another in the same gesture.
 */
const registrations: Registration[] = [];

interface TouchStart {
  x: number;
  y: number;
  at: number;
  target: Element | null;
}

let start: TouchStart | null = null;

function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/**
 * Whether something between the touched element and the page can still
 * scroll the way the finger pushed it — a wide code block, a table, the
 * shelf's chip row. There the swipe is that element's scroll, and taking it
 * for a drawer would make every wide block impossible to read on a phone.
 *
 * A finger moving RIGHT scrolls content toward its START, so it is the
 * remaining `scrollLeft` that matters; moving left, the room past the end.
 */
function scrollsHorizontally(
  target: Element | null,
  direction: SwipeDirection,
): boolean {
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth) {
      continue;
    }
    const overflowX = window.getComputedStyle(el).overflowX;
    if (overflowX !== 'auto' && overflowX !== 'scroll') {
      continue;
    }
    const room =
      direction === 'right'
        ? el.scrollLeft
        : el.scrollWidth - el.clientWidth - el.scrollLeft;
    if (room > 1) {
      return true;
    }
  }
  return false;
}

/**
 * Reads a finished touch as a swipe, or as nothing. Exported for the spec;
 * the listeners below are its only runtime caller.
 */
export function readSwipe(
  from: TouchStart,
  to: { x: number; y: number; at: number },
  viewportWidth: number,
): SwipeDirection | null {
  if (
    from.x < SWIPE_EDGE_GUARD_PX ||
    from.x > viewportWidth - SWIPE_EDGE_GUARD_PX
  ) {
    return null;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (
    Math.abs(dx) < SWIPE_MIN_DISTANCE_PX ||
    Math.abs(dx) < SWIPE_AXIS_RATIO * Math.abs(dy) ||
    to.at - from.at > SWIPE_MAX_DURATION_MS
  ) {
    return null;
  }
  return dx > 0 ? 'right' : 'left';
}

function onTouchStart(event: TouchEvent): void {
  // A second finger is a pinch, never a swipe — and it voids the one already
  // down, which is about to become half of that pinch.
  if (event.touches.length !== 1) {
    start = null;
    return;
  }
  const target = elementOf(event.target);
  if (target?.closest(IGNORED_TARGET_SELECTOR)) {
    start = null;
    return;
  }
  const touch = event.touches[0];
  start = touch
    ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp, target }
    : null;
}

function onTouchEnd(event: TouchEvent): void {
  const from = start;
  start = null;
  const touch = event.changedTouches[0];
  if (!from || !touch) {
    return;
  }
  const direction = readSwipe(
    from,
    { x: touch.clientX, y: touch.clientY, at: event.timeStamp },
    window.innerWidth,
  );
  if (direction === null || scrollsHorizontally(from.target, direction)) {
    return;
  }
  // A copy: a handler that acts re-renders, and its effect may unregister
  // and re-register mid-loop.
  for (const registration of [...registrations]) {
    if (registration.handler.current(direction)) {
      return;
    }
  }
}

function onTouchCancel(): void {
  start = null;
}

function install(): void {
  // Passive: the gesture is read when the finger LIFTS and never cancels the
  // browser's own scroll, so the page keeps scrolling at full speed under it.
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true });
}

function uninstall(): void {
  document.removeEventListener('touchstart', onTouchStart);
  document.removeEventListener('touchend', onTouchEnd);
  document.removeEventListener('touchcancel', onTouchCancel);
  start = null;
}

/**
 * Answer a horizontal swipe anywhere on the page — the phone's way to open
 * and close the shell's drawers, which the LAN gateway serves to a browser on
 * a phone (see `use-narrow-viewport.ts`; the Electron window itself has no
 * touch input to speak of).
 *
 * `priority` orders the handlers when more than one is registered: higher
 * runs first, and the first to return `true` takes the swipe. `enabled`
 * unregisters without unmounting, so a caller gates it on the phone layout
 * rather than on a conditional hook call.
 *
 * The handler is read through a ref, so it may close over fresh state on
 * every render without re-registering.
 */
export function useSwipeGesture(
  handler: SwipeHandler,
  {
    enabled = true,
    priority = 0,
  }: { enabled?: boolean; priority?: number } = {},
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const registration: Registration = { priority, handler: handlerRef };
    registrations.push(registration);
    registrations.sort((a, b) => b.priority - a.priority);
    if (registrations.length === 1) {
      install();
    }
    return () => {
      const index = registrations.indexOf(registration);
      if (index !== -1) {
        registrations.splice(index, 1);
      }
      if (registrations.length === 0) {
        uninstall();
      }
    };
  }, [enabled, priority]);
}
