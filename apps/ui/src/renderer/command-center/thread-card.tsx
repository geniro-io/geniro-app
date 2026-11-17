import { cva } from 'class-variance-authority';
import {
  ChevronDown,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListTodo,
  type LucideIcon,
} from 'lucide-react';

import { plainPreview } from '../chats/brief-text';
import {
  TimelineStrip,
  type TimelineStripProps,
} from '../components/timeline-strip';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';

export type ThreadCardStatus =
  'working' | 'waiting' | 'idle' | 'failed' | 'done';

export type ThreadCardPullRequestState = 'open' | 'merged' | 'closed' | 'draft';

export interface ThreadCardTask {
  expanded: boolean;
  onToggle: () => void;
}

export interface ThreadCardProps {
  title: string;
  status: ThreadCardStatus;
  handle: string | null;
  project: string | null;
  agentLabel: string | null;
  pullRequest: { number: number; state: ThreadCardPullRequestState } | null;
  note: string | null;
  activity: string | null;
  strip: TimelineStripProps;
  /** The board card this thread works, folded under it; null when it has none. */
  task: ThreadCardTask | null;
  /** What a screen reader hears for the whole card. */
  summary?: string;
  onOpen: () => void;
}

export const THREAD_CARD_WIDTH = 300;

const PAD_PX = 12;
const GAP_PX = 8;
const BORDER_PX = 1;
const ROW_PX = {
  header: 20,
  meta: 16,
  note: 24,
  strip: 20,
  activity: 16,
  task: 24,
} as const;

/** The card's height for what it shows, so the graph can lay it out before it is drawn. */
export function threadCardHeight({
  note,
  activity,
  task,
}: {
  note: boolean;
  activity: boolean;
  task: boolean;
}): number {
  const rows = [
    ROW_PX.header,
    ROW_PX.meta,
    ...(note ? [ROW_PX.note] : []),
    ROW_PX.strip,
    ...(activity ? [ROW_PX.activity] : []),
    ...(task ? [ROW_PX.task] : []),
  ];
  return (
    PAD_PX * 2 +
    BORDER_PX * 2 +
    rows.reduce((sum, row) => sum + row, 0) +
    GAP_PX * (rows.length - 1)
  );
}

/** The "Now:" line as the card shows it: one line of plain text, or empty. */
export function activityLine(activity: string | null): string {
  return activity === null ? '' : plainPreview(activity);
}

export const THREAD_STATUS_TEXT: Record<ThreadCardStatus, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  failed: 'Failed',
  done: 'Done',
};

const cardVariants = cva(
  'flex cursor-pointer flex-col overflow-hidden rounded-card border bg-card text-left shadow-sm outline-none transition-[border-color,box-shadow,translate] duration-200 hover:-translate-y-px hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/60 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
  {
    variants: {
      status: {
        working: 'border-primary/60',
        waiting: 'border-warning/70',
        idle: 'border-border',
        failed: 'border-destructive/60',
        done: 'border-success/50',
      } satisfies Record<ThreadCardStatus, string>,
    },
  },
);

const dotVariants = cva('relative size-2 shrink-0 rounded-full', {
  variants: {
    status: {
      working: 'bg-primary',
      waiting: 'bg-warning',
      idle: 'bg-muted-foreground/50',
      failed: 'bg-destructive',
      done: 'bg-success',
    } satisfies Record<ThreadCardStatus, string>,
  },
});

function StatusDot({
  status,
}: {
  status: ThreadCardStatus;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="thread-card-dot"
      className={dotVariants({ status })}>
      {status === 'working' ? (
        <span
          data-slot="thread-card-dot-ping"
          className="absolute inset-0 animate-ping rounded-full bg-primary/60 motion-reduce:animate-none"
        />
      ) : null}
    </span>
  );
}

const PULL_REQUEST_META: Record<
  ThreadCardPullRequestState,
  { word: string; icon: LucideIcon; className: string }
> = {
  open: { word: 'open', icon: GitPullRequest, className: 'text-warning' },
  draft: {
    word: 'draft',
    icon: GitPullRequestDraft,
    className: 'text-muted-foreground',
  },
  merged: { word: 'merged', icon: GitMerge, className: 'text-success' },
  closed: {
    word: 'closed',
    icon: GitPullRequestClosed,
    className: 'text-destructive',
  },
};

function PullRequestChip({
  number,
  state,
}: {
  number: number;
  state: ThreadCardPullRequestState;
}): React.JSX.Element {
  const meta = PULL_REQUEST_META[state];
  const Icon = meta.icon;
  return (
    <Badge
      data-slot="thread-card-pull-request"
      variant="muted"
      title={`#${number} · ${meta.word}`}
      className="shrink-0 gap-1 px-1.5 py-0 font-normal">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', meta.className)}
      />
      <span className="sr-only">{meta.word}</span>
      <span className="tabular-nums">#{number}</span>
    </Badge>
  );
}

/**
 * A marker or any other control inside the card answers its own press; the
 * click and the key must not also open the thread that holds them.
 */
function keepPressesInside(event: React.SyntheticEvent<HTMLElement>): void {
  if (
    event.target instanceof Element &&
    event.target.closest('button') !== null
  ) {
    event.stopPropagation();
  }
}

/** One running thread as a card of fixed size — a node of the command center's graph. */
export function ThreadCard({
  title,
  status,
  handle,
  project,
  agentLabel,
  pullRequest,
  note,
  activity,
  strip,
  task,
  summary,
  onOpen,
}: ThreadCardProps): React.JSX.Element {
  const meta = [THREAD_STATUS_TEXT[status], handle, project, agentLabel]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
  const now = activityLine(activity);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={summary ?? title}
      data-slot="thread-card"
      data-status={status}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cardVariants({ status })}
      style={{
        width: THREAD_CARD_WIDTH,
        height: threadCardHeight({
          note: note !== null,
          activity: now !== '',
          task: task !== null,
        }),
        padding: PAD_PX,
        gap: GAP_PX,
      }}>
      <div className="flex h-5 min-w-0 shrink-0 items-center gap-2">
        <StatusDot status={status} />
        <span
          data-slot="thread-card-title"
          title={title}
          className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </span>
        {pullRequest === null ? null : (
          <PullRequestChip
            number={pullRequest.number}
            state={pullRequest.state}
          />
        )}
      </div>
      <p
        data-slot="thread-card-status"
        className="h-4 shrink-0 truncate text-xs leading-4 text-muted-foreground">
        {meta}
      </p>
      {note === null ? null : (
        <p
          data-slot="thread-card-note"
          title={note}
          className="h-6 shrink-0 truncate rounded-control bg-muted/60 px-2 text-xs leading-6">
          {note}
        </p>
      )}
      <div
        className="h-5 shrink-0"
        onClick={keepPressesInside}
        onKeyDown={keepPressesInside}>
        <TimelineStrip {...strip} />
      </div>
      {now === '' ? null : (
        <p
          data-slot="thread-card-activity"
          title={now}
          className="h-4 shrink-0 truncate text-xs leading-4 text-muted-foreground">
          Now: {now}
        </p>
      )}
      {task === null ? null : (
        <button
          type="button"
          data-slot="thread-card-task-toggle"
          aria-expanded={task.expanded}
          onClick={(event) => {
            event.stopPropagation();
            task.onToggle();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-6 w-full shrink-0 items-center gap-1.5 rounded-control px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/60 focus-visible:outline-none">
          <ListTodo aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="flex-1 text-left">
            {task.expanded ? 'Hide its board card' : 'Show its board card'}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
              task.expanded && 'rotate-180',
            )}
          />
        </button>
      )}
    </div>
  );
}
