import { cva } from 'class-variance-authority';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';

import { Button } from './ui/button';
import { cn } from './ui/utils';
import { useElementSize } from './use-element-size';

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBounds {
  width: number;
  height: number;
}

export type WindowEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGES: readonly WindowEdge[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
];

export const WINDOW_MIN_SIZE = { width: 320, height: 240 } as const;

/** The window's head, in pixels: what is left of it while it is minimised. */
export const WINDOW_HEAD_HEIGHT = 44;

/** The gap a window keeps from its bounds when it first opens. */
const WINDOW_MARGIN = 16;

function within(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

/** `rect` made to fit `bounds`: never smaller than the least a window may be, never past an edge. */
export function clampWindow(
  rect: WindowRect,
  bounds: WindowBounds,
): WindowRect {
  const width = within(
    rect.width,
    Math.min(WINDOW_MIN_SIZE.width, bounds.width),
    bounds.width,
  );
  const height = within(
    rect.height,
    Math.min(WINDOW_MIN_SIZE.height, bounds.height),
    bounds.height,
  );
  return {
    x: within(rect.x, 0, bounds.width - width),
    y: within(rect.y, 0, bounds.height - height),
    width,
    height,
  };
}

/** Where a window opens when its caller names no place: its bounds' bottom-right corner. */
export function cornerWindow(
  bounds: WindowBounds,
  size: { width: number; height: number },
  inset: { right: number; bottom: number } = {
    right: WINDOW_MARGIN,
    bottom: WINDOW_MARGIN,
  },
): WindowRect {
  return clampWindow(
    {
      x: bounds.width - size.width - inset.right,
      y: bounds.height - size.height - inset.bottom,
      width: size.width,
      height: size.height,
    },
    bounds,
  );
}

/** The rect a drag of `edge` by `delta` leaves the window at, held inside `bounds`. */
export function resizeWindow(
  origin: WindowRect,
  edge: WindowEdge,
  delta: { dx: number; dy: number },
  bounds: WindowBounds,
): WindowRect {
  let { x, y, width, height } = origin;
  if (edge.includes('e')) {
    width = within(
      origin.width + delta.dx,
      WINDOW_MIN_SIZE.width,
      bounds.width - origin.x,
    );
  }
  if (edge.includes('s')) {
    height = within(
      origin.height + delta.dy,
      WINDOW_MIN_SIZE.height,
      bounds.height - origin.y,
    );
  }
  if (edge.includes('w')) {
    const right = origin.x + origin.width;
    x = within(origin.x + delta.dx, 0, right - WINDOW_MIN_SIZE.width);
    width = right - x;
  }
  if (edge.includes('n')) {
    const bottom = origin.y + origin.height;
    y = within(origin.y + delta.dy, 0, bottom - WINDOW_MIN_SIZE.height);
    height = bottom - y;
  }
  return { x, y, width, height };
}

const edgeVariants = cva('absolute z-10 touch-none select-none', {
  variants: {
    edge: {
      n: 'inset-x-3 top-0 h-1.5 cursor-ns-resize',
      s: 'inset-x-3 bottom-0 h-1.5 cursor-ns-resize',
      e: 'inset-y-3 right-0 w-1.5 cursor-ew-resize',
      w: 'inset-y-3 left-0 w-1.5 cursor-ew-resize',
      ne: 'top-0 right-0 size-3 cursor-nesw-resize',
      nw: 'top-0 left-0 size-3 cursor-nwse-resize',
      se: 'right-0 bottom-0 size-3 cursor-nwse-resize',
      sw: 'bottom-0 left-0 size-3 cursor-nesw-resize',
    } satisfies Record<WindowEdge, string>,
  },
});

type Gesture =
  | {
      kind: 'move';
      pointerId: number;
      startX: number;
      startY: number;
      origin: WindowRect;
    }
  | {
      kind: 'resize';
      edge: WindowEdge;
      pointerId: number;
      startX: number;
      startY: number;
      origin: WindowRect;
    };

function HeadButton({
  label,
  title,
  slot,
  onClick,
  children,
}: {
  label: string;
  title: string;
  slot: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot={slot}
      aria-label={label}
      title={title}
      className="size-7 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * A window over a page: moved by its head, resized from any edge or corner,
 * minimised to its head, maximised to fill the page and restored, and closed.
 * It stands inside the nearest positioned ancestor, which it never leaves,
 * and is drawn again inside it when that shrinks. Closed, it stays mounted and
 * hidden, so what it holds keeps its state. On a phone it fills the page.
 */
export function FloatingWindow({
  label,
  title,
  open,
  phone = false,
  initialRect,
  actions,
  onClose,
  children,
  slot = 'floating-window',
}: {
  label: string;
  title: React.ReactNode;
  open: boolean;
  phone?: boolean;
  /** Where the window first opens, given its bounds; its bottom-right corner when absent. */
  initialRect?: (bounds: WindowBounds) => WindowRect;
  /** Controls drawn in the head before minimise, maximise and close. */
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  slot?: string;
}): React.JSX.Element {
  const [measure, measuredBounds] = useElementSize();
  const [bounds, setBounds] = useState(measuredBounds);
  if (
    measuredBounds !== bounds &&
    measuredBounds.width > 0 &&
    measuredBounds.height > 0
  ) {
    setBounds(measuredBounds);
  }
  const [placed, setPlaced] = useState<WindowRect | null>(null);
  const [draft, setDraft] = useState<WindowRect | null>(null);
  const [minimised, setMinimised] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const measured = bounds.width > 0 && bounds.height > 0;
  const start =
    placed ??
    (measured
      ? (initialRect?.(bounds) ??
        cornerWindow(bounds, {
          width: Math.min(480, bounds.width - WINDOW_MARGIN * 2),
          height: Math.min(640, bounds.height - WINDOW_MARGIN * 2),
        }))
      : null);
  const rect = start === null ? null : clampWindow(draft ?? start, bounds);
  const shown = phone
    ? null
    : maximised
      ? { x: 0, y: 0, width: bounds.width, height: bounds.height }
      : rect === null
        ? null
        : minimised
          ? {
              ...rect,
              y: rect.y + rect.height - WINDOW_HEAD_HEIGHT,
              height: WINDOW_HEAD_HEIGHT,
            }
          : rect;

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    make: (origin: WindowRect) => Gesture,
  ): void => {
    if (
      phone ||
      maximised ||
      rect === null ||
      event.button !== 0 ||
      gesture.current !== null
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = make(rect);
  };
  const follow = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    const delta = {
      dx: event.clientX - active.startX,
      dy: event.clientY - active.startY,
    };
    setDraft(
      active.kind === 'move'
        ? {
            ...active.origin,
            x: active.origin.x + delta.dx,
            y: active.origin.y + delta.dy,
          }
        : resizeWindow(active.origin, active.edge, delta, bounds),
    );
  };
  const release = (event: ReactPointerEvent<HTMLElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) {
      return;
    }
    gesture.current = null;
    if (draft !== null) {
      setPlaced(clampWindow(draft, bounds));
      setDraft(null);
    }
  };

  return (
    <div
      ref={measure}
      hidden={!open}
      data-slot={`${slot}-bounds`}
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <section
        role="region"
        aria-label={label}
        data-slot={slot}
        data-state={maximised ? 'maximised' : minimised ? 'minimised' : 'open'}
        data-phone={phone || undefined}
        className={cn(
          'pointer-events-auto flex flex-col overflow-hidden bg-card',
          phone
            ? 'absolute inset-0'
            : 'absolute rounded-card border border-border shadow-panel-lg',
          !phone && shown === null && 'invisible',
        )}
        style={
          shown === null
            ? undefined
            : {
                left: shown.x,
                top: shown.y,
                width: shown.width,
                height: shown.height,
              }
        }>
        <header
          data-slot={`${slot}-head`}
          className={cn(
            'flex shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3',
            !phone && !maximised && 'cursor-grab touch-none select-none',
          )}
          style={{ height: WINDOW_HEAD_HEIGHT }}
          onPointerDown={(event) =>
            begin(event, (origin) => ({
              kind: 'move',
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              origin,
            }))
          }
          onPointerMove={follow}
          onPointerUp={release}
          onPointerCancel={release}
          onDoubleClick={() => {
            if (!phone) {
              setMaximised((now) => !now);
              setMinimised(false);
            }
          }}>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
            {title}
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
          {phone ? null : (
            <>
              <HeadButton
                slot={`${slot}-minimise`}
                label={minimised ? `Restore ${label}` : `Minimise ${label}`}
                title={minimised ? 'Restore' : 'Minimise'}
                onClick={() => {
                  setMinimised((now) => !now);
                  setMaximised(false);
                }}>
                {minimised ? (
                  <Maximize2 aria-hidden="true" />
                ) : (
                  <Minus aria-hidden="true" />
                )}
              </HeadButton>
              <HeadButton
                slot={`${slot}-maximise`}
                label={maximised ? `Restore ${label}` : `Maximise ${label}`}
                title={maximised ? 'Restore' : 'Maximise'}
                onClick={() => {
                  setMaximised((now) => !now);
                  setMinimised(false);
                }}>
                {maximised ? (
                  <Minimize2 aria-hidden="true" />
                ) : (
                  <Maximize2 aria-hidden="true" />
                )}
              </HeadButton>
            </>
          )}
          <HeadButton
            slot={`${slot}-close`}
            label={`Close ${label}`}
            title="Close"
            onClick={onClose}>
            <X aria-hidden="true" />
          </HeadButton>
        </header>
        <div
          hidden={minimised && !phone}
          data-slot={`${slot}-body`}
          className={cn(
            'relative min-h-0 flex-1 flex-col',
            minimised && !phone ? 'hidden' : 'flex',
          )}>
          {children}
        </div>
        {phone || maximised || minimised
          ? null
          : EDGES.map((edge) => (
              <div
                key={edge}
                aria-hidden
                data-slot={`${slot}-resize`}
                data-edge={edge}
                className={edgeVariants({ edge })}
                onPointerDown={(event) =>
                  begin(event, (origin) => ({
                    kind: 'resize',
                    edge,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    origin,
                  }))
                }
                onPointerMove={follow}
                onPointerUp={release}
                onPointerCancel={release}
              />
            ))}
      </section>
    </div>
  );
}
