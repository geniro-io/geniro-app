import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from './utils';

/**
 * How long a pointer must rest on an element before its tooltip shows —
 * far quicker than the system's (seconds, reported as "появляется только через
 * 3 секунды"), slow enough that sweeping across a toolbar draws nothing.
 */
export const TOOLTIP_OPEN_DELAY_MS = 300;

/**
 * After a tooltip closes, the next one within this window opens at once: a
 * reader moving along a row of icons reads each in turn without waiting
 * again, as a native tooltip does.
 */
const TOOLTIP_WARM_MS = 500;

/** Clear of the element by enough to hold the arrow. */
const GAP_PX = 8;
const EDGE_MARGIN_PX = 8;
/** How close the arrow may come to the tooltip's rounded corner. */
const ARROW_INSET_PX = 12;

/** Where an element's `title` is parked while its tooltip owns the text. */
const PARKED_ATTR = 'data-tooltip-title';

/**
 * Where a tooltip goes: centred under its element, above it when there is no
 * room below, and kept `EDGE_MARGIN_PX` inside the window either way. `arrow`
 * is how far across the tooltip its arrow sits — still under the element's
 * centre when the clamp has pushed the tooltip aside.
 */
export function placeTooltip(
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; side: 'top' | 'bottom'; arrow: number } {
  const below = viewport.height - anchor.bottom - GAP_PX - EDGE_MARGIN_PX;
  const above = anchor.top - GAP_PX - EDGE_MARGIN_PX;
  const side = tip.height <= below || below >= above ? 'bottom' : 'top';
  const top =
    side === 'bottom'
      ? anchor.bottom + GAP_PX
      : anchor.top - GAP_PX - tip.height;
  const centre = anchor.left + anchor.width / 2;
  const left = Math.min(
    Math.max(centre - tip.width / 2, EDGE_MARGIN_PX),
    Math.max(EDGE_MARGIN_PX, viewport.width - tip.width - EDGE_MARGIN_PX),
  );
  const arrow = Math.min(
    Math.max(centre - left, ARROW_INSET_PX),
    Math.max(ARROW_INSET_PX, tip.width - ARROW_INSET_PX),
  );
  return { left, top, side, arrow };
}

/** The element whose `title` a pointer over `node` would show, if any. */
function titledElement(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) {
    return null;
  }
  // `iframe[title]` names the frame for assistive tech; the pointer is inside
  // another document there, and no tooltip belongs to it.
  return node.closest(`[title]:not([title=""]):not(iframe), [${PARKED_ATTR}]`);
}

/** Move `title` aside so the system draws no tooltip; returns the text. */
function park(element: Element): string {
  const title = element.getAttribute('title');
  if (title !== null) {
    element.setAttribute(PARKED_ATTR, title);
    element.removeAttribute('title');
  }
  return element.getAttribute(PARKED_ATTR) ?? '';
}

/** Put `title` back, unless something wrote a newer one meanwhile. */
function unpark(element: Element): void {
  const parked = element.getAttribute(PARKED_ATTR);
  element.removeAttribute(PARKED_ATTR);
  if (parked !== null && !element.hasAttribute('title')) {
    element.setAttribute('title', parked);
  }
}

/**
 * The app's tooltips: every `title` in the renderer, drawn in the design
 * system instead of by the OS — "implement normal popovers instead of system
 * ones".
 *
 * One layer rather than a component per call site, so the ~360 `title`s the
 * app already has, and every one added later, get it without each learning a
 * new API. `title` stays the source of truth and stays in the DOM: it is the
 * accessible description, and specs read it. Only while a mouse rests on an
 * element is it moved aside (`PARKED_ATTR`) — the one way to stop Chromium
 * drawing its own tooltip — and it is put back the moment the pointer leaves.
 * A `title` React writes while it is parked is taken over at once, so the
 * tooltip follows the element's current text.
 *
 * A touch never shows one, matching what a phone does with a `title` today.
 * Mounted once, at the root (`boot-app.tsx`).
 */
