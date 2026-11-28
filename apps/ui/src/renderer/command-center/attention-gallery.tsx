import { ChevronLeft, ChevronRight, CircleCheck } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../components/ui/utils';
import {
  type AttentionCard,
  type AttentionCounts,
  attentionSplitText,
} from './use-attention-cards';

/** How far a mouse drag must travel before it moves to the next card. */
export const DRAG_STEP_PX = 40;

/** How far the mouse must move while held before a press becomes a drag, so a plain click still reaches what it pressed. */
const DRAG_SLOP_PX = 4;

/**
 * Where the card that takes a gone card's place sits in `now`: the first card
 * that followed it in `before` and is still here, else the nearest one before
 * it, so a card that arrives meanwhile never takes the place.
 */
export function takingPlaceOf(
  gone: string | null,
  before: readonly string[],
  now: readonly string[],
): number {
  const at = gone === null ? -1 : before.indexOf(gone);
  if (at < 0) {
    return 0;
  }
  const here = new Map(now.map((key, index) => [key, index]));
  for (const key of [
    ...before.slice(at + 1),
    ...before.slice(0, at).reverse(),
  ]) {
    const index = here.get(key);
    if (index !== undefined) {
      return index;
    }
  }
  return Math.min(at, now.length - 1);
}

const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [contenteditable="true"], [role="button"], [role="textbox"]';

/** A picture's own button: it opens on a click, and a drag that starts on it still moves the gallery. */
const PICTURE = '[data-slot="zoomable-image"]';

