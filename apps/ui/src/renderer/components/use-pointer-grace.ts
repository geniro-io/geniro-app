import { useEffect, useMemo, useRef } from 'react';

import { useLatestCallback } from './use-latest-callback';

/** How long a hover-opened panel outlives the pointer leaving the control that opened it. */
export const POINTER_GRACE_MS = 300;

const BLEED = 5;

export interface Point {
  x: number;
  y: number;
}

export type PointerExit = Pick<MouseEvent, 'clientX' | 'clientY' | 'target'>;

export interface PointerGrace {
  /**
   * The pointer just left the control that opened `panel`. The panel stays
   * while the pointer heads for it, for at most {@link POINTER_GRACE_MS};
   * `onLapse` runs when it strays from that path or stops short. Leaving the
   * panel itself waits out the time alone.
   */
  start: (
    exit: PointerExit,
    panel: Element | null,
    onLapse: () => void,
  ) => void;
  /** Whether a pointer at `point` is still on its way to the panel. */
  covers: (point: Point) => boolean;
  /** Ends the grace without lapsing: the pointer is back, or the panel is gone. */
  stop: () => void;
}

interface ActiveGrace {
  area: Point[] | null;
  timer: ReturnType<typeof setTimeout>;
  listener: (event: MouseEvent) => void;
}

export const pointOf = (
  event: Pick<MouseEvent, 'clientX' | 'clientY'>,
): Point => ({
  x: event.clientX,
  y: event.clientY,
});

function within(box: DOMRect, point: Point): boolean {
  return (
    point.x >= box.left &&
    point.x <= box.right &&
    point.y >= box.top &&
    point.y <= box.bottom
  );
}

const cross = (o: Point, a: Point, b: Point): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (input: Point[]): Point[] => {
    const chain: Point[] = [];
    for (const point of input) {
      while (chain.length >= 2) {
        const last = chain.at(-1) ?? point;
        const before = chain.at(-2) ?? point;
        if (cross(before, last, point) > 0) {
          break;
        }
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function pathToward(exit: Point, box: DOMRect): Point[] {
  const nearest = {
    x: Math.min(Math.max(exit.x, box.left), box.right),
    y: Math.min(Math.max(exit.y, box.top), box.bottom),
  };
  const dx = exit.x - nearest.x;
  const dy = exit.y - nearest.y;
  const length = Math.hypot(dx, dy) || 1;
  return hull([
    { x: exit.x + (dx / length) * BLEED, y: exit.y + (dy / length) * BLEED },
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ]);
}

function isInside(point: Point, area: Point[]): boolean {
  let inside = false;
  for (const [index, a] of area.entries()) {
    const b = area.at(index - 1) ?? a;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The one rule for a panel opened by hovering: it survives the pointer
 * travelling from its control to it, across gaps and over other rows on the
 * way, and only that.
 */
export function usePointerGrace(): PointerGrace {
  const active = useRef<ActiveGrace | null>(null);

  const stop = useLatestCallback((): void => {
    const current = active.current;
    if (current === null) {
      return;
    }
    active.current = null;
    clearTimeout(current.timer);
    document.removeEventListener('mousemove', current.listener, true);
  }, []);

  const start = useLatestCallback(
    (exit: PointerExit, panel: Element | null, onLapse: () => void): void => {
      stop();
      if (panel === null) {
        onLapse();
        return;
      }
      const box = panel.getBoundingClientRect();
      const leftPanel =
        exit.target instanceof Node && panel.contains(exit.target);
      const area = leftPanel ? null : pathToward(pointOf(exit), box);
      const lapse = (): void => {
        stop();
        onLapse();
      };
      const listener = (event: MouseEvent): void => {
        const point = pointOf(event);
        if (within(box, point)) {
          stop();
        } else if (area !== null && !isInside(point, area)) {
          lapse();
        }
      };
      document.addEventListener('mousemove', listener, true);
      active.current = {
        area,
        listener,
        timer: setTimeout(lapse, POINTER_GRACE_MS),
      };
    },
    [stop],
  );

  const covers = useLatestCallback((point: Point): boolean => {
    const area = active.current?.area;
    return area !== undefined && area !== null && isInside(point, area);
  }, []);

  useEffect(() => stop, [stop]);

  return useMemo(() => ({ start, covers, stop }), [start, covers, stop]);
}
