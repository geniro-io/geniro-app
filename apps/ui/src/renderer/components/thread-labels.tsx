import { cva } from 'class-variance-authority';
import { ArrowRight, type LucideIcon, MessageSquareText } from 'lucide-react';

import { taskStatusMeta } from '../tasks/task-status';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from './ui/utils';

/** Where a thread stands for the user, which colours its card and its status chip. */
export type ThreadAttention =
  'blocked' | 'working' | 'question' | 'quiet' | 'inactive';

/** The board card a thread works, shown on it as a label. */
export interface ThreadCardBoardCard {
  identifier: string | null;
  title: string;
  status: string;
}

export const threadStatusChipVariants = cva(
  'shrink-0 px-1.5 py-0 font-medium',
  {
    variants: {
      attention: {
        blocked: 'bg-destructive/10 text-destructive',
        working: 'bg-success/10 text-success',
        question: 'bg-warning/15 text-warning',
        quiet: 'bg-muted text-muted-foreground',
        inactive: 'bg-muted text-muted-foreground',
      } satisfies Record<ThreadAttention, string>,
    },
  },
);

/** A thread's status in words, tinted by where it stands. */
export function ThreadStatusChip({
  attention,
  slot,
  className,
  children,
}: {
  attention: ThreadAttention;
  slot: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Badge
      data-slot={slot}
      variant="muted"
      className={cn(threadStatusChipVariants({ attention }), className)}>
      {children}
    </Badge>
  );
}

/** The board card a thread works: its column's glyph and its identifier. */
export function BoardCardLabel({
  card,
}: {
  card: ThreadCardBoardCard;
}): React.JSX.Element {
  const meta = taskStatusMeta(card.status);
  const Icon = meta.icon;
  return (
    <Badge
      data-slot="thread-card-board-card"
      variant="muted"
      title={`${card.identifier ?? 'Board card'} · ${card.title} · ${meta.label}`}
      className="max-w-24 shrink-0 gap-1 px-1.5 py-0 font-normal">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', meta.className)}
      />
      <span className="truncate font-mono tabular-nums">
        {card.identifier ?? card.title}
      </span>
    </Badge>
  );
}

/** One of a thread's labels — its agent or team, its project — as a glyph and a word. */
export function ThreadLabelChip({
  slot,
  icon,
  text,
  title,
  yields,
}: {
  slot: string;
  icon: LucideIcon;
  text: string;
  title: string;
  /** Gives up its room first when the row runs out of it. */
  yields: boolean;
}): React.JSX.Element {
  const Icon = icon;
  return (
    <Badge
      data-slot={slot}
      variant="muted"
      title={title}
      className={cn(
        'gap-1 px-1.5 py-0 font-normal',
        yields ? 'min-w-14 shrink' : 'max-w-28 shrink-0',
      )}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </Badge>
  );
}

/** The way into a thread: a small outlined pill with the thread's glyph and an arrow. */
export function GoToThreadButton({
  onGo,
}: {
  onGo: () => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="thread-card-go"
      className="group/go h-6 shrink-0 gap-1 rounded-full px-2.5 text-xs font-medium"
      onClick={onGo}>
      <MessageSquareText aria-hidden="true" className="size-3.5" />
      Go to thread
      <ArrowRight
        aria-hidden="true"
        className="size-3 transition-transform group-hover/go:translate-x-0.5 motion-reduce:transition-none"
      />
    </Button>
  );
}
