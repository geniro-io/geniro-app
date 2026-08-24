import { ArrowDown } from 'lucide-react';

import { cn } from '../components/ui/utils';

/**
 * The transcript's "jump to the latest" control — shown only while the reader
 * is somewhere above the tail.
 *
 * The tail-follow is deliberately silent (`scroll-follow.ts`): scrolling a
 * reader back down while they are looking at something further up is the defect
 * that rule exists to prevent, and it was shipped with "no jump-to-latest
 * affordance by design". What that left is the other half of the same problem —
 * REPORTED as "он не всегда автоматически скроллит вниз… хочу кнопочку типа
 * стрелочку вниз". Once the follow is off there is no way back to the tail but
 * to drag the scrollbar, and a transcript that grew a screenful of tool output
 * while you were reading is a long drag.
 *
 * It floats over the transcript's bottom edge rather than sitting in the
 * layout: a control that appears and disappears with the scroll position would
 * otherwise resize the transcript underneath the reader every time it
 * toggles — which moves the very text they stopped to read.
 *
 * Rendering is the CALLER's decision (`visible`), because only the transcript
 * knows where its own scroller is; this owns the look and the shape.
 */
export function JumpToLatest({
  visible,
  onJump,
  className,
}: {
  visible: boolean;
  onJump: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    // A zero-height row so the button hangs ABOVE the composer without taking
    // part in the column's sizing, and `pointer-events-none` so the strip it
    // spans never swallows a click meant for the transcript behind it — the
    // button itself takes its own back.
    <div
      className={cn(
        'pointer-events-none relative h-0 w-full overflow-visible',
        className,
      )}>
      <button
        type="button"
        data-slot="jump-to-latest"
        aria-label="Jump to the latest message"
        title="Jump to the latest message"
        // `hidden` rather than an absent element: mounted either way, so the
        // transition below has something to animate and no layout is computed
        // at the moment it appears.
        aria-hidden={!visible}
        tabIndex={visible ? 0 : -1}
        onClick={onJump}
        className={cn(
          'pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-panel-lg outline-none transition-opacity hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
          visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}>
        <ArrowDown className="size-3.5 shrink-0" />
        Latest
      </button>
    </div>
  );
}
