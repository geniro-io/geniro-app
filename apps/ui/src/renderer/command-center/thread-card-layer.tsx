import { useStoreApi } from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { ArrowLeft } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  ArchiveThreadIcon,
  useThreadArchive,
} from '../components/thread-archive';
import { ThreadHead, type ThreadIdentity } from '../components/thread-head';
import type { ThreadAttention } from '../components/thread-labels';
import { Button } from '../components/ui/button';
import { PALETTE_DOT_CLASS } from '../components/ui/palette';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { usePhoneBackEntry } from '../components/use-phone-back-entry';
import type { PlacedBox } from './graph-layout';
import { type CardSize, MIN_CARD_SIZE } from './open-cards';
import { OpenInChatsIcon, ShowChatIcon } from './thread-card';

/** The card's head above its chat, in pixels: the thread head and its padding. */
export const CARD_HEAD_HEIGHT = 66;

/** How far, in pixels, a press must travel before it moves a node or a card rather than clicking it. */
export const DRAG_THRESHOLD = 5;

/**
 * How long a zoom must rest before a card takes it as CSS `zoom`, which lays
 * its whole chat out again; until then the card is scaled by a transform.
 */
export const ZOOM_SETTLE_MS = 160;

/** The room a card leaves the graph pane's edges when it is as big as it may get. */
const PANE_INSET = 16;
const CARD_UNDER_WINDOW_Z = 20;
const CARD_OVER_WINDOW_Z = 35;

/** A thread open as a card on the canvas. */
export interface CanvasCard {
  runId: string;
  identity: ThreadIdentity;
  attention: ThreadAttention;
  size: CardSize;
  aboveWindow: boolean;
}

type ResizeEdge = 's' | 'e' | 'se';

const RESIZE_EDGES: readonly ResizeEdge[] = ['s', 'e', 'se'];

interface Gesture {
  pointerId: number;
  edge: ResizeEdge;
  startX: number;
  startY: number;
  origin: CardSize;
}

interface HeadPress {
  pointerId: number;
  startX: number;
  startY: number;
  moving: boolean;
  last: CardMove;
}

/** A move of the card by its head, in screen pixels from where the press began. */
export interface CardMove {
  dx: number;
  dy: number;
}

/** The most a card's chat may take: never wider or taller than the pane it stands in. */
export function largestCard(pane: { width: number; height: number }): CardSize {
  return {
    width: Math.max(MIN_CARD_SIZE.width, pane.width - PANE_INSET * 2),
    height: Math.max(
      MIN_CARD_SIZE.height,
      pane.height - CARD_HEAD_HEIGHT - PANE_INSET * 2,
    ),
  };
}

function within(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/** `size` held between the smallest card and `largest`. */
export function clampCard(size: CardSize, largest: CardSize): CardSize {
  return {
    width: within(size.width, MIN_CARD_SIZE.width, largest.width),
    height: within(size.height, MIN_CARD_SIZE.height, largest.height),
  };
}

/** The size a drag from the card's bottom edge, right edge or corner leaves it at, `delta` in the card's own pixels. */
export function resizeCard(
  origin: CardSize,
  edge: ResizeEdge,
  delta: { dx: number; dy: number },
  largest: CardSize,
): CardSize {
  return clampCard(
    {
      width: edge === 's' ? origin.width : origin.width + delta.dx,
      height: edge === 'e' ? origin.height : origin.height + delta.dy,
    },
    largest,
  );
}

const cardVariants = cva(
  'pointer-events-auto flex flex-col overflow-hidden rounded-card border bg-card text-left shadow-lg',
  {
    variants: {
      attention: {
        blocked: 'border-destructive/50',
        working: 'border-success/50',
        question: 'border-warning/60',
        quiet: 'border-border-strong',
        inactive: 'border-border-strong',
        done: 'border-border-strong',
      } satisfies Record<ThreadAttention, string>,
    },
  },
);

const resizeVariants = cva('absolute z-30 touch-none select-none', {
  variants: {
    edge: {
      s: 'inset-x-4 bottom-0 h-1.5 cursor-ns-resize',
      e: 'inset-y-4 right-0 w-1.5 cursor-ew-resize',
      se: 'right-0 bottom-0 flex size-4 items-end justify-end p-0.5 text-muted-foreground cursor-nwse-resize hover:text-foreground',
    } satisfies Record<ResizeEdge, string>,
  },
});

function ResizeGrip(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      data-slot="thread-canvas-card-grip"
      viewBox="0 0 10 10"
      className="size-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round">
      <path d="M9 3L3 9M9 6L6 9" />
    </svg>
  );
}

