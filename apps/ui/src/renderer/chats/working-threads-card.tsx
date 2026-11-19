import { Folder } from 'lucide-react';

import type { ProfileColor } from '../../shared/contracts';
import { HoverPopover } from '../components/hover-popover';
import {
  type AvatarPerson,
  AvatarStack,
  MemberAvatar,
} from '../components/member-avatar';
import { StatusDot } from '../components/status-dot';
import { ThreadLabelChip } from '../components/thread-labels';
import { PaletteDot } from '../components/ui/palette-dot';
import { popoverSurface } from '../components/ui/popover';
import { cn } from '../components/ui/utils';
import { plainMarkdownText } from './brief-text';
import { CallGlyph } from './shelf-glyphs';
import {
  AgentsTile,
  type AgentsTileFace,
  CONTROL_HOVER,
} from './working-card-parts';

export interface WorkingThread {
  runId: string;
  title: string;
  agentLabel: string | null;
  agentKind: string | null;
  crew: { people: readonly AvatarPerson[]; total: number } | null;
  project: string | null;
  projectColor: ProfileColor | null;
  lastMessage: string | null;
  status: 'working' | 'waiting';
}

type ThreadStatus = WorkingThread['status'];

const STATE_LOOK: Record<
  ThreadStatus,
  { word: string; pill: string; rail: string }
> = {
  working: {
    word: 'working',
    pill: 'bg-success/15 text-success',
    rail: 'border-success/50',
  },
  waiting: {
    word: 'waiting on you',
    pill: 'bg-warning/15 text-warning',
    rail: 'border-warning/50',
  },
};

const RIGHT_OF_AGENTS_CARD = 'right-14';
const IN_THE_CORNER = 'right-4';

/** A press that lands on a control of its own inside an openable row. */
function pressedOwnControl(event: React.MouseEvent): boolean {
  const control =
    event.target instanceof Element ? event.target.closest('button, a') : null;
  return control !== null && control !== event.currentTarget;
}

function threadFace(thread: WorkingThread): AgentsTileFace {
  const agent = thread.agentLabel ?? thread.agentKind;
  if (agent === null) {
    return {
      name: thread.title,
      colorKey: thread.runId,
      avatar: {
        kind: 'initials',
        value: thread.title.trim().charAt(0).toUpperCase(),
      },
    };
  }
  return { name: agent, colorKey: thread.agentKind ?? thread.runId };
}

function threadsSummary(threads: readonly WorkingThread[]): string {
  const working = threads.filter((thread) => thread.status === 'working');
  const waiting = threads.length - working.length;
  const words: string[] = [];
  if (working.length > 0) {
    words.push(`${working.length} working`);
  }
  if (waiting > 0) {
    words.push(`${waiting} waiting on you`);
  }
  return words.join(' · ');
}

