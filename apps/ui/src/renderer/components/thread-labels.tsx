import { cva } from 'class-variance-authority';
import {
  ArrowRight,
  Bot,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
  MessageSquareText,
  Users,
} from 'lucide-react';

import type { ProfileColor } from '../../shared/contracts';
import { taskStatusMeta } from '../tasks/task-status';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { PaletteDot } from './ui/palette-dot';
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
  slot = 'thread-card-board-card',
}: {
  card: ThreadCardBoardCard;
  slot?: string;
}): React.JSX.Element {
  const meta = taskStatusMeta(card.status);
  const Icon = meta.icon;
  return (
    <Badge
      data-slot={slot}
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
  mark,
  title,
  yields,
}: {
  slot: string;
  icon: LucideIcon;
  /** Drawn in the glyph's place, e.g. the project's colour dot. */
  mark?: React.ReactNode;
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
      {mark ?? <Icon aria-hidden="true" className="size-3 shrink-0" />}
      <span className="truncate">{text}</span>
    </Badge>
  );
}

export type ThreadPullRequestState = 'open' | 'merged' | 'closed' | 'draft';

/** A thread's pull request: its number, and its state where one is known. */
export interface ThreadPullRequest {
  number: number;
  state: ThreadPullRequestState | null;
}

const PULL_REQUEST_META: Record<
  ThreadPullRequestState,
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

/** A thread's pull request as a label: its state's glyph and its number. */
export function PullRequestLabel({
  pullRequest,
  slot,
}: {
  pullRequest: ThreadPullRequest;
  slot: string;
}): React.JSX.Element {
  const meta =
    pullRequest.state === null ? null : PULL_REQUEST_META[pullRequest.state];
  const Icon = meta?.icon ?? GitPullRequest;
  return (
    <Badge
      data-slot={slot}
      variant="muted"
      title={
        meta === null
          ? `Pull request #${pullRequest.number}`
          : `#${pullRequest.number} · ${meta.word}`
      }
      className="shrink-0 gap-1 px-1.5 py-0 font-normal">
      <Icon
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0',
          meta?.className ?? 'text-muted-foreground',
        )}
      />
      {meta === null ? null : <span className="sr-only">{meta.word}</span>}
      <span className="tabular-nums">#{pullRequest.number}</span>
    </Badge>
  );
}

/** What a thread's labels row shows, as its node on the command center's graph does. */
export interface ThreadLabelsView {
  /** Where the thread stands, in its tint and words; null where the view does not know. */
  status: { attention: ThreadAttention; text: string } | null;
  /** The agent's short name, or the team's name for a team run. */
  agentLabel: string | null;
  isTeam: boolean;
  boardCard: ThreadCardBoardCard | null;
  project: string | null;
  projectColor: ProfileColor | null;
}

/**
 * A thread's labels in one row — its status, agent or team, board card and
 * project with the project's colour as a dot — the row its node on the graph
 * and every card that heads a thread share. Each label's slot is `slot`
 * followed by what it is (`-status`, `-agent`, `-board-card`, `-project`).
 */
export function ThreadLabelsRow({
  view,
  slot,
  className,
}: {
  view: ThreadLabelsView;
  slot: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      data-slot={`${slot}-labels`}
      className={cn(
        'flex min-w-0 items-center gap-1 overflow-hidden',
        className,
      )}>
      {view.status === null ? null : (
        <ThreadStatusChip
          attention={view.status.attention}
          slot={`${slot}-status`}>
          {view.status.text}
        </ThreadStatusChip>
      )}
      {view.agentLabel === null ? null : (
        <ThreadLabelChip
          slot={`${slot}-agent`}
          icon={view.isTeam ? Users : Bot}
          text={view.agentLabel}
          title={
            view.isTeam ? `Team ${view.agentLabel}` : `Agent ${view.agentLabel}`
          }
          yields={false}
        />
      )}
      {view.boardCard === null ? null : (
        <BoardCardLabel card={view.boardCard} slot={`${slot}-board-card`} />
      )}
      {view.project === null ? null : (
        <ThreadLabelChip
          slot={`${slot}-project`}
          icon={Folder}
          mark={
            view.projectColor === null ? undefined : (
              <PaletteDot
                color={view.projectColor}
                size="md"
                data-slot={`${slot}-project-dot`}
              />
            )
          }
          text={view.project}
          title={`Project ${view.project}`}
          yields
        />
      )}
    </div>
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
