import {
  createContext,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useLatestCallback } from '../components/use-latest-callback';
import { jumpToBottom } from '../scroll-to-bottom';
import { isScrolledToBottom } from './scroll-follow';
import { writeThreadFlag } from './thread-ui-memory';

/**
 * How long the row a search jump landed on stays marked.
 *
 * Long enough to find on a screen the reader has just been moved across, short
 * enough that it is gone before they start reading around it — at which point
 * it is decoration on an arbitrary row.
 */
export const JUMP_MARK_MS = 2_500;

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
 * Among anchors at the same seq — a turn and its first row, a card and its
 * first row — the LAST in document order wins, which is the innermost: the
 * landing is the row itself, not everything around it.
 *
 * A hit BELOW the oldest loaded row still has somewhere to go: the top of what
 * is held. That is the honest landing place while the older page is still being
 * fetched, and it beats not moving at all.
 */
export function pickJumpAnchor(
  anchors: Iterable<HTMLElement>,
  seq: number,
): HTMLElement | null {
  // The row itself first — an anchor at the hit's seq, or one that also draws
  // it (a tool row its result) — the innermost of them. Only without one is
  // the hit inside an entry, and the nearest start below it the place.
  const list = [...anchors];
  let exact: HTMLElement | null = null;
  for (const anchor of list) {
    if (anchorSeq(anchor) === seq || Number(anchor.dataset.seqAlso) === seq) {
      exact = anchor;
    }
  }
  if (exact !== null) {
    return exact;
  }
  let target: HTMLElement | null = null;
  let best = Number.NEGATIVE_INFINITY;
  let first: HTMLElement | null = null;
  for (const anchor of list) {
    first ??= anchor;
    const at = anchorSeq(anchor);
    if (Number.isFinite(at) && at <= seq && at >= best) {
      best = at;
      target = anchor;
    }
  }
  return target ?? first;
}

/**
 * Where a jump landed, for the rows that mark themselves — every anchor drawn
 * below the transcript (a turn's rows, a card's rows, a tool row).
 */
export const JumpMarkContext = createContext<JumpMark | null>(null);

/**
 * Where a jump landed: the row's seq, the card it landed in (null for the run's
 * own flow), and the `data-jump-key` of the one anchor it landed on — what a
 * row matches to mark itself, since a turn and its first row, or a card and its
 * first row, share a seq.
 */
export interface JumpMark {
  seq: number;
  cardId: string | null;
  key: string;
}

/** A landing on its way: the row, the card it is in, and whether its folds are open. */
interface Landing {
  seq: number;
  cardId: string | null;
  unfolded: boolean;
}

/**
 * How a jump reaches a row a run's own window never holds — one filed under a
 * call, drawn inside that call's card (a workflow run's transcript is read one
 * conversation at a time).
 */
export interface CallJumps {
  /** Which call the row at `seq` is filed under; null for the run's own flow. */
  locate: (seq: number) => Promise<string | null>;
  /**
   * The cards to open to reach the one that draws `callId` — outermost first,
   * that card last — each with the conversation it pages; empty when the
   * window holds none.
   */
  cardsOf: (callId: string) => readonly { id: string; conversation: string }[];
  /** Where `callId` starts in the run's own flow — what pages the window to its card. */
  startOf: (callId: string) => number | null;
  /** Open a card, as the reader's own press would. */
  openCard: (cardId: string) => void;
  /** Read a card's conversation back far enough to hold `seq`. */
  loadThrough: (conversation: string, seq: number) => Promise<boolean>;
}

/** A jump into a call, mid-way: the window is being paged to its card, or the card read. */
interface PendingCallJump {
  seq: number;
  callId: string;
  /** The window was paged to the call's start once already. */
  pagedToStart: boolean;
  /** A read is in flight; the next commit has nothing new to act on. */
  waiting: boolean;
}

/**
 * The seq an anchor carries: a transcript entry's (`data-transcript-seq`), a
 * row of a turn block's (`data-row-seq`) or of a call card's (`data-call-seq`).
 */
function anchorSeq(anchor: HTMLElement): number {
  return Number(
    anchor.dataset.transcriptSeq ??
      anchor.dataset.rowSeq ??
      anchor.dataset.callSeq,
  );
}

