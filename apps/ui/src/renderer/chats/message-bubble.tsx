import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../components/ui/utils';

/**
 * A single transcript row. `variant` maps 1:1 to the surfaced item kinds, giving
 * each its own chrome once and for all — the transcript never re-picks bubble
 * styling by hand. `data-role` is the stable hook the Chats tests query.
 */
// `min-w-0` is load-bearing, not tidiness: the bubble is a flex ITEM of the
// transcript column, so its default `min-width: auto` is its content's
// min-content width — and CSS resolves min-width ABOVE max-width. One
// unbreakable token (a pasted URL) therefore pushed the bubble past its own
// max-width and out of the column. The children's own `min-w-0` cannot fix
// it; the item that refuses to shrink is this one.
//
// A MESSAGE MAY USE THE WHOLE COLUMN — `max-w-full`, not a fraction of it.
// The user and assistant bubbles were capped at 76% and the reasoning and
// error rows at 85%, all but the user's `self-start`, so on a wide pane every
// agent row sat in the left three-quarters with a quarter of the row empty
// beside it. REPORTED as the transcript's "wrong content width", and confirmed
// in those terms: "previously it was capped, so all messages were on the left".
// The cap is not merely lowered, because there is no fraction that is right —
// the pane is 680px with both side columns out and 1,080px with them folded
// away, so any fraction is dead space that grows with the window.
//
// It stays a max-width rather than becoming none at all, and that is what the
// spec beside this pins: 100% still BOUNDS the item, so the unbreakable token
// above is clipped by the column instead of by `overflow-x-hidden`, which is
// the same "text is outside block" report reopened from the other side. The
// bubbles are still content-sized — a one-word reply is a small bubble, not a
// full-width band — so only a message long enough to need the room takes it.
const bubbleVariants = cva('flex min-w-0 flex-col gap-1 rounded-xl text-sm', {
  variants: {
    variant: {
      // The user/assistant pair mirrors geniro web's ChatBubble classes
      // (bg-primary/10 human, bg-muted/40 agent, px-4 py-3 leading-relaxed).
      user: 'self-end max-w-full bg-primary/10 border border-primary/20 px-4 py-3 leading-relaxed',
      assistant:
        'self-start max-w-full bg-muted/40 border border-border px-4 py-3 leading-relaxed',
      reasoning:
        'self-start max-w-full bg-muted/50 text-muted-foreground px-3.5 py-2.5',
      tool: 'self-start w-full bg-muted text-muted-foreground px-3.5 py-2.5',
      // Agent-to-agent call rows share the call features' amber language
      // (the dashed call edge, the amber ports) via the warning token.
      call: 'self-start w-full bg-warning/10 border border-warning/30 px-3.5 py-2.5',
      error:
        'self-start max-w-full bg-destructive/10 border border-destructive/30 text-destructive px-3.5 py-2.5',
      // `text-center` beside `self-center`, and the pair is one intent rather
      // than two: `self-center` centres the BOX, which is all a short row like
      // `✓ tool approved` ever needed. A note long enough to wrap then filled
      // the column and read as a left-aligned paragraph — REPORTED against the
      // profile-switch notice, "this message should be in center". `max-w`
      // keeps a long one off both edges so the centring is visible at all.
      //
      // The ONE variant that keeps a fractional cap, while every message above
      // gave one up. It is not a message: a note is centred chrome, and the
      // fraction is what MAKES the centring visible — at full width a wrapped
      // note is a block touching both edges, which is the report this line
      // answers, and it would come straight back.
      note: 'self-center max-w-[76%] text-center text-xs text-muted-foreground py-1',
    },
  },
  defaultVariants: { variant: 'assistant' },
});

export type BubbleVariant = NonNullable<
  VariantProps<typeof bubbleVariants>['variant']
>;

export function MessageBubble({
  variant,
  role,
  className,
  children,
}: {
  variant: BubbleVariant;
  role?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-role={variant}
      className={cn(bubbleVariants({ variant }), className)}>
      {role ? (
        <span
          className={cn(
            'text-[11px] font-medium uppercase tracking-wide',
            // The user bubble's white-on-caramel is already the low-contrast
            // pairing — a further 70% fade drops its caption to ~2:1.
            variant !== 'user' && 'opacity-70',
          )}>
          {role}
        </span>
      ) : null}
      {children}
    </div>
  );
}