function CardHead({
  card,
  open,
  onClose,
  onOpenInChats,
  onMove,
  leading,
}: {
  card: CanvasCard;
  open: boolean;
  onClose: () => void;
  onOpenInChats: () => void;
  onMove?: (move: CardMove, done: boolean) => void;
  leading?: React.ReactNode;
}): React.JSX.Element {
  const title = card.identity.title;
  const press = useRef<HeadPress | null>(null);
  const moveOf = (event: ReactPointerEvent<HTMLElement>, from: HeadPress) => ({
    dx: event.clientX - from.startX,
    dy: event.clientY - from.startY,
  });
  const begin = (event: ReactPointerEvent<HTMLElement>): void => {
    if (onMove === undefined || event.button !== 0 || press.current?.moving) {
      return;
    }
    press.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moving: false,
      last: { dx: 0, dy: 0 },
    };
  };
  const follow = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = press.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    const move = moveOf(event, active);
    if (!active.moving) {
      if (Math.hypot(move.dx, move.dy) < DRAG_THRESHOLD) {
        return;
      }
      active.moving = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    active.last = move;
    onMove?.(move, false);
  };
  const finish = (
    event: ReactPointerEvent<HTMLElement>,
    at: (active: HeadPress) => CardMove,
  ): void => {
    const active = press.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    press.current = null;
    if (active.moving) {
      onMove?.(at(active), true);
    }
  };
  const forget = (): void => {
    if (press.current?.moving === false) {
      press.current = null;
    }
  };
  const archive = useThreadArchive(card.runId);
  return (
    <div
      data-slot="thread-canvas-card-head"
      className={cn(
        'flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2.5',
        onMove !== undefined && 'cursor-grab touch-none select-none',
      )}
      style={{ height: CARD_HEAD_HEIGHT }}
      onPointerDown={begin}
      onPointerMove={follow}
      onPointerUp={(event) => finish(event, (active) => moveOf(event, active))}
      onPointerCancel={(event) => finish(event, (active) => active.last)}
      onPointerLeave={forget}>
      {leading}
      <div className="min-w-0 flex-1">
        <ThreadHead
          slot="thread-canvas-card"
          identity={card.identity}
          aside={
            <>
              {card.attention === 'working' ? (
                <Spinner pace="stepped" className="size-3.5 text-success" />
              ) : null}
              {open ? (
                <ShowChatIcon title={title} open onToggle={onClose} />
              ) : null}
              {archive === null ? null : (
                <ArchiveThreadIcon title={title} onArchive={archive} />
              )}
              <OpenInChatsIcon title={title} onOpen={onOpenInChats} />
            </>
          }
        />
      </div>
    </div>
  );
}