/** What a jump can land on — every anchor a row is drawn with. */
const ANCHORS =
  '[data-transcript-seq]:not(:empty), [data-row-seq]:not(:empty), [data-call-seq]:not(:empty)';

export interface TranscriptJumpOptions {
  /**
   * The open thread. A jump still on its way when another thread opens is
   * dropped: its row is that thread's, never the new one's.
   */
  threadId?: string | null;
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
  /** Absent where the window holds every row of the run. */
  calls?: CallJumps;
  /**
   * The thread-memory keys of the folds holding the row at `seq`, outermost
   * first (`jump-folds.ts`) — opened before the landing looks for the row.
   */
  foldsHolding?: (seq: number) => readonly string[];
}

export interface TranscriptJump {
  /** Where a jump landed, marked so the reader can see which row it is. */
  mark: JumpMark | null;
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
  threadId = null,
  items,
  endRef,
  followingRef,
  setAboveTail,
  loadAround,
  returnToTail,
  calls,
  foldsHolding,
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
  const revealAnchor = useLatestCallback(
    (scroller: HTMLElement, target: HTMLElement): void => {
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
    },
    [followingRef, setAboveTail],
  );
  /**
   * The anchors a landing picks from: the run's own flow — never a row inside
   * a call's card, which is another conversation's, interleaved by seq — or ONE
   * card's own rows, never those of a card open inside it. Matched on the
   * dataset rather than through a selector built from an id.
   */
  const anchorsIn = useLatestCallback(
    (
      cardId: string | null,
    ): {
      scroller: HTMLElement;
      scope: HTMLElement | null;
      anchors: HTMLElement[];
    } | null => {
      const scroller = endRef.current?.parentElement;
      if (!scroller) {
        return null;
      }
      if (cardId === null) {
        return {
          scroller,
          scope: null,
          anchors: [...scroller.querySelectorAll<HTMLElement>(ANCHORS)].filter(
            (anchor) =>
              anchor.dataset.callSeq === undefined &&
              anchor.parentElement?.closest('[data-role="call-block"]') == null,
          ),
        };
      }
      const card = [
        ...scroller.querySelectorAll<HTMLElement>('[data-role="call-block"]'),
      ].find((each) => each.dataset.callBlock === cardId);
      if (!card) {
        return null;
      }
      return {
        scroller,
        scope: card,
        anchors: [...card.querySelectorAll<HTMLElement>(ANCHORS)].filter(
          (anchor) =>
            anchor.parentElement?.closest('[data-role="call-block"]') === card,
        ),
      };
    },
    [endRef],
  );

  /**
   * The landing waiting for the commit that can show it.
   *
   * A jump cannot scroll in the same tick it asks for rows: `loadAround` sets
   * state, and the rows it fetched are not in the DOM until React has committed
   * them. So the landing is PARKED and an effect makes it on the next commit —
   * which also covers a row already loaded, since setting this is itself a
   * commit — and again after each fold it opened has drawn what it holds.
   */
  const [landing, setLanding] = useState<Landing | null>(null);

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
  const [mark, setMark] = useState<JumpMark | null>(null);

  useEffect(() => {
    if (landing === null) {
      return;
    }
    // Cleared whether or not it lands: a second attempt would need a reason to
    // believe the next commit is different — only opened folds are one.
    setLanding(null);
    // The row may be drawn inside folds the reader has not opened — a tool
    // group, the tool row holding its result, a long reasoning, a sub-agent
    // block. Opened as their own press would open them, all at once, and the
    // row looked for again once they are drawn.
    const folds =
      landing.unfolded || threadId === null || foldsHolding === undefined
        ? []
        : foldsHolding(landing.seq);
    if (folds.length > 0 && threadId !== null) {
      for (const key of folds) {
        writeThreadFlag(threadId, key, true);
      }
      setLanding({ ...landing, unfolded: true });
      return;
    }
    const found = anchorsIn(landing.cardId);
    const target =
      found === null ? null : pickJumpAnchor(found.anchors, landing.seq);
    const reveal = target ?? found?.scope ?? null;
    if (found === null || reveal === null) {
      setMark(null);
      return;
    }
    revealAnchor(found.scroller, reveal);
    setMark(
      target === null
        ? null
        : {
            seq: anchorSeq(target),
            cardId: landing.cardId,
            key: target.dataset.jumpKey ?? '',
          },
    );
  }, [landing, anchorsIn, revealAnchor, threadId, foldsHolding]);

