import { type RefObject, useCallback, useEffect, useState } from 'react';

import { jumpToBottom } from '../scroll-to-bottom';
import { isScrolledToBottom } from './scroll-follow';

/**
 * How long the row a search jump landed on stays marked.
 *
 * Long enough to find on a screen the reader has just been moved across, short
 * enough that it is gone before they start reading around it — at which point
 * it is decoration on an arbitrary row.
 */
const JUMP_MARK_MS = 2_500;

/** How far above the viewport's top edge a revealed row is parked. */
const JUMP_MARGIN_PX = 24;

/**
 * How many frames a landing keeps re-aiming while the rows above it settle.
 *
 * ONE alignment is only correct if every row above the target has already
 * reached its final height, and after `loadAround` fetches an older window that
 * is not true: a transcript page is markdown, diffs, fenced code and tool
 * groups, and their boxes grow over the frames after the commit. Everything
 * that grows ABOVE the target pushes it down by exactly that much, and nothing
 * corrects it — the tail-follow is deliberately off by then.
 *
 * REPORTED as "он скроллит меня в какое-то непонятное место, но не к этому
 * сообщению", and measured in the running app on a 30k-row conversation: the
 * jump marked the right row (seq 30444) and parked it **28,877px** below the
 * top of the viewport, unmoved two seconds later.
 *
 * Bounded on both sides. It stops the moment the row is within
 * {@link JUMP_SETTLE_TOLERANCE_PX}, so a landing that was right the first time
 * costs one extra measurement; and it gives up after this many frames whatever
 * happens, so a transcript that never stops growing cannot hold the scroller
 * hostage. ~10 frames is about 160ms — inside the same gesture, which is what
 * keeps this from fighting a reader who has started scrolling.
 */
const JUMP_SETTLE_FRAMES = 10;

/**
 * How close is close enough to stop re-aiming.
 *
 * A few pixels of drift is invisible and re-aiming for it would spend the whole
 * frame budget on rounding.
 */
const JUMP_SETTLE_TOLERANCE_PX = 4;

/**
 * The anchor a jump to `seq` should land on: the last one whose own start is
 * not past it.
 *
 * A transcript entry SPANS a range of rows — a turn block, a sub-agent block, a
 * tool group — and only its first row carries an anchor, so a hit is routinely
 * inside an entry rather than at one. The entry that ENCLOSES it is the right
 * landing place.
 *
 * Every anchor is scanned and the closest-at-or-below by VALUE wins. Stopping
 * at the first anchor past the hit would assume document order rises with seq,
 * and it does not: a sub-agent block is placed where its delegate was LAUNCHED
 * but starts at the first row the delegate wrote, so the entry drawn after it
 * can begin earlier. `transcript-groups.spec.ts` pins that the order really is
 * non-monotonic. The list is one window of entries, so scanning all of it costs
 * nothing.
 *
 * A hit BELOW the oldest loaded row still has somewhere to go: the top of what
 * is held. That is the honest landing place while the older page is still being
 * fetched, and it beats not moving at all.
 */
export function pickJumpAnchor(
  anchors: Iterable<HTMLElement>,
  seq: number,
): HTMLElement | null {
  let target: HTMLElement | null = null;
  let best = Number.NEGATIVE_INFINITY;
  let first: HTMLElement | null = null;
  for (const anchor of anchors) {
    first ??= anchor;
    const at = Number(anchor.dataset.transcriptSeq);
    if (Number.isFinite(at) && at <= seq && at >= best) {
      best = at;
      target = anchor;
    }
  }
  return target ?? first;
}

