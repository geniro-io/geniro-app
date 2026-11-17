import { cva } from 'class-variance-authority';
import {
  ArrowUpRight,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
  Moon,
} from 'lucide-react';

import { plainPreview } from '../chats/brief-text';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { taskStatusMeta } from '../tasks/task-status';

export type ThreadCardStatus =
  'working' | 'waiting' | 'idle' | 'failed' | 'done';

export type ThreadCardPullRequestState = 'open' | 'merged' | 'closed' | 'draft';

/** The board card a thread works, shown on it as a label. */
export interface ThreadCardBoardCard {
  identifier: string | null;
  title: string;
  status: string;
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
  boardCard: ThreadCardBoardCard | null;
  /** Whole days nobody has touched it, once it counts as idle; else null. */
  idleDays: number | null;
  /** What a screen reader hears for the whole card. */
  summary?: string;
  /** A taller height to stand in, so a line of cards lines up; never shorter than its content. */
  height?: number;
  onGo: () => void;
}

export const THREAD_CARD_WIDTH = 300;

const PAD_PX = 12;
const GAP_PX = 8;
const BORDER_PX = 1;
const ROW_PX = {
  header: 20,
  meta: 16,
  labels: 20,
  note: 24,
  activity: 16,
  footer: 24,
} as const;

/** The card's height for what it shows, so the graph can lay it out before it is drawn. */
export function threadCardHeight({
  labels,
  note,
  activity,
}: {
  labels: boolean;
  note: boolean;
  activity: boolean;
}): number {
  const rows = [
    ROW_PX.header,
    ROW_PX.meta,
    ...(labels ? [ROW_PX.labels] : []),
    ...(note ? [ROW_PX.note] : []),
    ...(activity ? [ROW_PX.activity] : []),
    ROW_PX.footer,
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
  return activity === null ? '' : plainPreview(activity).replace(/`/g, '');
}

/** Whether the card carries its label row: a board card, or an idle mark. */
export function hasLabels(view: {
  boardCard: ThreadCardBoardCard | null;
  idleDays: number | null;
}): boolean {
  return view.boardCard !== null || view.idleDays !== null;
}

export const THREAD_STATUS_TEXT: Record<ThreadCardStatus, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  failed: 'Failed',
  done: 'Done',
};

const cardVariants = cva(
  'flex flex-col overflow-hidden rounded-card border bg-card text-left shadow-sm transition-[border-color,box-shadow] duration-200 hover:shadow-md motion-reduce:transition-none',
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

function BoardCardLabel({
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
      className="min-w-0 shrink gap-1 px-1.5 py-0 font-normal">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', meta.className)}
      />
      <span className="truncate font-mono tabular-nums">
        {card.identifier ?? card.title}
      </span>
      <span className="shrink-0 text-muted-foreground">· {meta.label}</span>
    </Badge>
  );
}

function IdleMark({ days }: { days: number }): React.JSX.Element {
  return (
    <Badge
      data-slot="thread-card-idle"
      variant="muted"
      title={`Nobody has touched this thread for ${days} days`}
      className="shrink-0 gap-1 px-1.5 py-0 font-normal text-muted-foreground">
      <Moon aria-hidden="true" className="size-3.5 shrink-0" />
      Idle {days} days
    </Badge>
  );
}

/**
 * One thread as a card of fixed size — a node of the command center's graph.
 * The card itself opens nothing; its Go to thread button does.
 */
export function ThreadCard({
  title,
  status,
  handle,
  project,
  agentLabel,
  pullRequest,
  note,
  activity,
  boardCard,
  idleDays,
  summary,
  height,
  onGo,
}: ThreadCardProps): React.JSX.Element {
  const meta = [THREAD_STATUS_TEXT[status], handle, project, agentLabel]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
  const now = activityLine(activity);
  const labels = hasLabels({ boardCard, idleDays });
  const ownHeight = threadCardHeight({
    labels,
    note: note !== null,
    activity: now !== '',
  });
  return (
    <article
      aria-label={summary ?? title}
      data-slot="thread-card"
      data-status={status}
      className={cardVariants({ status })}
      style={{
        width: THREAD_CARD_WIDTH,
        height: Math.max(ownHeight, height ?? 0),
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
      {labels ? (
        <div className="flex h-5 min-w-0 shrink-0 items-center gap-1.5">
          {boardCard === null ? null : <BoardCardLabel card={boardCard} />}
          {idleDays === null ? null : <IdleMark days={idleDays} />}
        </div>
      ) : null}
      {note === null ? null : (
        <p
          data-slot="thread-card-note"
          title={note}
          className="h-6 shrink-0 truncate border-l-2 border-primary/50 pl-2 text-xs leading-6 text-foreground/80 italic">
          {note}
        </p>
      )}
      {now === '' ? null : (
        <p
          data-slot="thread-card-activity"
          title={now}
          className="h-4 shrink-0 truncate text-xs leading-4 text-muted-foreground">
          Now: {now}
        </p>
      )}
      <div className="mt-auto flex h-6 shrink-0 justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="thread-card-go"
          className="h-6 gap-1 px-2 text-xs"
          onClick={onGo}>
          Go to thread
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    </article>
  );
}
