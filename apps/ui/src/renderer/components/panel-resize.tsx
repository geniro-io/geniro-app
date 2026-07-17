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

function readWidth(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function usePanelWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  handleEdge,
}: PanelWidthOptions): {
  width: number;
  startResize: (event: React.MouseEvent) => void;
} {
  const [width, setWidth] = useState(() => readWidth(storageKey, defaultWidth));

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

  return { width, startResize };
}

/**
 * The draggable edge itself — absolutely positioned inside a `relative` panel.
 * A centered grip pill keeps the affordance visible at rest; without it the
 * handle is an invisible 6px strip nobody discovers.
 */
export function PanelResizeHandle({
  edge,
  label,
  onMouseDown,
}: {
  edge: 'left' | 'right';
  label: string;
  onMouseDown: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onMouseDown={onMouseDown}
      className={cn(
        'group absolute inset-y-0 z-10 flex w-1.5 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/30 active:bg-primary/40',
        edge === 'right' ? 'right-0' : 'left-0',
      )}>
      <span
        aria-hidden="true"
        className="h-8 w-1 shrink-0 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-active:bg-primary"
      />
    </div>
  );
}
