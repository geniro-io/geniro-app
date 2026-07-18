import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../components/ui/utils';

/**
 * A single transcript row. `variant` maps 1:1 to the surfaced item kinds, giving
 * each its own chrome once and for all — the transcript never re-picks bubble
 * styling by hand. `data-role` is the stable hook the Chats tests query.
 */
const bubbleVariants = cva('flex flex-col gap-1 rounded-xl text-sm', {
  variants: {
    variant: {
      // The user/assistant pair mirrors geniro web's ChatBubble classes
      // (bg-primary/10 human, bg-muted/40 agent, px-4 py-3 leading-relaxed).
      user: 'self-end max-w-[76%] bg-primary/10 border border-primary/20 px-4 py-3 leading-relaxed',
      assistant:
        'self-start max-w-[76%] bg-muted/40 border border-border px-4 py-3 leading-relaxed',
      reasoning:
        'self-start max-w-[85%] bg-muted/50 text-muted-foreground px-3.5 py-2.5',
      tool: 'self-start w-full bg-muted text-muted-foreground px-3.5 py-2.5',
      // Agent-to-agent call rows share the call features' amber language
      // (the dashed call edge, the amber ports) via the warning token.
      call: 'self-start w-full bg-warning/10 border border-warning/30 px-3.5 py-2.5',
      error:
        'self-start max-w-[85%] bg-destructive/10 border border-destructive/30 text-destructive px-3.5 py-2.5',
      note: 'self-center text-xs text-muted-foreground py-1',
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