export interface TranscriptJumpOptions {
  /** The loaded window, oldest first — read for its `seq` bounds alone. */
  items: readonly { readonly seq: number }[];
  /**
   * The sentinel at the transcript's end. Its PARENT is the scroller, which is
   * how every other reader here reaches it.
   */
  endRef: RefObject<HTMLElement | null>;
  /** The transcript's tail-follow, which a jump switches off. */
  followingRef: RefObject<boolean>;
  /** Tells the transcript whether "Latest" is worth drawing. */
  setAboveTail: (above: boolean) => void;
  /** Fetch the window around a row outside the one on screen. */
  loadAround: (seq: number) => Promise<boolean>;
  /** Fetch the newest page back, re-arming live rows. */
  returnToTail: () => Promise<boolean>;
}

export interface TranscriptJump {
  /** The row a jump landed on, marked so the reader can see which one it is. */
  markedSeq: number | null;
  /** Take the reader to a row anywhere in the conversation. */
  jumpToSeq: (seq: number) => void;
  /** Scroll to the bottom of the window on screen. */
  jumpToLatest: () => void;
  /** Fetch the newest page back, THEN scroll to it. */
  backToTail: () => void;
}

/**
 * Taking the reader to a row — the state machine behind a search hit, the
 * "Latest" control, and the mark that says where a jump landed.
 *
 * Its own module beside `use-chat-search.ts`, which is the sibling half of the
 * same feature: the search finds a `seq`, this is everything that happens next.
 * Extracting it also makes {@link pickJumpAnchor} — the one decision here with
 * a wrong answer available — testable without mounting the chat screen.
 *
 * It does NOT own the transcript's scroll state: `followingRef` and
 * `setAboveTail` belong to the follow machinery in `Chats.tsx` and are passed
 * in. A second copy of "is the reader at the bottom" is how the Latest control
 * and the transcript come to disagree.
 */
