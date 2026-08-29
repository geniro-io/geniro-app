import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '../components/ui/utils';
import { followTail } from '../scroll-to-bottom';
import { nextFollowState } from './scroll-follow';

/**
 * How tall a reasoning stretch may grow while it is being written.
 *
 * REPORTED as "вот этот thinking-блок у курсора очень большой… должно иметь
 * какую-то максимальную высоту, например 300 px". Cursor streams its whole
 * chain of thought, and on a real turn that is thousands of words — so the row
 * the user is watching pushed the answer, the tool rows and the composer off
 * the screen while it was still being written.
 *
 * The number is the reported one. It is a box height rather than a line count
 * because the text wraps at the transcript's own width, which the reader
 * controls: a "fifteen lines" rule would be a different amount of screen in a
 * narrow window and in a wide one.
 */
export const THINKING_MAX_HEIGHT_PX = 300;

/**
 * Above this many characters a FINISHED stretch is folded away.
 *
 * Not zero — folding two sentences into a one-line preview plus a chevron
 * hides nothing worth hiding and charges a click for it. Roughly six lines at
 * the transcript's own width, which is the point where the block starts
 * reading as a wall rather than as a remark.
 *
 * A character count and not a measured height, deliberately: what a fold must
 * decide is knowable BEFORE layout, and asking the browser would mean drawing
 * the wall once and collapsing it afterwards, in front of the reader.
 */
const THINKING_FOLD_CHARS = 600;

/**
 * The reasoning text of a stretch that is STILL BEING WRITTEN — bounded, and
 * following its own tail.
 *
 * Two halves of one behaviour. The box is capped at
 * {@link THINKING_MAX_HEIGHT_PX} and scrolls INSIDE itself, so a stretch of any
 * length costs the same amount of transcript; and it is pinned to the newest
 * words, because a fixed box showing the FIRST 300px of a chain of thought
 * would be a paragraph the agent wrote a minute ago sitting motionless under a
 * spinner — the reported "он просто всё время scrollit вверх сам и показывает
 * самое последнее".
 *
 * The follow gives way to the reader, on the transcript's own rule
 * ({@link nextFollowState}): only a scroll that moved the viewport UP switches
 * it off, and reaching the bottom again re-arms it. Growing content pushes the
 * bottom away without the user touching anything, which is why "am I at the
 * bottom" alone cannot decide this — the same trap the transcript documents.
 *
 * `auto` rather than `smooth`: chunks land many times a second, so a smooth
 * scroll is re-targeted before it arrives and the box lags permanently behind
 * the text it is meant to be showing.
 */
export function ThinkingScroller({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  // Refs rather than state: neither value is rendered, and following the tail
  // sixty times a second must not re-render the transcript row that holds it.
  const following = useRef(true);
  const lastTop = useRef(0);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !following.current) {
      return;
    }
    followTail(box);
    // Record where WE put it, so the scroll event this causes is not read as
    // the reader scrolling away.
    lastTop.current = box.scrollTop;
  }, [text]);

  return (
    <div
      ref={boxRef}
      data-slot="thinking-scroller"
      onScroll={(event) => {
        const box = event.currentTarget;
        following.current = nextFollowState(
          following.current,
          box,
          lastTop.current,
        );
        lastTop.current = box.scrollTop;
      }}
      style={{ maxHeight: `${THINKING_MAX_HEIGHT_PX}px` }}
      className={cn(
        'overflow-y-auto break-words whitespace-pre-wrap italic',
        className,
      )}>
      {text}
    </div>
  );
}

/**
 * A FINISHED reasoning stretch, folded away behind its own first line.
 *
 * REPORTED as "потом это должно быть collapsed, как только он закончил
 * thinking… потом мы его можем развернуть, потому что такие сообщения обычно
 * очень длинные". Once the stretch is over the words stop being something to
 * watch and become something to be able to check — and a transcript is read
 * for what the agent DID, which on a cursor turn was several screens below the
 * thinking that preceded it.
 *
 * The collapsed line is the stretch's own FIRST LINE rather than a count or a
 * duration: it is the only summary available here that says what the agent was
 * thinking ABOUT, which is what decides whether anyone opens it. (The durable
 * row carries the text and nothing else — no timing, no token total.)
 *
 * The BODY is `children`, not derived from `text`, because the two call sites
 * render it differently and always have: the standalone bubble prints it
 * verbatim, a turn block prints it as markdown. Sharing the fold and not the
 * body is what lets both change how they draw prose without either of them
 * growing a second copy of the disclosure.
 *
 * Short stretches are NOT folded ({@link THINKING_FOLD_CHARS}), so this
 * renders its children bare and adds no control at all.
 */
export function ThinkingDisclosure({
  text,
  children,
}: {
  /** The reasoning, for the preview and for the fold decision. */
  text: string;
  /** The full body, drawn by the caller in its own idiom. */
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (text.length <= THINKING_FOLD_CHARS) {
    return <>{children}</>;
  }
  // The first line with anything ON it. A chain of thought routinely opens
  // with a blank line or a bare heading marker, and previewing that shows the
  // reader nothing they can decide on.
  const preview =
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';
  return (
    <div data-slot="thinking-disclosure" className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={open ? 'Hide the reasoning' : 'Show the full reasoning'}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 text-left',
          // `text-xs font-normal` is NOT redundant with anything inherited:
          // `global.css` gives every `button` the base size and medium weight,
          // and a rule on the element beats what it would inherit — the same
          // trap `DisclosureRow` documents, and the one the header counters
          // were rendering 15px/500 through.
          'text-muted-foreground text-xs font-normal italic hover:text-foreground',
        )}>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        {/* Collapsed the line hints at the content; expanded it would repeat
            the first line of the body directly beneath it, so it goes. */}
        {open ? (
          <span className="min-w-0 flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate">{preview}</span>
        )}
      </button>
      {open ? <div className="mt-1.5 min-w-0">{children}</div> : null}
    </div>
  );
}
