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

import { ThreadHead, type ThreadIdentity } from '../components/thread-head';
import type { ThreadAttention } from '../components/thread-labels';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { usePhoneBackEntry } from '../components/use-phone-back-entry';
import type { PlacedBox } from './graph-layout';
import { type CardSize, MIN_CARD_SIZE } from './open-cards';
import { OpenInChatsIcon, ShowChatIcon } from './thread-card';

/** The card's head above its chat, in pixels: the thread head and its padding. */
export const CARD_HEAD_HEIGHT = 66;

/** The room a card leaves the graph pane's edges when it is as big as it may get. */
const PANE_INSET = 16;

/** A thread open as a card on the canvas. */
export interface CanvasCard {
  runId: string;
  identity: ThreadIdentity;
  attention: ThreadAttention;
  size: CardSize;
}

type ResizeEdge = 's' | 'se';

interface Gesture {
  pointerId: number;
  edge: ResizeEdge;
  startX: number;
  startY: number;
  origin: CardSize;
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

/** The size a drag from the card's bottom edge or its corner leaves it at. */
export function resizeCard(
  origin: CardSize,
  edge: ResizeEdge,
  delta: { dx: number; dy: number },
  largest: CardSize,
): CardSize {
  return clampCard(
    {
      width: edge === 'se' ? origin.width + delta.dx : origin.width,
      height: origin.height + delta.dy,
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
      } satisfies Record<ThreadAttention, string>,
    },
  },
);

const resizeVariants = cva('absolute z-10 touch-none select-none', {
  variants: {
    edge: {
      s: 'inset-x-4 bottom-0 h-1.5 cursor-ns-resize',
      se: 'right-0 bottom-0 size-3.5 cursor-nwse-resize',
    } satisfies Record<ResizeEdge, string>,
  },
});

function CardHead({
  card,
  open,
  onClose,
  onOpenInChats,
  leading,
}: {
  card: CanvasCard;
  open: boolean;
  onClose: () => void;
  onOpenInChats: () => void;
  leading?: React.ReactNode;
}): React.JSX.Element {
  const title = card.identity.title;
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2.5"
      style={{ height: CARD_HEAD_HEIGHT }}>
      {leading}
      <div className="min-w-0 flex-1">
        <ThreadHead
          slot="thread-canvas-card"
          identity={card.identity}
          aside={
            <>
              {open ? (
                <ShowChatIcon title={title} open onToggle={onClose} />
              ) : null}
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
  flashing,
  onClose,
  onResize,
  onOpenInChats,
  chat,
}: {
  card: CanvasCard;
  largest: CardSize;
  flashing: boolean;
  onClose: () => void;
  onResize: (size: CardSize) => void;
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
    setDraft(
      resizeCard(
        active.origin,
        active.edge,
        {
          dx: event.clientX - active.startX,
          dy: event.clientY - active.startY,
        },
        largest,
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
      className={cn(
        cardVariants({ attention: card.attention }),
        flashing && 'cc-flash',
      )}
      style={{ width: size.width, height: CARD_HEAD_HEIGHT + size.height }}>
      <CardHead
        card={card}
        open
        onClose={onClose}
        onOpenInChats={onOpenInChats}
      />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {chat}
      </div>
      {(['s', 'se'] as const).map((edge) => (
        <div
          key={edge}
          aria-hidden
          data-slot="thread-canvas-card-resize"
          data-edge={edge}
          className={resizeVariants({ edge })}
          onPointerDown={(event) => begin(event, edge)}
          onPointerMove={follow}
          onPointerUp={release}
          onPointerCancel={release}
        />
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
  flashing: string | null;
  onClose: (runId: string) => void;
  onResize: (runId: string, size: CardSize) => void;
  onOpenInChats: (runId: string) => void;
  renderChat: (runId: string) => React.ReactNode;
}

/**
 * The open threads' cards, drawn over the canvas beside the flow rather than
 * in it, each on its slot's top-left corner at its own pixel size at every
 * zoom. One subscription to the flow's transform moves them, so a pan or a
 * zoom never draws a card's chat again.
 */
export function ThreadCardLayer({
  cards,
  slots,
  pane,
  flashing,
  onClose,
  onResize,
  onOpenInChats,
  renderChat,
}: ThreadCardLayerProps): React.JSX.Element | null {
  const store = useStoreApi();
  const wrappers = useRef(new Map<string, HTMLDivElement>());
  const placed = useRef(slots);
  placed.current = slots;
  const [front, setFront] = useState<string | null>(null);

  const place = useLatestCallback((): void => {
    const [x, y, zoom] = store.getState().transform;
    for (const [runId, wrapper] of wrappers.current) {
      const slot = placed.current.get(runId);
      if (slot === undefined) {
        continue;
      }
      wrapper.style.left = `${slot.x * zoom + x}px`;
      wrapper.style.top = `${slot.y * zoom + y}px`;
    }
  }, [store]);
  useLayoutEffect(() => place());
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.transform !== previous.transform) {
          place();
        }
      }),
    [store, place],
  );

  const shown = cards.filter((card) => slots.has(card.runId));
  if (shown.length === 0) {
    return null;
  }
  const largest = largestCard(pane);
  return (
    <div
      data-slot="command-center-cards"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
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
          className="absolute"
          style={{ zIndex: front === card.runId ? 2 : 1 }}
          onPointerDownCapture={() => setFront(card.runId)}>
          <CanvasThreadCard
            card={card}
            largest={largest}
            flashing={flashing === card.runId}
            onClose={() => onClose(card.runId)}
            onResize={(size) => onResize(card.runId, size)}
            onOpenInChats={() => onOpenInChats(card.runId)}
            chat={renderChat(card.runId)}
          />
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