export function useTranscriptJump({
  items,
  endRef,
  followingRef,
  setAboveTail,
  loadAround,
  returnToTail,
}: TranscriptJumpOptions): TranscriptJump {
  /**
   * Scroll to the entry holding `seq`, and answer WHICH anchor it landed on so
   * the caller can mark that row — null when there was nowhere to go at all.
   *
   * `:not(:empty)` skips the anchors of entries that rendered nothing — they
   * have no box, so scrolling to one lands nowhere. It is the same condition
   * their `empty:hidden` uses, deliberately.
   *
   * The arithmetic is `revealWorkflow`'s, for its reasons: `scrollTop` on the
   * scroller itself, never `scrollIntoView`, and the tail-follow switched off
   * so a running turn's next token does not drag the reader back down.
   */
  const revealSeq = useCallback(
    (seq: number): number | null => {
      const scroller = endRef.current?.parentElement;
      if (!scroller) {
        return null;
      }
      const target = pickJumpAnchor(
        scroller.querySelectorAll<HTMLElement>(
          '[data-transcript-seq]:not(:empty)',
        ),
        seq,
      );
      if (!target) {
        return null;
      }
      followingRef.current = false;
      /** How far the target still is from where it should be parked. */
      const drift = (): number =>
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        JUMP_MARGIN_PX;
      scroller.scrollTop += drift();
      setAboveTail(!isScrolledToBottom(scroller));
      // Then RE-AIM for a few frames, because one alignment is only correct if
      // the rows above the target have finished growing — see
      // {@link JUMP_SETTLE_FRAMES}. Each pass re-measures rather than replaying
      // the first delta: what moved is the content, so the old number is
      // exactly the wrong correction.
      let frames = 0;
      const settle = (): void => {
        // The window can be replaced under us — a reopened chat, another jump —
        // and a detached node reports a zero rect, which would scroll the
        // reader to the top for no reason.
        if (!target.isConnected || !scroller.isConnected) {
          return;
        }
        const off = drift();
        if (Math.abs(off) > JUMP_SETTLE_TOLERANCE_PX) {
          scroller.scrollTop += off;
          setAboveTail(!isScrolledToBottom(scroller));
        }
        frames += 1;
        if (frames < JUMP_SETTLE_FRAMES) {
          requestAnimationFrame(settle);
        }
      };
      requestAnimationFrame(settle);
      return Number(target.dataset.transcriptSeq);
    },
    [endRef, followingRef, setAboveTail],
  );

  /**
   * The row a search hit named, waiting for the commit that can show it.
   *
   * A jump cannot scroll in the same tick it asks for a window: `loadAround`
   * sets state, and the rows it fetched are not in the DOM until React has
   * committed them. So the seq is PARKED and an effect reveals it on the next
   * commit — which also covers the case where the row was already loaded, since
   * setting this is itself a commit.
   */
  const [pendingSeq, setPendingSeq] = useState<number | null>(null);

  /**
   * The row a jump LANDED on, marked so the reader can see which one it is.
   *
   * A mark on the row rather than the matched WORDS, and the difference is what
   * it can cover: a message renders as markdown, which is most of what a search
   * finds, and wrapping highlight markup around markdown source corrupts it —
   * so word-level marking would have to skip exactly the commonest hit. The
   * landing place is a fact about every kind, cards and blocks included.
   *
   * A LANDING is also more than a match: the anchor is nearest-at-or-below, so
   * on a folded turn the row marked is the block that holds the hit, which is
   * the honest thing to point at.
   */
  const [markedSeq, setMarkedSeq] = useState<number | null>(null);

  useEffect(() => {
    if (pendingSeq === null) {
      return;
    }
    setMarkedSeq(revealSeq(pendingSeq));
    // Cleared whether or not it found an anchor: a second attempt would need a
    // reason to believe the next commit is different, and there is none — the
    // window it asked for has arrived by now.
    setPendingSeq(null);
  }, [items, pendingSeq, revealSeq]);

  useEffect(() => {
    if (markedSeq === null) {
      return;
    }
    // It fades on a timer rather than on the next scroll or click: the reader
    // arrives, looks, and reads on — and a mark that vanished the moment they
    // touched the wheel would be gone before they had found it.
    const timer = setTimeout(() => setMarkedSeq(null), JUMP_MARK_MS);
    return () => clearTimeout(timer);
  }, [markedSeq]);

  /**
   * Take the reader to a row anywhere in the conversation, fetching the window
   * around it first when it is outside the one on screen.
   *
   * This is the half of transcript search that makes it worth having. The
   * daemon searches the whole run precisely so it can answer about rows the
   * client never loaded — a chat holds at most `HISTORY_PAGE` items — so
   * without the fetch a hit older than that is a row that highlights nothing,
   * scrolls nowhere and reports no error.
   */
  const jumpToSeq = useCallback(
    (seq: number): void => {
      const loaded =
        items.length > 0 &&
        seq >= items[0]!.seq &&
        seq <= items[items.length - 1]!.seq;
      if (loaded) {
        setPendingSeq(seq);
        return;
      }
      void loadAround(seq).then((ok) => {
        if (ok) {
          setPendingSeq(seq);
        }
      });
    },
    [items, loadAround],
  );

  const jumpToLatest = useCallback((): void => {
    const scroller = endRef.current?.parentElement;
    if (!scroller) {
      return;
    }
    followingRef.current = true;
    setAboveTail(false);
    jumpToBottom(scroller);
  }, [endRef, followingRef, setAboveTail]);

  /**
   * What "Latest" means once a jump has taken the reader OFF the tail.
   *
   * Scrolling alone cannot answer it there: the window on screen is a page from
   * the middle of the conversation, so its bottom is not the newest message and
   * live rows have been suppressed since the jump ({@link useChatRun}'s
   * `awayFromTail`). The newest page has to be fetched back before there is a
   * tail to scroll to — and only then is the follow re-armed, since a fetch that
   * failed leaves the reader exactly where they were rather than at a bottom
   * that is not the bottom.
   */
  const backToTail = useCallback((): void => {
    void returnToTail().then((ok) => {
      if (ok) {
        jumpToLatest();
      }
    });
  }, [returnToTail, jumpToLatest]);

  return { markedSeq, jumpToSeq, jumpToLatest, backToTail };
}
