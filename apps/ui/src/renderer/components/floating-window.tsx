import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import * as React from 'react';

import { Button } from './ui/button';
import { popoverSurface } from './ui/popover';
import { cn } from './ui/utils';

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingBounds {
  width: number;
  height: number;
}

export const FLOATING_MIN_WIDTH = 320;
export const FLOATING_MIN_HEIGHT = 240;

const DEFAULT_MIN: FloatingBounds = {
  width: FLOATING_MIN_WIDTH,
  height: FLOATING_MIN_HEIGHT,
};
const CASCADE_SIZE: FloatingBounds = { width: 460, height: 560 };
const CASCADE_ORIGIN = 16;
const CASCADE_STEP = 28;
const CASCADE_STEPS = 8;

const NO_DRAG_SELECTOR =
  'button, a, input, textarea, [role="menuitem"], [data-no-drag]';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const RESIZE_EDGES: readonly ResizeEdge[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
];

const windowVariants = cva('flex flex-col overflow-hidden bg-card', {
  variants: {
    fullScreen: {
      true: 'inset-0 rounded-none',
      false: '',
    },
  },
  defaultVariants: { fullScreen: false },
});

const headerVariants = cva(
  'flex h-9 shrink-0 select-none items-center gap-1.5 border-b border-border bg-muted/40 px-2',
  {
    variants: {
      draggable: {
        true: 'touch-none cursor-grab active:cursor-grabbing',
        false: '',
      },
    },
    defaultVariants: { draggable: false },
  },
);

const resizeHandleVariants = cva('absolute z-10 touch-none select-none', {
  variants: {
    edge: {
      n: 'inset-x-3 top-0 h-1.5 cursor-ns-resize',
      s: 'inset-x-3 bottom-0 h-1.5 cursor-ns-resize',
      e: 'inset-y-3 right-0 w-1.5 cursor-ew-resize',
      w: 'inset-y-3 left-0 w-1.5 cursor-ew-resize',
      ne: 'right-0 top-0 size-3 cursor-nesw-resize',
      nw: 'left-0 top-0 size-3 cursor-nwse-resize',
      se: 'bottom-0 right-0 size-3 cursor-nwse-resize',
      sw: 'bottom-0 left-0 size-3 cursor-nesw-resize',
    },
  },
});

interface Delta {
  dx: number;
  dy: number;
}

interface Span {
  start: number;
  size: number;
}

interface Gesture {
  pointerId: number;
  edge: ResizeEdge | null;
  startX: number;
  startY: number;
  origin: FloatingRect;
}

function within(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

function clampAxis(start: number, size: number, extent: number): number {
  return extent > 0 ? within(start, 0, extent - size) : Math.max(0, start);
}

export function clampRect(
  rect: FloatingRect,
  bounds: FloatingBounds,
  min: FloatingBounds = DEFAULT_MIN,
): FloatingRect {
  const width = Math.max(min.width, Math.min(rect.width, bounds.width));
  const height = Math.max(min.height, Math.min(rect.height, bounds.height));
  return {
    x: clampAxis(rect.x, width, bounds.width),
    y: clampAxis(rect.y, height, bounds.height),
    width,
    height,
  };
}

export function cascadeRect(
  index: number,
  bounds: FloatingBounds,
  size: FloatingBounds = CASCADE_SIZE,
): FloatingRect {
  const offset = CASCADE_ORIGIN + (index % CASCADE_STEPS) * CASCADE_STEP;
  return clampRect(
    { x: offset, y: offset, width: size.width, height: size.height },
    bounds,
  );
}

function moveRect(origin: FloatingRect, delta: Delta): FloatingRect {
  return { ...origin, x: origin.x + delta.dx, y: origin.y + delta.dy };
}

function resizeAxis(
  start: number,
  size: number,
  delta: number,
  fromStart: boolean,
  fromEnd: boolean,
  extent: number,
  min: number,
): Span {
  if (fromStart) {
    const end = start + size;
    const nextStart = within(start + delta, 0, end - min);
    return { start: nextStart, size: end - nextStart };
  }
  if (fromEnd) {
    return { start, size: within(size + delta, min, extent - start) };
  }
  return { start, size };
}

function resizeRect(
  origin: FloatingRect,
  edge: ResizeEdge,
  delta: Delta,
  bounds: FloatingBounds,
): FloatingRect {
  const x = resizeAxis(
    origin.x,
    origin.width,
    delta.dx,
    edge.includes('w'),
    edge.includes('e'),
    bounds.width,
    FLOATING_MIN_WIDTH,
  );
  const y = resizeAxis(
    origin.y,
    origin.height,
    delta.dy,
    edge.includes('n'),
    edge.includes('s'),
    bounds.height,
    FLOATING_MIN_HEIGHT,
  );
  return clampRect(
    { x: x.start, y: y.start, width: x.size, height: y.size },
    bounds,
  );
}

function startsDrag(target: EventTarget | null, header: HTMLElement): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const blocker = target.closest(NO_DRAG_SELECTOR);
  return blocker === null || !header.contains(blocker);
}

