import { cva } from 'class-variance-authority';
import {
  ArrowUpRight,
  ChevronUp,
  MessageCircleQuestion,
  MessageSquareText,
  Moon,
  ShieldCheck,
} from 'lucide-react';

import type { ProfileColor } from '../../shared/contracts';
import { plainPreview } from '../chats/brief-text';
import { formatDateTime, formatRelativeTime } from '../chats/relative-time';
import {
  ArchiveThreadButton,
  ArchiveThreadIcon,
  useThreadArchive,
} from '../components/thread-archive';
import type { ThreadFaceLook } from '../components/thread-face';
import {
  ThreadHead,
  ThreadHeadIcon,
  type ThreadIdentity,
} from '../components/thread-head';
import type {
  ThreadAttention,
  ThreadCardBoardCard,
  ThreadPullRequestState,
} from '../components/thread-labels';
import { Button } from '../components/ui/button';
import { PALETTE_DOT_CLASS } from '../components/ui/palette';
import { cn } from '../components/ui/utils';

export type ThreadCardStatus =
  'working' | 'waiting' | 'idle' | 'failed' | 'done';

export interface ThreadCardProps {
  /** The thread's run, which the page's archive control is offered for. */
  runId?: string;
  title: string;
  status: ThreadCardStatus;
  /** The status chip's words, which say why the card stands in its band. */
  statusText: string;
  attention: ThreadAttention;
  project: string | null;
  /** The project's colour on the graph, worn as a stripe along the card's top and a dot on its label. */
  projectColor?: ProfileColor | null;
  /** The agent's short name, or the team's name for a team run. */
  agentLabel: string | null;
  isTeam: boolean;
  /** The thread's face: its agent, its team's members, or a plain mark. */
  face: ThreadFaceLook;
  pullRequest: { number: number; state: ThreadPullRequestState } | null;
  note: string | null;
  /** The thread's latest message, as the thread list previews it. */
  lastMessage: string | null;
  boardCard: ThreadCardBoardCard | null;
  /** Whole days nobody has touched it, once it counts as idle; else null. */
  idleDays: number | null;
  /** When the thread last moved. */
  lastAt: string;
  now: number;
  /** What a screen reader hears for the whole card. */
  summary?: string;
  /** A taller height to stand in; never shorter than its content. */
  height?: number;
  /** Leave the command center for the thread in Chats. */
  onOpenInChats: () => void;
  /** Turn the node into the thread's card on the canvas, its chat under this head; absent where no card can open. */
  onToggleCard?: () => void;
  /** Open the thread's waiting question or approval from the pressed button; absent when it holds none. */
  onAnswer?: (anchor: HTMLElement) => void;
  /** What the thread holds for the user, which names that button. */
  answerKind?: 'question' | 'approval' | null;
}

export const THREAD_CARD_WIDTH = 296;

const PAD_PX = 10;
const GAP_PX = 6;
const BORDER_PX = 1;
const LINE_PX = 16;
const ROW_PX = { head: 44, note: 20, footer: 24 } as const;

const MESSAGE_WIDTH_PX = THREAD_CARD_WIDTH - PAD_PX * 2 - BORDER_PX * 2;

/** About how many characters fit one line where text cannot be measured. */
const MESSAGE_LINE_CHARS = 44;

let measureContext: CanvasRenderingContext2D | null | undefined;