  useEffect(() => {
    if (mark === null) {
      return;
    }
    // It fades on a timer rather than on the next scroll or click: the reader
    // arrives, looks, and reads on — and a mark that vanished the moment they
    // touched the wheel would be gone before they had found it.
    const timer = setTimeout(() => setMark(null), JUMP_MARK_MS);
    return () => clearTimeout(timer);
  }, [mark]);

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
  /** Moves with every jump and thread, so a jump superseded mid-way never lands. */
  const jumpGenerationRef = useRef(0);
  const jumpInFlow = useLatestCallback(
    (seq: number): void => {
      const generation = jumpGenerationRef.current;
      const loaded =
        items.length > 0 &&
        seq >= items[0]!.seq &&
        seq <= items[items.length - 1]!.seq;
      if (loaded) {
        setLanding({ seq, cardId: null, unfolded: false });
        return;
      }
      void loadAround(seq).then((ok) => {
        if (ok && jumpGenerationRef.current === generation) {
          setLanding({ seq, cardId: null, unfolded: false });
        }
      });
    },
    [items, loadAround],
  );

  /**
   * A jump to a row filed under a call, advanced one commit at a time: page the
   * window to the call's card when it holds none, open the card, read the
   * card's conversation back to the row, then land on the row inside it.
   */
  const [pendingCall, setPendingCall] = useState<PendingCallJump | null>(null);
  useEffect(() => {
    // Another thread: whatever was on its way belonged to the one before.
    jumpGenerationRef.current += 1;
    setPendingCall(null);
    setLanding(null);
  }, [threadId]);

  useEffect(() => {
    if (pendingCall === null || pendingCall.waiting || calls === undefined) {
      return;
    }
    const generation = jumpGenerationRef.current;
    const stillThisJump = (): boolean =>
      jumpGenerationRef.current === generation;
    const path = calls.cardsOf(pendingCall.callId);
    const card = path.at(-1);
    if (card === undefined) {
      const start = calls.startOf(pendingCall.callId);
      if (start === null || pendingCall.pagedToStart) {
        // Nowhere better to go than the run's own flow around the call.
        setPendingCall(null);
        jumpInFlow(start ?? pendingCall.seq);
        return;
      }
      setPendingCall({ ...pendingCall, pagedToStart: true, waiting: true });
      void loadAround(start).then((ok) => {
        if (!stillThisJump()) {
          return;
        }
        if (ok) {
          setPendingCall((prev) =>
            prev === null ? prev : { ...prev, waiting: false },
          );
        } else {
          setPendingCall(null);
        }
      });
      return;
    }
    setPendingCall({ ...pendingCall, waiting: true });
    for (const each of path) {
      calls.openCard(each.id);
    }
    // Every card around it is read through the row too: a card is drawn in its
    // parent's conversation only where that conversation's pages reach.
    void Promise.all(
      path.map((each) => calls.loadThrough(each.conversation, pendingCall.seq)),
    ).then(() => {
      if (!stillThisJump()) {
        return;
      }
      setPendingCall(null);
      setLanding({ seq: pendingCall.seq, cardId: card.id, unfolded: false });
    });
  }, [pendingCall, calls, loadAround, jumpInFlow]);

  const jumpToSeq = useLatestCallback(
    (seq: number): void => {
      jumpGenerationRef.current += 1;
      setPendingCall(null);
      if (calls === undefined) {
        jumpInFlow(seq);
        return;
      }
      const generation = jumpGenerationRef.current;
      void calls
        .locate(seq)
        .catch(() => null)
        .then((callId) => {
          if (jumpGenerationRef.current !== generation) {
            return;
          }
          if (callId === null) {
            jumpInFlow(seq);
            return;
          }
          setPendingCall({ seq, callId, pagedToStart: false, waiting: false });
        });
    },
    [calls, jumpInFlow],
  );

  const jumpToLatest = useLatestCallback((): void => {
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
  const backToTail = useLatestCallback((): void => {
    void returnToTail().then((ok) => {
      if (ok) {
        jumpToLatest();
      }
    });
  }, [returnToTail, jumpToLatest]);

  return { mark, jumpToSeq, jumpToLatest, backToTail };
}