function ThreadStatusDot({
  status,
}: {
  status: ThreadStatus;
}): React.JSX.Element {
  if (status === 'waiting') {
    return (
      <span
        data-slot="working-thread-dot"
        data-status={status}
        className="flex shrink-0">
        <StatusDot tone="warn" className="size-1.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-slot="working-thread-dot"
      data-status={status}
      className="relative flex size-1.5 shrink-0">
      <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
      <span className="relative size-1.5 rounded-full bg-success" />
    </span>
  );
}

function ThreadFace({ thread }: { thread: WorkingThread }): React.JSX.Element {
  if (thread.crew !== null && thread.crew.people.length > 0) {
    return (
      <span
        data-slot="working-thread-crew"
        aria-label={`${thread.crew.total} members`}
        className="shrink-0">
        <AvatarStack
          size={24}
          max={3}
          total={thread.crew.total}
          people={thread.crew.people}
          ringClassName="ring-popover"
        />
      </span>
    );
  }
  const face = threadFace(thread);
  return (
    <MemberAvatar
      size={24}
      name={face.name}
      colorKey={face.colorKey}
      avatar={face.avatar}
    />
  );
}

function ThreadHead({
  thread,
  onOpen,
}: {
  thread: WorkingThread;
  onOpen?: () => void;
}): React.JSX.Element {
  const content = (
    <>
      <ThreadFace thread={thread} />
      <span
        data-slot="working-thread-title"
        title={thread.title}
        className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-semibold break-words text-foreground">
        {thread.title}
      </span>
    </>
  );
  const layout = 'flex min-w-0 items-start gap-2.5';
  if (onOpen === undefined) {
    return <div className={layout}>{content}</div>;
  }
  return (
    <button
      type="button"
      data-slot="working-thread-open"
      title={`Open ${thread.title}`}
      onClick={onOpen}
      className={cn(
        layout,
        'rounded-sm text-left font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}>
      {content}
    </button>
  );
}

function ThreadFacts({ thread }: { thread: WorkingThread }): React.JSX.Element {
  const look = STATE_LOOK[thread.status];
  return (
    <div
      data-slot="working-thread-facts"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
      <span
        data-slot="working-thread-state"
        data-status={thread.status}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-medium',
          look.pill,
        )}>
        <ThreadStatusDot status={thread.status} />
        {look.word}
      </span>
      {thread.agentLabel === null ? null : (
        <span data-slot="working-thread-agent" className="min-w-0 truncate">
          {thread.agentLabel}
        </span>
      )}
      {thread.project === null ? null : (
        <ThreadLabelChip
          slot="working-thread-project"
          icon={Folder}
          mark={
            thread.projectColor === null ? undefined : (
              <PaletteDot
                color={thread.projectColor}
                size="md"
                data-slot="working-thread-project-dot"
              />
            )
          }
          text={thread.project}
          title={`Project ${thread.project}`}
          yields
        />
      )}
    </div>
  );
}

function ThreadMessage({
  thread,
}: {
  thread: WorkingThread;
}): React.JSX.Element | null {
  const message =
    thread.lastMessage === null
      ? ''
      : plainMarkdownText(thread.lastMessage).trim();
  if (message === '') {
    return null;
  }
  return (
    <div
      data-slot="working-thread-rail"
      className={cn('border-l-2 pl-3', STATE_LOOK[thread.status].rail)}>
      <span
        data-slot="working-thread-message"
        title={message}
        className="line-clamp-2 text-xs/relaxed text-muted-foreground">
        {message}
      </span>
    </div>
  );
}

function ThreadRow({
  thread,
  onOpenThread,
}: {
  thread: WorkingThread;
  onOpenThread?: (runId: string) => void;
}): React.JSX.Element {
  const open =
    onOpenThread === undefined ? undefined : () => onOpenThread(thread.runId);
  return (
    <div
      data-slot="working-thread-row"
      data-run={thread.runId}
      onClick={
        open === undefined
          ? undefined
          : (event) => {
              if (!pressedOwnControl(event)) {
                open();
              }
            }
      }
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg bg-accent/40 p-2.5',
        open !== undefined && 'cursor-pointer',
        open !== undefined && CONTROL_HOVER,
      )}>
      <ThreadHead thread={thread} onOpen={open} />
      <ThreadFacts thread={thread} />
      <ThreadMessage thread={thread} />
    </div>
  );
}

export function WorkingThreadsCard({
  threads,
  onOpenThread,
  beside,
}: {
  threads: readonly WorkingThread[];
  onOpenThread?: (runId: string) => void;
  beside: boolean;
}): React.JSX.Element | null {
  const lead =
    threads.find((thread) => thread.status === 'working') ?? threads[0];
  if (lead === undefined) {
    return null;
  }
  const summary = threadsSummary(threads);
  const anyWorking = threads.some((thread) => thread.status === 'working');
  return (
    <div className="pointer-events-none relative z-20 h-0 w-full overflow-visible">
      <section
        data-slot="working-threads-card"
        aria-label="Threads working"
        className={cn(
          popoverSurface,
          'pointer-events-auto -bottom-2 z-20 flex flex-col',
          beside ? RIGHT_OF_AGENTS_CARD : IN_THE_CORNER,
        )}>
        <HoverPopover
          slot="working-threads-toggle"
          label={`Threads working · ${summary}`}
          panelLabel="Threads working"
          side="top"
          className="shrink-0"
          triggerClassName={cn(
            'group relative min-w-0 rounded-xl text-left font-normal',
            CONTROL_HOVER,
          )}
          panelClassName="w-96 p-0"
          trigger={
            <span className="flex items-center gap-2 py-1 pr-2 pl-1">
              <AgentsTile
                face={threadFace(lead)}
                others={threads.length - 1}
                activity={anyWorking ? 'working' : 'waiting'}
              />
              <span
                data-slot="working-threads-count"
                className="text-xs whitespace-nowrap text-foreground tabular-nums">
                {summary}
              </span>
            </span>
          }>
          <div className="flex flex-col">
            <div className="flex min-w-0 items-center gap-2 px-3 py-2">
              <CallGlyph
                live={anyWorking}
                className={cn(
                  'size-3.5 shrink-0',
                  anyWorking && 'text-primary',
                )}
              />
              <span className="shrink-0 text-sm font-semibold text-foreground">
                Threads working
              </span>
              <span
                data-slot="working-threads-panel-summary"
                className="min-w-0 truncate text-xs text-muted-foreground">
                {summary}
              </span>
            </div>
            <div className="flex max-h-[min(60vh,32rem)] flex-col gap-1.5 overflow-y-auto border-t border-border/60 p-1.5">
              {threads.map((thread) => (
                <ThreadRow
                  key={thread.runId}
                  thread={thread}
                  onOpenThread={onOpenThread}
                />
              ))}
            </div>
          </div>
        </HoverPopover>
      </section>
    </div>
  );
}