export function TooltipLayer(): React.JSX.Element | null {
  const [tip, setTip] = React.useState<{
    text: string;
    anchor: Element;
  } | null>(null);
  const [position, setPosition] = React.useState<ReturnType<
    typeof placeTooltip
  > | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);
  const tipId = React.useId();

  React.useEffect(() => {
    let active: Element | null = null;
    // Set by a press: the tooltip stays away until the pointer leaves, as the
    // system's does.
    let pressed = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let closedAt = Number.NEGATIVE_INFINITY;
    let shown = false;

    const cancelOpen = (): void => {
      if (openTimer !== null) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    };
    const hide = (): void => {
      cancelOpen();
      if (shown) {
        closedAt = Date.now();
        shown = false;
      }
      setTip(null);
    };
    const show = (element: Element): void => {
      openTimer = null;
      if (active !== element || pressed || !element.isConnected) {
        return;
      }
      const text = park(element).trim();
      if (text === '') {
        return;
      }
      shown = true;
      setTip({ text, anchor: element });
    };
    // React writing a new `title` while it is parked: take it over, or the
    // system tooltip would come back mid-hover with the new words.
    const watcher = new MutationObserver(() => {
      if (active === null || !active.hasAttribute('title')) {
        return;
      }
      const text = park(active).trim();
      if (shown) {
        setTip(text === '' ? null : { text, anchor: active });
      }
    });
    const release = (): void => {
      watcher.disconnect();
      if (active !== null) {
        unpark(active);
      }
      active = null;
      pressed = false;
      hide();
    };

    const onOver = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        return;
      }
      const element = titledElement(event.target);
      if (element === active) {
        return;
      }
      release();
      if (element === null) {
        return;
      }
      active = element;
      // Parked NOW, not when the tooltip shows: the system starts its own
      // timer on the same hover, and would win the race otherwise.
      park(element);
      watcher.observe(element, {
        attributes: true,
        attributeFilter: ['title'],
      });
      const warm = Date.now() - closedAt < TOOLTIP_WARM_MS;
      openTimer = setTimeout(
        () => show(element),
        warm ? 0 : TOOLTIP_OPEN_DELAY_MS,
      );
    };
    const onOut = (event: PointerEvent): void => {
      if (active === null) {
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && active.contains(next)) {
        return;
      }
      // Onto a titled element: its own `pointerover` takes over from here.
      release();
    };
    const onPress = (): void => {
      pressed = true;
      hide();
    };
    const onScroll = (): void => {
      hide();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('keydown', onPress, true);
    document.addEventListener('wheel', onScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('keydown', onPress, true);
      document.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);

  // Measured once mounted, and followed while shown: the element can move
  // (a list re-sorting) or go away (a press that removed it) under a pointer
  // that never left it, and no event says so.
  React.useLayoutEffect(() => {
    if (tip === null) {
      setPosition(null);
      return;
    }
    let frame = 0;
    const follow = (): void => {
      const element = tipRef.current;
      if (!tip.anchor.isConnected) {
        setTip(null);
        return;
      }
      if (element !== null) {
        const next = placeTooltip(
          tip.anchor.getBoundingClientRect(),
          { width: element.offsetWidth, height: element.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
        );
        setPosition((was) =>
          was !== null &&
          was.left === next.left &&
          was.top === next.top &&
          was.side === next.side &&
          was.arrow === next.arrow
            ? was
            : next,
        );
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [tip]);

  if (tip === null) {
    return null;
  }
  return createPortal(
    <div
      ref={tipRef}
      id={tipId}
      role="tooltip"
      data-slot="tooltip"
      // Off-screen and invisible until measured, so it never paints at 0,0.
      style={
        position === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: position.left, top: position.top }
      }
      // The app's popover surface, not a system-looking label — "выглядит
      // так же, как и до этого … некрасивый системный лейбл": the hairline,
      // the large shadow and the arrow onto its control are what the OS's
      // own tooltip has none of.
      className="pointer-events-none fixed z-60 max-w-[min(24rem,calc(100vw-16px))] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-snug font-medium break-words whitespace-pre-line text-popover-foreground shadow-panel-lg">
      {position === null ? null : (
        <span
          aria-hidden
          data-slot="tooltip-arrow"
          style={{ left: position.arrow }}
          className={cn(
            'absolute size-2 -translate-x-1/2 rotate-45 border-border bg-popover',
            position.side === 'bottom'
              ? '-top-1 border-t border-l'
              : '-bottom-1 border-r border-b',
          )}
        />
      )}
      {tip.text}
    </div>,
    document.body,
  );
}