function CanvasThreadCard({
  card,
  largest,
  zoomOf,
  flash,
  onClose,
  onResize,
  onMove,
  onOpenInChats,
  chat,
}: {
  card: CanvasCard;
  largest: CardSize;
  /** The flow's zoom now, which the card is drawn at. */
  zoomOf: () => number;
  flash: number | null;
  onClose: () => void;
  onResize: (size: CardSize) => void;
  onMove: (move: CardMove, done: boolean) => void;
  onOpenInChats: () => void;
  chat: React.ReactNode;
}): React.JSX.Element {
  const [draft, setDraft] = useState<CardSize | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const size = clampCard(draft ?? card.size, largest);

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    edge: ResizeEdge,
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
      origin: size,
    };
  };
  const follow = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    const zoom = zoomOf();
    const onScreen = Math.min(1, 1 / zoom);
    setDraft(
      resizeCard(
        active.origin,
        active.edge,
        {
          dx: (event.clientX - active.startX) / zoom,
          dy: (event.clientY - active.startY) / zoom,
        },
        {
          width: largest.width * onScreen,
          height: largest.height * onScreen,
        },
      ),
    );
  };
  const release = (event: ReactPointerEvent<HTMLElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) {
      return;
    }
    gesture.current = null;
    if (draft !== null) {
      onResize(draft);
      setDraft(null);
    }
  };

  return (
    <section
      aria-label={`${card.identity.title}, its chat`}
      data-slot="thread-canvas-card"
      data-run-id={card.runId}
      data-attention={card.attention}
      className={cn('relative', cardVariants({ attention: card.attention }))}
      style={{ width: size.width, height: CARD_HEAD_HEIGHT + size.height }}>
      {card.identity.projectColor === null ? null : (
        <span
          aria-hidden="true"
          data-slot="thread-canvas-card-project-stripe"
          data-color={card.identity.projectColor}
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-10 h-1',
            PALETTE_DOT_CLASS[card.identity.projectColor],
          )}
        />
      )}
      <CardHead
        card={card}
        open
        onClose={onClose}
        onOpenInChats={onOpenInChats}
        onMove={onMove}
      />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {chat}
      </div>
      {flash === null ? null : (
        <span
          key={flash}
          aria-hidden
          data-slot="thread-canvas-card-flash"
          className="cc-flash pointer-events-none absolute inset-0 z-10 rounded-card"
        />
      )}
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          aria-hidden
          data-slot="thread-canvas-card-resize"
          data-edge={edge}
          title={edge === 'se' ? 'Drag to resize' : undefined}
          className={resizeVariants({ edge })}
          onPointerDown={(event) => begin(event, edge)}
          onPointerMove={follow}
          onPointerUp={release}
          onPointerCancel={release}>
          {edge === 'se' ? <ResizeGrip /> : null}
        </div>
      ))}
    </section>
  );
}

export interface ThreadCardLayerProps {
  cards: readonly CanvasCard[];
  /** Where each open thread's slot stands in the flow, by run id. */
  slots: ReadonlyMap<string, PlacedBox>;
  /** The graph pane's size, which caps a card's. */
  pane: { width: number; height: number };
  /** The card to flash, a new `seq` each time it is shown. */
  flashing: { runId: string; seq: number } | null;
  onClose: (runId: string) => void;
  onResize: (runId: string, size: CardSize) => void;
  /** The card was dragged by its head so its slot's top-left stands at `to` in the flow; `done` on the drop. */
  onMove: (runId: string, to: { x: number; y: number }, done: boolean) => void;
  onOpenInChats: (runId: string) => void;
  renderChat: (runId: string) => React.ReactNode;
  /** Draw the cards not opened from the manager's window over it rather than under it. */
  inFront?: boolean;
  /** A press landed in a card not opened from the manager's window. */
  onActivate?: () => void;
}

/**
 * The open threads' cards, drawn over the canvas beside the flow rather than
 * in it, each on its slot's top-left corner and scaled with the flow's zoom by
 * CSS `zoom`, so a card covers exactly its slot at every zoom. A transform
 * would capture the fixed menus and dialogs inside the chat; `zoom` does not,
 * and those overlays undo it themselves. One subscription to the flow's
 * transform moves and scales them, so a pan or a zoom never draws a card's
 * chat again.
 */
