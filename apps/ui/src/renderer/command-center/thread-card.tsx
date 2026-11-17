import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';

import { RunStatusIcon, type RunStatusKind } from '../chats/run-status';
import { CARD_BUTTON_CLASS } from '../components/card-hover';
import {
  TimelineStrip,
  type TimelineStripProps,
} from '../components/timeline-strip';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';

export type ThreadCardStatus =
  'working' | 'waiting' | 'idle' | 'failed' | 'done';

export type ThreadCardPullRequestState = 'open' | 'merged' | 'closed' | 'draft';

export interface ThreadCardProps {
  title: string;
  status: ThreadCardStatus;
  project: string | null;
  agentLabel: string | null;
  pullRequest: { number: number; state: ThreadCardPullRequestState } | null;
  note: string | null;
  activity: string | null;
  strip: TimelineStripProps;
  onOpen: () => void;
}

const STATUS_META: Record<
  ThreadCardStatus,
  { text: string; icon: RunStatusKind }
> = {
  working: { text: 'Working', icon: 'held' },
  waiting: { text: 'Waiting on you', icon: 'needs-input' },
  idle: { text: 'Idle', icon: 'skipped' },
  failed: { text: 'Failed', icon: 'failed' },
  done: { text: 'Done', icon: 'completed' },
};

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
 * A marker or any other control inside the strip answers its own press; the
 * click and the key must not also open the thread that holds them.
 */
function keepPressesInStrip(event: React.SyntheticEvent<HTMLDivElement>): void {
  if (
    event.target instanceof Element &&
    event.target.closest('button') !== null
  ) {
    event.stopPropagation();
  }
}

export function ThreadCard({
  title,
  status,
  project,
  agentLabel,
  pullRequest,
  note,
  activity,
  strip,
  onOpen,
}: ThreadCardProps): React.JSX.Element {
  const meta = STATUS_META[status];
  const context = [project, agentLabel]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <div
      role="button"
      tabIndex={0}
      data-slot="thread-card"
      data-status={status}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'flex w-full min-w-0 cursor-pointer flex-col gap-2 rounded-card bg-card p-3 text-left ring-1 ring-border',
        CARD_BUTTON_CLASS,
      )}>
      <div className="flex min-w-0 items-start gap-2">
        <span
          data-slot="thread-card-title"
          className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium">
          {title}
        </span>
        {pullRequest === null ? null : (
          <PullRequestChip
            number={pullRequest.number}
            state={pullRequest.state}
          />
        )}
      </div>
      <div
        data-slot="thread-card-status"
        className="flex min-w-0 items-center gap-1.5 text-xs">
        <RunStatusIcon status={meta.icon} />
        <span className="font-medium">{meta.text}</span>
      </div>
      {context === '' ? null : (
        <p className="truncate text-xs text-muted-foreground">{context}</p>
      )}
      {note === null ? null : (
        <p
          data-slot="thread-card-note"
          className="line-clamp-2 break-words rounded-control bg-muted/50 px-2 py-1 text-xs">
          {note}
        </p>
      )}
      <div onClick={keepPressesInStrip} onKeyDown={keepPressesInStrip}>
        <TimelineStrip {...strip} />
      </div>
      {activity === null ? null : (
        <p
          data-slot="thread-card-activity"
          className="truncate text-xs text-muted-foreground">
          Now: {activity}
        </p>
      )}
    </div>
  );
}