interface FloatingWindowProps {
  label: string;
  title: React.ReactNode;
  actions?: React.ReactNode;
  rect: FloatingRect;
  onRectChange: (rect: FloatingRect) => void;
  bounds: FloatingBounds;
  zIndex: number;
  onFocus: () => void;
  onClose: () => void;
  fullScreen?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function FloatingWindow({
  label,
  title,
  actions,
  rect,
  onRectChange,
  bounds,
  zIndex,
  onFocus,
  onClose,
  fullScreen = false,
  children,
  className,
}: FloatingWindowProps): React.JSX.Element {
  const gesture = React.useRef<Gesture | null>(null);
  const placed = bounds.width > 0 ? clampRect(rect, bounds) : rect;

  const begin = (
    event: React.PointerEvent<HTMLElement>,
    edge: ResizeEdge | null,
  ): void => {
    if (event.button !== 0 || gesture.current !== null) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      origin: placed,
    };
  };

  const follow = (event: React.PointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    const delta = {
      dx: event.clientX - active.startX,
      dy: event.clientY - active.startY,
    };
    const next =
      active.edge === null
        ? moveRect(active.origin, delta)
        : resizeRect(active.origin, active.edge, delta, bounds);
    onRectChange(clampRect(next, bounds));
  };

  const release = (event: React.PointerEvent<HTMLElement>): void => {
    if (gesture.current?.pointerId === event.pointerId) {
      gesture.current = null;
    }
  };

  const gestureHandlers = {
    onPointerMove: follow,
    onPointerUp: release,
    onPointerCancel: release,
  };

  const onHeaderPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (startsDrag(event.target, event.currentTarget)) {
      begin(event, null);
    }
  };

  const placement: React.CSSProperties = fullScreen
    ? { zIndex }
    : {
        left: placed.x,
        top: placed.y,
        width: placed.width,
        height: placed.height,
        zIndex,
      };

  return (
    <div
      role="dialog"
      aria-modal={false}
      aria-label={label}
      data-slot="floating-window"
      onPointerDownCapture={() => onFocus()}
      style={placement}
      className={cn(popoverSurface, windowVariants({ fullScreen }), className)}>
      <div
        data-slot="floating-window-header"
        onPointerDown={fullScreen ? undefined : onHeaderPointerDown}
        {...gestureHandlers}
        className={headerVariants({ draggable: !fullScreen })}>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </div>
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={`Close ${label}`}
          title="Close"
          onClick={() => onClose()}>
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      {!fullScreen &&
        RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            data-slot="floating-window-resize"
            data-edge={edge}
            aria-hidden
            className={resizeHandleVariants({ edge })}
            onPointerDown={(event) => begin(event, edge)}
            {...gestureHandlers}
          />
        ))}
    </div>
  );
}