function dragsFrom(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  return (
    target.closest(INTERACTIVE) === null || target.closest(PICTURE) !== null
  );
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface AttentionGalleryProps {
  open: boolean;
  onClose: () => void;
  cards: readonly AttentionCard[];
  counts: AttentionCounts;
  /** Full screen, where Back closes it. */
  phone: boolean;
  /** Why the last answer or Dismiss did not land, or null. */
  error?: string | null;
  renderCard: (card: AttentionCard) => React.ReactNode;
}

/**
 * Everything that waits on the user, one large card at a time in a horizontal
 * track: ← / →, the arrow keys, a mouse drag and a finger swipe each move one
 * card, and moving never changes a card. A card that arrives keeps the card in
 * view where it is; a card whose thing is done leaves, and the next takes its
 * place. Every open starts on the first card; the card in view is held only
 * while it is open.
 */
export function AttentionGallery({
  open,
  onClose,
  cards,
  counts,
  phone,
  error = null,
  renderCard,
}: AttentionGalleryProps): React.JSX.Element | null {
  const regionRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [openedAs, setOpenedAs] = useState(open);
  const seenKeys = useRef<readonly string[]>([]);
  if (openedAs !== open) {
    setOpenedAs(open);
    setCurrentKey(null);
    seenKeys.current = [];
  }
  const keys = cards.map((card) => card.key);
  const found = currentKey === null ? -1 : keys.indexOf(currentKey);
  const index =
    cards.length === 0
      ? -1
      : found >= 0
        ? found
        : takingPlaceOf(currentKey, seenKeys.current, keys);
  const shownKey = index < 0 ? null : (keys[index] ?? null);
  if (found >= 0) {
    seenKeys.current = keys;
  }

  useEffect(() => {
    if (open && shownKey !== currentKey) {
      setCurrentKey(shownKey);
    }
  }, [open, shownKey, currentKey]);

  const slideOf = (key: string | null): HTMLElement | null =>
    key === null
      ? null
      : ([
          ...(trackRef.current?.querySelectorAll<HTMLElement>(
            '[data-card-key]',
          ) ?? []),
        ].find((slide) => slide.dataset.cardKey === key) ?? null);

  const bring = (key: string | null, smooth: boolean): void => {
    const track = trackRef.current;
    const slide = slideOf(key);
    if (track === null || slide === null) {
      return;
    }
    const left = slide.offsetLeft - (track.clientWidth - slide.clientWidth) / 2;
    if (typeof track.scrollTo === 'function') {
      track.scrollTo({
        left,
        behavior: smooth && !reducedMotion() ? 'smooth' : 'auto',
      });
    } else {
      track.scrollLeft = left;
    }
  };

  const keysKey = keys.join('\n');
  useLayoutEffect(() => {
    if (open) {
      bring(shownKey, false);
    }
    // Re-centred whenever the cards change, so an arrival never moves the card in view.
  }, [open, keysKey, shownKey]);

  const keepFocus = (next: number): void => {
    const region = regionRef.current;
    const active = document.activeElement;
    if (
      region === null ||
      !(active instanceof HTMLElement) ||
      active === region ||
      !region.contains(active)
    ) {
      return;
    }
    const slot = active.dataset.slot;
    const lost =
      (next !== index && active.closest('[data-card-key]') !== null) ||
      (slot === 'attention-gallery-prev' && next <= 0) ||
      (slot === 'attention-gallery-next' && next >= cards.length - 1);
    if (lost) {
      region.focus({ preventScroll: true });
    }
  };

  const go = (step: number): void => {
    if (index < 0) {
      return;
    }
    const next = Math.max(0, Math.min(cards.length - 1, index + step));
    keepFocus(next);
    const key = keys[next] ?? null;
    setCurrentKey(key);
    bring(key, true);
  };

  const scrollEnd = useRef<number | null>(null);
  const onScroll = (): void => {
    if (scrollEnd.current !== null) {
      window.clearTimeout(scrollEnd.current);
    }
    scrollEnd.current = window.setTimeout(() => {
      scrollEnd.current = null;
      const track = trackRef.current;
      if (track === null || drag.current !== null) {
        return;
      }
      const middle = track.scrollLeft + track.clientWidth / 2;
      let nearest: string | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const slide of track.querySelectorAll<HTMLElement>(
        '[data-card-key]',
      )) {
        const centre = slide.offsetLeft + slide.clientWidth / 2;
        if (Math.abs(centre - middle) < distance) {
          distance = Math.abs(centre - middle);
          nearest = slide.dataset.cardKey ?? null;
        }
      }
      if (nearest !== null && nearest !== currentKey) {
        setCurrentKey(nearest);
      }
    }, 120);
  };
  useEffect(
    () => () => {
      if (scrollEnd.current !== null) {
        window.clearTimeout(scrollEnd.current);
      }
    },
    [],
  );

  const drag = useRef<{
    x: number;
    left: number;
    id: number;
    moving: boolean;
  } | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    if (
      event.pointerType !== 'mouse' ||
      event.button !== 0 ||
      track === null ||
      !dragsFrom(event.target)
    ) {
      return;
    }
    drag.current = {
      x: event.clientX,
      left: track.scrollLeft,
      id: event.pointerId,
      moving: false,
    };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current;
    const track = trackRef.current;
    if (held === null || track === null || held.id !== event.pointerId) {
      return;
    }
    const moved = event.clientX - held.x;
    if (!held.moving) {
      if (Math.abs(moved) < DRAG_SLOP_PX) {
        return;
      }
      held.moving = true;
      track.style.scrollSnapType = 'none';
      track.setPointerCapture?.(event.pointerId);
    }
    track.scrollLeft = held.left - moved;
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current;
    const track = trackRef.current;
    if (held === null || held.id !== event.pointerId) {
      return;
    }
    drag.current = null;
    if (!held.moving) {
      return;
    }
    if (track !== null) {
      track.style.scrollSnapType = '';
      track.releasePointerCapture?.(event.pointerId);
    }
    dragged.current = true;
    window.setTimeout(() => {
      dragged.current = false;
    }, 0);
    const moved = event.clientX - held.x;
    go(Math.abs(moved) < DRAG_STEP_PX ? 0 : moved < 0 ? 1 : -1);
  };
  const onClickCapture = (event: React.MouseEvent): void => {
    if (dragged.current) {
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onDragStart = (event: React.DragEvent): void => {
    if (event.target instanceof HTMLImageElement) {
      event.preventDefault();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      typingIn(event.target)
    ) {
      return;
    }
    event.preventDefault();
    go(event.key === 'ArrowRight' ? 1 : -1);
  };

  const split = attentionSplitText(counts);
  const position =
    cards.length === 0 ? 'Nothing waiting' : `${index + 1} of ${cards.length}`;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={phone}
      flush
      className={cn(
        'flex flex-col',
        phone
          ? 'h-full'
          : 'h-[min(760px,calc(100vh-4rem))] w-[min(920px,calc(100vw-4rem))] max-w-none',
      )}
      title={
        <span
          data-slot="attention-gallery-title"
          className="flex min-w-0 items-baseline gap-2">
          <span>Needs you</span>
          {cards.length === 0 ? null : (
            <span
              data-slot="attention-gallery-counter"
              aria-live="polite"
              className="text-sm font-normal text-muted-foreground tabular-nums">
              {position}
            </span>
          )}
        </span>
      }>
      <div
        ref={regionRef}
        tabIndex={-1}
        data-slot="attention-gallery"
        role="region"
        aria-roledescription="carousel"
        aria-label="Cards waiting on you"
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-3 pb-4 outline-none">
        {split === '' ? null : (
          <p
            data-slot="attention-gallery-split"
            className="m-0 px-5 text-xs text-muted-foreground">
            {split}
          </p>
        )}
        {error === null ? null : (
          <ErrorText className="mx-5 rounded-md bg-destructive/10 px-3 py-2 text-sm">
            {error}
          </ErrorText>
        )}
        {cards.length === 0 ? (
          <EmptyState
            data-slot="attention-gallery-empty"
            className="m-auto"
            icon={<CircleCheck />}>
            All caught up
          </EmptyState>
        ) : (
          <>
            <div
              ref={trackRef}
              data-slot="attention-gallery-track"
              onScroll={onScroll}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClickCapture={onClickCapture}
              onDragStart={onDragStart}
              className="flex min-h-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden px-[max(1rem,calc((100%-36rem)/2))] [scrollbar-width:none]">
              {cards.map((card, at) => (
                <div
                  key={card.key}
                  data-slot="attention-card"
                  data-kind={card.kind}
                  data-card-key={card.key}
                  aria-roledescription="slide"
                  aria-label={`${at + 1} of ${cards.length}`}
                  aria-current={at === index ? 'true' : undefined}
                  inert={at !== index}
                  className={cn(
                    'flex w-[min(36rem,calc(100%-2rem))] shrink-0 snap-center snap-always flex-col overflow-y-auto rounded-xl py-1 transition-opacity motion-reduce:transition-none',
                    at === index ? 'opacity-100' : 'opacity-50',
                  )}>
                  {renderCard(card)}
                </div>
              ))}
            </div>
            <div className="flex shrink-0 items-center justify-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="icon"
                data-slot="attention-gallery-prev"
                aria-label="Previous card"
                title="Previous card (←)"
                disabled={index <= 0}
                onClick={() => go(-1)}>
                <ChevronLeft aria-hidden="true" className="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                data-slot="attention-gallery-next"
                aria-label="Next card"
                title="Next card (→)"
                disabled={index >= cards.length - 1}
                onClick={() => go(1)}>
                <ChevronRight aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
