import { useEffect } from 'react';

import { useLatestCallback } from '../components/use-latest-callback';

/** How long the wheel may rest before the next event starts a new gesture. */
export const WHEEL_LATCH_GAP_MS = 150;

/** Who a wheel gesture belongs to: the graph it started on, or whatever else it started over. */
export interface WheelLatch {
  owner: 'graph' | 'other';
  until: number;
}

/** The latch after one wheel event: the running gesture carries on, or a rested wheel starts a new one where it is. */
export function latchWheel(
  latch: WheelLatch | null,
  now: number,
  startsOnGraph: boolean,
): WheelLatch {
  const owner =
    latch !== null && now <= latch.until
      ? latch.owner
      : startsOnGraph
        ? 'graph'
        : 'other';
  return { owner, until: now + WHEEL_LATCH_GAP_MS };
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const LINE_PX = 16;
const PAGE_PX = 800;
const PINCH_SPEED = 0.02;

function pixels(delta: number, mode: number): number {
  return mode === 1 ? delta * LINE_PX : mode === 2 ? delta * PAGE_PX : delta;
}

/**
 * Where one wheel event takes the view: a pan by its deltas, or — a pinch,
 * which the browser sends with `ctrlKey` — a zoom about the pointer, held
 * between `minZoom` and `maxZoom`. `pointer` is in the pane's own pixels.
 */
export function wheelStep(
  view: Viewport,
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey'>,
  pointer: { x: number; y: number },
  limits: { minZoom: number; maxZoom: number },
): Viewport {
  const dx = pixels(event.deltaX, event.deltaMode);
  const dy = pixels(event.deltaY, event.deltaMode);
  if (!event.ctrlKey) {
    return { x: view.x - dx, y: view.y - dy, zoom: view.zoom };
  }
  const zoom = Math.min(
    limits.maxZoom,
    Math.max(limits.minZoom, view.zoom * 2 ** (-dy * PINCH_SPEED)),
  );
  const scale = zoom / view.zoom;
  return {
    x: pointer.x - (pointer.x - view.x) * scale,
    y: pointer.y - (pointer.y - view.y) * scale,
    zoom,
  };
}

/**
 * Keep a wheel or two-finger gesture with what it started on. One that starts
 * on the graph keeps moving it while the pointer crosses an open card, a
 * floating chat window or anything else, through `moveGraph`; one that starts
 * over a chat keeps the graph still when the pointer wanders onto it.
 * `graphOf` names the element the graph handles the wheel in itself.
 */
export function useWheelLatch(
  graphOf: () => HTMLElement | null,
  enabled: boolean,
  moveGraph: (event: WheelEvent) => void,
): void {
  const move = useLatestCallback(moveGraph, []);
  const graph = useLatestCallback(graphOf, []);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let latch: WheelLatch | null = null;
    const onWheel = (event: WheelEvent): void => {
      const area = graph();
      const onGraph =
        area !== null &&
        event.target instanceof Node &&
        area.contains(event.target);
      latch = latchWheel(latch, event.timeStamp, onGraph);
      if (latch.owner === 'graph' && !onGraph) {
        event.preventDefault();
        event.stopPropagation();
        move(event);
      } else if (latch.owner === 'other' && onGraph) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    return () =>
      window.removeEventListener('wheel', onWheel, { capture: true });
  }, [enabled, graph, move]);
}
