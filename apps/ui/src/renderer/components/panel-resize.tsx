import { useCallback, useState } from 'react';

import { cn } from './ui/utils';

/**
 * Shared drag-to-resize behavior for the builder's side panels (the left
 * palette and the right inspector): a width state persisted in localStorage
 * plus the invisible edge handle that drives it. `handleEdge` names which
 * edge of the panel carries the handle — dragging away from the panel always
 * widens it, on either side.
 */
export interface PanelWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  handleEdge: 'left' | 'right';
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
      const startX = event.clientX;
      const startWidth = width;
      // Handle on the right edge: dragging right (+x) widens. On the left
      // edge the panel sits to the right, so dragging LEFT widens.
      const sign = handleEdge === 'right' ? 1 : -1;
      let latestWidth = startWidth;
      const onMove = (move: MouseEvent): void => {
        const next = Math.min(
          maxWidth,
          Math.max(minWidth, startWidth + sign * (move.clientX - startX)),
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
      document.body.style.cursor = 'col-resize';
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
  edge: 'left' | 'right';
  label: string;
  onMouseDown: (event: React.MouseEvent) => void;
  /** Current panel width (aria-valuenow + the keyboard step base). */
  value: number;
  min: number;
  max: number;
  /** Keyboard resize — the hook's clamped `resizeTo`. */
  onResize: (next: number) => void;
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={(event) => {
        // Arrow keys move the SEPARATOR (not "grow/shrink"): with the handle
        // on the panel's right edge, moving right widens; on the left edge
        // the panel sits to the right, so moving left widens — the same sign
        // convention as the drag path.
        const sign = edge === 'right' ? 1 : -1;
        let next: number | null = null;
        if (event.key === 'ArrowRight') {
          next = value + sign * KEYBOARD_RESIZE_STEP;
        } else if (event.key === 'ArrowLeft') {
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
        'group absolute inset-y-0 z-10 flex w-1.5 cursor-col-resize items-center justify-center transition-colors outline-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-primary/40',
        edge === 'right' ? 'right-0' : 'left-0',
      )}>
      <span
        aria-hidden="true"
        className="h-8 w-1 shrink-0 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary group-active:bg-primary"
      />
    </div>
  );
}
