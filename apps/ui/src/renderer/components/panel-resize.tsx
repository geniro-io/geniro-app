import { useCallback, useState } from 'react';

import { cn } from './ui/utils';

/**
 * Shared drag-to-resize behavior for the app's resizable panels: a size
 * persisted in localStorage plus the edge handle that drives it. `handleEdge`
 * names which edge of the panel carries the handle — dragging AWAY from the
 * panel always grows it, on any of the four.
 *
 * `top`/`bottom` came in with the debug drawer, which is the same interaction
 * on the other axis. Generalised rather than copied: the clamping, the
 * persisted-value migration, the persist-at-drag-end and the ARIA splitter
 * wiring are the parts worth getting right once, and a second hook would have
 * had to get all four right again.
 */
export type PanelEdge = 'left' | 'right' | 'top' | 'bottom';

/** Which axis an edge resizes along. */
function axisOf(edge: PanelEdge): 'x' | 'y' {
  return edge === 'left' || edge === 'right' ? 'x' : 'y';
}

export interface PanelWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  handleEdge: PanelEdge;
}

function readWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(localStorage.getItem(key));
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  // A width persisted under older (or hand-edited) bounds must re-enter the
  // current min/max — otherwise the panel restores narrower/wider than the
  // drag handle can ever reach again.
  return Math.min(max, Math.max(min, value));
}

export function usePanelWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  handleEdge,
}: PanelWidthOptions): {
  width: number;
  minWidth: number;
  maxWidth: number;
  startResize: (event: React.MouseEvent) => void;
  resizeTo: (next: number) => void;
} {
  const [width, setWidth] = useState(() =>
    readWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );

  // The keyboard path (arrow keys on the handle): clamp and persist per step —
  // discrete key presses, unlike the per-frame mousemove stream.
  const resizeTo = useCallback(
    (next: number): void => {
      const clamped = Math.min(maxWidth, Math.max(minWidth, next));
      setWidth(clamped);
      localStorage.setItem(storageKey, String(Math.round(clamped)));
    },
    [minWidth, maxWidth, storageKey],
  );

  const startResize = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      const axis = axisOf(handleEdge);
      const start = axis === 'x' ? event.clientX : event.clientY;
      const startWidth = width;
      // Handle on the right/bottom edge: dragging away from the panel (+x/+y)
      // grows it. On the left/top edge the panel lies the other way, so the
      // growing direction is negative.
      const sign = handleEdge === 'right' || handleEdge === 'bottom' ? 1 : -1;
      let latestWidth = startWidth;
      const onMove = (move: MouseEvent): void => {
        const position = axis === 'x' ? move.clientX : move.clientY;
        const next = Math.min(
          maxWidth,
          Math.max(minWidth, startWidth + sign * (position - start)),
        );
        latestWidth = next;
        setWidth(next);
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Persist once, at drag-end — NOT on every mousemove-driven render.
        // A live resize fires hundreds of these; a synchronous localStorage
        // write per frame stutters the canvas the drag is resizing.
        localStorage.setItem(storageKey, String(Math.round(latestWidth)));
      };
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, handleEdge, minWidth, maxWidth, storageKey],
  );

  return { width, minWidth, maxWidth, startResize, resizeTo };
}

/** Width change per arrow-key press on a focused resize handle. */
const KEYBOARD_RESIZE_STEP = 16;

/**
 * The draggable edge itself — absolutely positioned inside a `relative` panel.
 * A centered grip pill keeps the affordance visible at rest; without it the
 * handle is an invisible 6px strip nobody discovers. Implements the ARIA
 * window-splitter pattern: focusable, arrow keys move the separator (Home/End
 * to the bounds), and aria-valuenow reports the panel width.
 */
export function PanelResizeHandle({
  edge,
  label,
  onMouseDown,
  value,
  min,
  max,
  onResize,
}: {
  edge: PanelEdge;
  label: string;
  onMouseDown: (event: React.MouseEvent) => void;
  /** Current panel size (aria-valuenow + the keyboard step base). */
  value: number;
  min: number;
  max: number;
  /** Keyboard resize — the hook's clamped `resizeTo`. */
  onResize: (next: number) => void;
}): React.JSX.Element {
  const vertical = edge === 'left' || edge === 'right';
  return (
    <div
      role="separator"
      // The separator's own orientation is PERPENDICULAR to the axis it moves
      // along: a handle that slides horizontally is a vertical divider.
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={(event) => {
        // Arrow keys move the SEPARATOR (not "grow/shrink"): with the handle
        // on the panel's right/bottom edge, moving away from the panel grows
        // it; on the left/top edge the panel lies the other way — the same
        // sign convention as the drag path.
        const sign = edge === 'right' || edge === 'bottom' ? 1 : -1;
        const grow = vertical ? 'ArrowRight' : 'ArrowDown';
        const shrink = vertical ? 'ArrowLeft' : 'ArrowUp';
        let next: number | null = null;
        if (event.key === grow) {
          next = value + sign * KEYBOARD_RESIZE_STEP;
        } else if (event.key === shrink) {
          next = value - sign * KEYBOARD_RESIZE_STEP;
        } else if (event.key === 'Home') {
          next = min;
        } else if (event.key === 'End') {
          next = max;
        }
        if (next !== null) {
          event.preventDefault();
          onResize(next);
        }
      }}
      className={cn(
        'group absolute z-10 flex items-center justify-center transition-colors outline-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-primary/40',
        vertical
          ? 'inset-y-0 w-1.5 cursor-col-resize'
          : 'inset-x-0 h-1.5 cursor-row-resize',
        edge === 'right' && 'right-0',
        edge === 'left' && 'left-0',
        edge === 'top' && 'top-0',
        edge === 'bottom' && 'bottom-0',
      )}>
      <span
        aria-hidden="true"
        className={cn(
          'shrink-0 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary group-active:bg-primary',
          vertical ? 'h-8 w-1' : 'h-1 w-8',
        )}
      />
    </div>
  );
}
