import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from './utils';

export const TOOLTIP_OPEN_DELAY_MS = 300;

const TOOLTIP_WARM_MS = 500;

const GAP_PX = 8;
const EDGE_MARGIN_PX = 8;
const ARROW_INSET_PX = 12;

const PARKED_ATTR = 'data-tooltip-title';

export function placeTooltip(
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): {
  left: number;
  top: number;
  side: 'top' | 'bottom';
  arrow: number | null;
} {
  const below = viewport.height - anchor.bottom - GAP_PX - EDGE_MARGIN_PX;
  const above = anchor.top - GAP_PX - EDGE_MARGIN_PX;
  const fits = tip.height <= below || tip.height <= above;
  const side =
    tip.height <= below || (tip.height > above && below >= above)
      ? 'bottom'
      : 'top';
  const wanted =
    side === 'bottom'
      ? anchor.bottom + GAP_PX
      : anchor.top - GAP_PX - tip.height;
  const top = Math.min(
    Math.max(wanted, EDGE_MARGIN_PX),
    Math.max(EDGE_MARGIN_PX, viewport.height - tip.height - EDGE_MARGIN_PX),
  );
  const centre = anchor.left + anchor.width / 2;
  const left = Math.min(
    Math.max(centre - tip.width / 2, EDGE_MARGIN_PX),
    Math.max(EDGE_MARGIN_PX, viewport.width - tip.width - EDGE_MARGIN_PX),
  );
  const arrow = fits
    ? Math.min(
        Math.max(centre - left, ARROW_INSET_PX),
        Math.max(ARROW_INSET_PX, tip.width - ARROW_INSET_PX),
      )
    : null;
  return { left, top, side, arrow };
}

const TITLED = `[title]:not([title=""]):not(iframe), [${PARKED_ATTR}]`;

function titledElement(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) {
    return null;
  }
  return node.closest(TITLED);
}

function titledBeneath(hit: Element, x: number, y: number): Element | null {
  let scope: Element | null = hit;
  for (let depth = 0; scope !== null && depth < 3; depth += 1) {
    let best: Element | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const element of scope.querySelectorAll(TITLED)) {
      const r = element.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
        continue;
      }
      if (element.closest('[aria-hidden="true"]') !== null) {
        continue;
      }
      if (
        typeof element.checkVisibility === 'function' &&
        !element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        })
      ) {
        continue;
      }
      const area = r.width * r.height;
      if (area < bestArea) {
        best = element;
        bestArea = area;
      }
    }
    if (best !== null) {
      return best;
    }
    scope = scope.parentElement;
  }
  return null;
}

function park(element: Element): string {
  const title = element.getAttribute('title');
  if (title !== null) {
    element.setAttribute(PARKED_ATTR, title);
    element.removeAttribute('title');
  }
  return element.getAttribute(PARKED_ATTR) ?? '';
}

function unpark(element: Element): void {
  const parked = element.getAttribute(PARKED_ATTR);
  element.removeAttribute(PARKED_ATTR);
  if (parked !== null && !element.hasAttribute('title')) {
    element.setAttribute('title', parked);
  }
}

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
    let activeBeneath = false;
    let pressed = false;
    let moveFrame = 0;
    let lastMove: PointerEvent | null = null;
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
      activeBeneath = false;
      pressed = false;
      hide();
    };

    const consider = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        return;
      }
      const own = titledElement(event.target);
      const element =
        own ??
        (event.target instanceof Element
          ? titledBeneath(event.target, event.clientX, event.clientY)
          : null);
      if (element === active) {
        return;
      }
      release();
      if (element === null) {
        return;
      }
      active = element;
      activeBeneath = own === null;
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
    const onMove = (event: PointerEvent): void => {
      lastMove = event;
      if (moveFrame !== 0) {
        return;
      }
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        if (lastMove !== null) {
          consider(lastMove);
        }
      });
    };
    const onOut = (event: PointerEvent): void => {
      if (active === null) {
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && active.contains(next)) {
        return;
      }
      if (activeBeneath && next !== null) {
        return;
      }
      release();
    };
    const onPress = (): void => {
      pressed = true;
      hide();
    };
    const onScroll = (): void => {
      hide();
    };

    document.addEventListener('pointerover', consider, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('keydown', onPress, true);
    document.addEventListener('wheel', onScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('pointerover', consider, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerout', onOut, true);
      cancelAnimationFrame(moveFrame);
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('keydown', onPress, true);
      document.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);

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
      style={
        position === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: position.left, top: position.top }
      }
      className="pointer-events-none fixed z-60 max-w-[min(24rem,calc(100vw-16px))] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-snug font-medium break-words whitespace-pre-line text-popover-foreground shadow-panel-lg">
      {position === null || position.arrow === null ? null : (
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