/** How wide `text` runs in the card's preview font, or null where nothing can measure it. */
function textWidth(text: string): number | null {
  if (measureContext === undefined) {
    try {
      measureContext =
        typeof document === 'undefined'
          ? null
          : document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
    if (measureContext !== null && measureContext !== undefined) {
      const family = getComputedStyle(document.body).fontFamily;
      measureContext.font = `12px ${family === '' ? 'sans-serif' : family}`;
    }
  }
  return measureContext === null || measureContext === undefined
    ? null
    : measureContext.measureText(text).width;
}

/** The latest message as the card shows it: one line of plain text, or empty. */
export function previewLine(message: string | null): string {
  return message === null ? '' : plainPreview(message).replace(/`/g, '');
}

/** How many lines the preview takes: none, one, or two at most. */
export function previewLines(message: string | null): 0 | 1 | 2 {
  const text = previewLine(message);
  if (text === '') {
    return 0;
  }
  const width = textWidth(text);
  if (width === null) {
    return text.length <= MESSAGE_LINE_CHARS ? 1 : 2;
  }
  return width <= MESSAGE_WIDTH_PX ? 1 : 2;
}

/** The card's height for what it shows, so the graph can lay it out before it is drawn. */
export function threadCardHeight(view: {
  note: string | null;
  lastMessage: string | null;
}): number {
  const lines = previewLines(view.lastMessage);
  const rows = [
    ROW_PX.head,
    ...(view.note === null ? [] : [ROW_PX.note]),
    ...(lines === 0 ? [] : [lines * LINE_PX]),
    ROW_PX.footer,
  ];
  return (
    PAD_PX * 2 +
    BORDER_PX * 2 +
    rows.reduce((sum, row) => sum + row, 0) +
    GAP_PX * (rows.length - 1)
  );
}

export const THREAD_STATUS_TEXT: Record<ThreadCardStatus, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  failed: 'Failed',
  done: 'Done',
};

export const ATTENTION_TEXT: Record<ThreadAttention, string> = {
  blocked: 'Blocked',
  working: 'Working',
  question: 'Question',
  quiet: 'Quiet',
  inactive: 'Inactive a day+',
  done: 'Done',
};

const CARD_CLASS =
  'relative flex flex-col overflow-hidden rounded-card text-left shadow-sm transition-[border-color,box-shadow,opacity] duration-200 hover:shadow-md motion-reduce:transition-none';

/** Where a thread stands, as the frame around its node on the graph and its face in the working strip. */
export const attentionFrameVariants = cva('border', {
  variants: {
    attention: {
      blocked: 'border-destructive/50 bg-destructive/5',
      working: 'border-success/50 bg-success/5 cc-running-border',
      question: 'border-warning/50 bg-warning/10',
      quiet: 'border-border bg-card',
      inactive: 'border-border bg-muted/40 opacity-70 hover:opacity-100',
      done: 'border-border bg-muted/40 opacity-70 hover:opacity-100',
    } satisfies Record<ThreadAttention, string>,
  },
});

export const attentionDotVariants = cva('size-2 shrink-0 rounded-full', {
  variants: {
    attention: {
      blocked: 'bg-destructive',
      working: 'bg-success',
      question: 'bg-warning',
      quiet: 'bg-muted-foreground/60',
      inactive: 'bg-muted-foreground/30',
      done: 'bg-success/50',
    } satisfies Record<ThreadAttention, string>,
  },
});

/** Who the card's thread is, as its head and every transcript head it. */
export function threadCardIdentity(
  props: Pick<
    ThreadCardProps,
    | 'title'
    | 'face'
    | 'pullRequest'
    | 'attention'
    | 'statusText'
    | 'agentLabel'
    | 'isTeam'
    | 'boardCard'
    | 'project'
    | 'projectColor'
  >,
): ThreadIdentity {
  return {
    title: props.title,
    face: props.face,
    pullRequest: props.pullRequest,
    status: { attention: props.attention, text: props.statusText },
    agentLabel: props.agentLabel,
    isTeam: props.isTeam,
    boardCard: props.boardCard,
    project: props.project,
    projectColor: props.projectColor ?? null,
  };
}

/** Show a thread's chat on the canvas, or hide it again, from its head. */
export function ShowChatIcon({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <ThreadHeadIcon
      slot={open ? 'thread-head-hide-chat' : 'thread-head-show-chat'}
      label={open ? `Hide the chat of ${title}` : `Show the chat of ${title}`}
      title={open ? 'Hide chat' : 'Show chat'}
      icon={
        open ? (
          <ChevronUp aria-hidden="true" />
        ) : (
          <MessageSquareText aria-hidden="true" />
        )
      }
      onClick={onToggle}
    />
  );
}

/** Leave the command center for the thread in Chats — the one control on the page that does. */
export function OpenInChatsIcon({
  title,
  onOpen,
}: {
  title: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <ThreadHeadIcon
      slot="thread-head-open-in-chats"
      label={`Open ${title} in Chats`}
      title="Open in Chats"
      icon={<ArrowUpRight aria-hidden="true" />}
      onClick={onOpen}
    />
  );
}

/**
 * One thread as a card — a node of the command center's graph: the thread's
 * head (its face, title, pull request and labels), the manager's note, its
 * latest message, and a footer with when it last moved and its Show chat,
 * Archive and Open in Chats icons, kept off the title line so the title has
 * room. Its title and Show chat turn it into the thread's card on the canvas.
 */
export function ThreadCard({
  runId,
  title,
  status,
  statusText,
  attention,
  project,
  projectColor = null,
  agentLabel,
  isTeam,
  face,
  pullRequest,
  note,
  lastMessage,
  boardCard,
  idleDays,
  lastAt,
  now,
  summary,
  height,
  onOpenInChats,
  onToggleCard,
  onAnswer,
  answerKind = null,
}: ThreadCardProps): React.JSX.Element {
  const preview = previewLine(lastMessage);
  const lines = previewLines(lastMessage);
  const ownHeight = threadCardHeight({ note, lastMessage });
  const archive = useThreadArchive(runId);
  return (
    <article
      aria-label={summary ?? title}
      data-slot="thread-card"
      data-status={status}
      data-attention={attention}
      className={cn(
        CARD_CLASS,
        attentionFrameVariants({ attention }),
        onAnswer !== undefined && 'cc-breathe-warning',
      )}
      style={{
        width: THREAD_CARD_WIDTH,
        minHeight: Math.max(ownHeight, height ?? 0),
        padding: PAD_PX,
        gap: GAP_PX,
      }}>
      {projectColor === null ? null : (
        <span
          aria-hidden="true"
          data-slot="thread-card-project-stripe"
          data-color={projectColor}
          className={cn(
            'absolute inset-x-0 top-0 h-1',
            PALETTE_DOT_CLASS[projectColor],
          )}
        />
      )}
      <div className="shrink-0">
        <ThreadHead
          wrap
          slot="thread-card"
          identity={threadCardIdentity({
            title,
            face,
            pullRequest,
            attention,
            statusText,
            agentLabel,
            isTeam,
            boardCard,
            project,
            projectColor,
          })}
          onOpen={onToggleCard}
          ringClassName="ring-card"
        />
      </div>
      {note === null ? null : (
        <p
          data-slot="thread-card-note"
          title={note}
          className="h-5 shrink-0 truncate border-l-2 border-primary/50 pl-2 text-xs leading-5 text-foreground/80 italic">
          {note}
        </p>
      )}
      {lines === 0 ? null : (
        <p
          data-slot="thread-card-message"
          title={preview}
          className={cn(
            'shrink-0 text-xs leading-4 text-muted-foreground',
            lines === 1 ? 'h-4 truncate' : 'line-clamp-2 h-8',
          )}>
          {preview}
        </p>
      )}
      <div className="flex h-6 shrink-0 items-center justify-between gap-2">
        <span
          data-slot="thread-card-time"
          title={formatDateTime(lastAt)}
          className="flex min-w-0 shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {idleDays === null ? null : (
            <Moon
              aria-label={`Nobody has touched this thread for ${idleDays} days`}
              data-slot="thread-card-idle"
              className="size-3 shrink-0"
            />
          )}
          {formatRelativeTime(lastAt, now)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {archive === null || attention !== 'done' ? null : (
            <ArchiveThreadButton
              slot="thread-card-archive"
              title={title}
              onArchive={archive}
            />
          )}
          {onAnswer === undefined ? null : (
            <Button
              type="button"
              size="sm"
              data-slot="thread-card-answer"
              className="h-6 gap-1 rounded-full px-2.5 text-xs"
              onClick={(event) => onAnswer(event.currentTarget)}>
              {answerKind === 'approval' ? (
                <ShieldCheck aria-hidden="true" className="size-3.5" />
              ) : (
                <MessageCircleQuestion
                  aria-hidden="true"
                  className="size-3.5"
                />
              )}
              {answerKind === 'approval' ? 'Review' : 'Answer'}
            </Button>
          )}
          <span
            data-slot="thread-card-actions"
            className="flex items-center gap-0.5">
            {onToggleCard === undefined ? null : (
              <ShowChatIcon
                title={title}
                open={false}
                onToggle={onToggleCard}
              />
            )}
            {archive === null ? null : (
              <ArchiveThreadIcon title={title} onArchive={archive} />
            )}
            <OpenInChatsIcon title={title} onOpen={onOpenInChats} />
          </span>
        </span>
      </div>
    </article>
  );
}