export function ThreadCardLayer({
  cards,
  slots,
  pane,
  flashing,
  onClose,
  onResize,
  onMove,
  onOpenInChats,
  renderChat,
  inFront = false,
  onActivate,
}: ThreadCardLayerProps): React.JSX.Element | null {
  const store = useStoreApi();
  const moving = useRef(new Map<string, { x: number; y: number }>());
  const wrappers = useRef(new Map<string, HTMLDivElement>());
  const scalers = useRef(new Map<string, HTMLDivElement>());
  const placed = useRef(slots);
  placed.current = slots;
  const [front, setFront] = useState<string | null>(null);
  const zoomOf = useLatestCallback(
    (): number => store.getState().transform[2],
    [store],
  );

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitZoom = useLatestCallback((): void => {
    settleTimer.current = null;
    const zoom = store.getState().transform[2];
    for (const scaler of scalers.current.values()) {
      scaler.style.transform = '';
      if (scaler.style.zoom !== String(zoom)) {
        scaler.style.zoom = String(zoom);
      }
    }
  }, [store]);
  const place = useLatestCallback(
    (gesture: boolean): void => {
      const [x, y, zoom] = store.getState().transform;
      let deferred = false;
      for (const [runId, wrapper] of wrappers.current) {
        const slot = placed.current.get(runId);
        if (slot === undefined) {
          continue;
        }
        wrapper.style.left = `${slot.x * zoom + x}px`;
        wrapper.style.top = `${slot.y * zoom + y}px`;
        const scaler = scalers.current.get(runId);
        if (scaler === undefined) {
          continue;
        }
        const committed = Number(scaler.style.zoom || 1);
        if (!gesture || scaler.style.zoom === '') {
          scaler.style.transform = '';
          scaler.style.zoom = String(zoom);
        } else {
          scaler.style.transform =
            committed === zoom ? '' : `scale(${zoom / committed})`;
          deferred ||= committed !== zoom;
        }
      }
      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
      if (deferred) {
        settleTimer.current = setTimeout(commitZoom, ZOOM_SETTLE_MS);
      }
    },
    [store],
  );
  useLayoutEffect(() => place(settleTimer.current !== null));
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.transform !== previous.transform) {
          place(
            state.transform[2] !== previous.transform[2] ||
              settleTimer.current !== null,
          );
        }
      }),
    [store, place],
  );
  useEffect(
    () => () => {
      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
      }
    },
    [],
  );

  const move = (runId: string, by: CardMove, done: boolean): void => {
    const origin = moving.current.get(runId) ?? placed.current.get(runId);
    if (origin === undefined) {
      return;
    }
    const zoom = store.getState().transform[2];
    const to = { x: origin.x + by.dx / zoom, y: origin.y + by.dy / zoom };
    if (done) {
      moving.current.delete(runId);
    } else if (!moving.current.has(runId)) {
      moving.current.set(runId, { x: origin.x, y: origin.y });
    }
    onMove(runId, to, done);
  };

  for (const runId of moving.current.keys()) {
    if (!slots.has(runId)) {
      moving.current.delete(runId);
    }
  }
  const shown = cards.filter((card) => slots.has(card.runId));
  if (shown.length === 0) {
    return null;
  }
  const largest = largestCard(pane);
  return (
    <div
      data-slot="command-center-cards"
      className="pointer-events-none absolute inset-0 overflow-hidden">
      {shown.map((card) => (
        <div
          key={card.runId}
          ref={(element) => {
            if (element === null) {
              wrappers.current.delete(card.runId);
            } else {
              wrappers.current.set(card.runId, element);
            }
          }}
          data-slot="thread-canvas-card-place"
          data-over-window={card.aboveWindow || inFront || undefined}
          className="absolute"
          style={{
            zIndex:
              (card.aboveWindow || inFront
                ? CARD_OVER_WINDOW_Z
                : CARD_UNDER_WINDOW_Z) + (front === card.runId ? 1 : 0),
          }}
          onPointerDownCapture={() => {
            setFront(card.runId);
            if (!card.aboveWindow) {
              onActivate?.();
            }
          }}>
          <div
            data-slot="thread-canvas-card-zoom"
            className="origin-top-left"
            ref={(element) => {
              if (element === null) {
                scalers.current.delete(card.runId);
              } else {
                scalers.current.set(card.runId, element);
              }
            }}>
            <CanvasThreadCard
              card={card}
              largest={largest}
              zoomOf={zoomOf}
              flash={flashing?.runId === card.runId ? flashing.seq : null}
              onClose={() => onClose(card.runId)}
              onResize={(size) => onResize(card.runId, size)}
              onMove={(by, done) => move(card.runId, by, done)}
              onOpenInChats={() => onOpenInChats(card.runId)}
              chat={renderChat(card.runId)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The open thread on a phone: the whole page, its head on top with a way back
 * to the column, which the platform's own back gesture also takes.
 */
export function PhoneThreadCard({
  card,
  active,
  onClose,
  onOpenInChats,
  chat,
}: {
  card: CanvasCard;
  active: boolean;
  onClose: () => void;
  onOpenInChats: () => void;
  chat: React.ReactNode;
}): React.JSX.Element {
  const back = usePhoneBackEntry('command-center-card', active, onClose);
  return (
    <section
      aria-label={`${card.identity.title}, its chat`}
      data-slot="thread-phone-card"
      data-run-id={card.runId}
      className="absolute inset-0 z-20 flex flex-col bg-card">
      <CardHead
        card={card}
        open={false}
        onClose={onClose}
        onOpenInChats={onOpenInChats}
        leading={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="thread-phone-card-back"
            className="-ml-1.5 size-8 shrink-0"
            aria-label="Back to the threads"
            title="Back"
            onClick={back}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {chat}
      </div>
    </section>
  );
}
