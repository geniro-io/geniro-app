import { PictureInPicture2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { HoverPopover } from '../components/hover-popover';
import { ThreadHead, type ThreadIdentity } from '../components/thread-head';
import { Button } from '../components/ui/button';
import { popoverSurface } from '../components/ui/popover';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { plainMarkdownText } from './brief-text';
import { formatDateTime, formatRelativeTime } from './relative-time';
import { CallGlyph, SubagentGlyph, TerminalGlyph } from './shelf-glyphs';
import {
  AgentsTile,
  type AgentsTileFace,
  CONTROL_HOVER,
} from './working-card-parts';

/** Work a settled thread still has out: a held turn, background sub-agents, detached commands. */
export interface WorkingThreadBackground {
  held: boolean;
  subagents: number;
  commands: number;
}

export interface WorkingThread {
  runId: string;
  /** The thread as its node on the graph shows it. */
  identity: ThreadIdentity;
  status: 'working' | 'waiting';
  lastMessage: string | null;
  /** When the thread last moved. */
  lastAt: string;
  background: WorkingThreadBackground;
}

type ThreadStatus = WorkingThread['status'];

const GROUPS: readonly { status: ThreadStatus; title: string; rail: string }[] =
  [
    { status: 'waiting', title: 'Waiting on you', rail: 'border-warning/50' },
    { status: 'working', title: 'Working', rail: 'border-success/50' },
  ];

/**
 * Marks the element the panel may rise to: the top of the page's body, under
 * its header. The panel's list never grows past it.
 */
export const WORKING_THREADS_CEILING = 'data-working-threads-ceiling';

const LIST_MAX_PX = 480;
const PANEL_HEAD_PX = 44;
const CEILING_GAP_PX = 8;

/** A press that lands on a control of its own inside an openable row. */
function pressedOwnControl(event: React.MouseEvent): boolean {
  const control =
    event.target instanceof Element ? event.target.closest('button, a') : null;
  return control !== null && control !== event.currentTarget;
}

function tileFace(thread: WorkingThread): AgentsTileFace {
  return {
    name: thread.identity.agentLabel ?? thread.identity.title,
    colorKey: thread.identity.agentLabel ?? thread.runId,
  };
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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the thread still has running after its turn, one glyph and count each. */
function ThreadBackground({
  background,
}: {
  background: WorkingThreadBackground;
}): React.JSX.Element | null {
  if (
    !background.held &&
    background.subagents === 0 &&
    background.commands === 0
  ) {
    return null;
  }
  const item = 'inline-flex shrink-0 items-center gap-1';
  return (
    <div
      data-slot="working-thread-background"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-[42px] text-[11px] text-muted-foreground">
      {background.held ? (
        <span data-slot="working-thread-held" className={item}>
          <CallGlyph live className="size-3.5 text-primary" />
          Turn held for background work
        </span>
      ) : null}
      {background.subagents === 0 ? null : (
        <span data-slot="working-thread-subagents" className={item}>
          <SubagentGlyph live className="size-3.5" />
          {plural(background.subagents, 'sub-agent', 'sub-agents')}
        </span>
      )}
      {background.commands === 0 ? null : (
        <span data-slot="working-thread-commands" className={item}>
          <TerminalGlyph live className="size-3.5" />
          {plural(background.commands, 'command', 'commands')}
        </span>
      )}
    </div>
  );
}

function ThreadMessage({
  thread,
  rail,
}: {
  thread: WorkingThread;
  rail: string;
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
      className={cn('ml-[42px] border-l-2 pl-3', rail)}>
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
  rail,
  now,
  onOpenThread,
  onOpenHere,
}: {
  thread: WorkingThread;
  rail: string;
  now: number;
  onOpenThread?: (runId: string) => void;
  onOpenHere?: (runId: string) => void;
}): React.JSX.Element {
  const open =
    onOpenThread === undefined ? undefined : () => onOpenThread(thread.runId);
  return (
    <div
      data-slot="working-thread-row"
      data-run={thread.runId}
      data-status={thread.status}
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
        'flex min-w-0 flex-col gap-2 rounded-lg px-2.5 py-2',
        open !== undefined && 'cursor-pointer',
        open !== undefined && CONTROL_HOVER,
      )}>
      <ThreadHead
        identity={thread.identity}
        slot="working-thread"
        onOpen={open}
        ringClassName="ring-popover"
        aside={
          <>
            <span
              data-slot="working-thread-time"
              title={formatDateTime(thread.lastAt)}
              className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
              {formatRelativeTime(thread.lastAt, now)}
            </span>
            {onOpenHere === undefined ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-slot="working-thread-open-here"
                className="size-6 text-muted-foreground hover:text-foreground"
                aria-label={`Open ${thread.identity.title} here`}
                title="Open in a window over the graph"
                onClick={() => onOpenHere(thread.runId)}>
                <PictureInPicture2 aria-hidden="true" className="size-3.5" />
              </Button>
            )}
          </>
        }
      />
      <ThreadBackground background={thread.background} />
      <ThreadMessage thread={thread} rail={rail} />
    </div>
  );
}

/** How tall the list may grow under the panel's head before it reaches the ceiling. */
function listRoom(section: HTMLElement | null): number {
  if (section === null) {
    return LIST_MAX_PX;
  }
  const ceiling = section.closest(`[${WORKING_THREADS_CEILING}]`);
  const top = ceiling === null ? 0 : ceiling.getBoundingClientRect().top;
  const room =
    section.getBoundingClientRect().top - top - PANEL_HEAD_PX - CEILING_GAP_PX;
  return Math.max(120, Math.min(LIST_MAX_PX, room));
}

export function WorkingThreadsCard({
  threads,
  onOpenThread,
  onOpenHere,
}: {
  threads: readonly WorkingThread[];
  onOpenThread?: (runId: string) => void;
  /** Open a thread in a window over the command center's graph. */
  onOpenHere?: (runId: string) => void;
}): React.JSX.Element | null {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [opened, setOpened] = useState({ room: LIST_MAX_PX, now: 0 });
  const onOpenChange = useLatestCallback((open: boolean) => {
    if (open) {
      setOpened({ room: listRoom(sectionRef.current), now: Date.now() });
    }
  }, []);
  const lead =
    threads.find((thread) => thread.status === 'working') ?? threads[0];
  if (lead === undefined) {
    return null;
  }
  const summary = threadsSummary(threads);
  const anyWorking = threads.some((thread) => thread.status === 'working');
  return (
    <section
      ref={sectionRef}
      data-slot="working-threads-card"
      aria-label="Threads working"
      className={cn(
        popoverSurface,
        'pointer-events-auto relative z-20 flex flex-col',
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
        panelClassName="w-[26rem] p-0"
        onOpenChange={onOpenChange}
        trigger={
          <AgentsTile
            face={tileFace(lead)}
            others={threads.length - 1}
            activity={anyWorking ? 'working' : 'waiting'}
          />
        }>
        <div className="flex flex-col">
          <div className="flex h-11 min-w-0 items-center gap-2 px-3">
            <CallGlyph
              live={anyWorking}
              className={cn('size-3.5 shrink-0', anyWorking && 'text-primary')}
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
          <div
            data-slot="working-threads-list"
            style={{ maxHeight: opened.room }}
            className="flex flex-col gap-2 overflow-y-auto border-t border-border/60 p-1.5">
            {GROUPS.map((group) => {
              const members = threads.filter(
                (thread) => thread.status === group.status,
              );
              return members.length === 0 ? null : (
                <section
                  key={group.status}
                  data-slot="working-threads-group"
                  data-status={group.status}
                  aria-label={group.title}
                  className="flex flex-col gap-0.5">
                  <h3 className="flex items-center gap-1.5 px-2.5 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {group.title}
                    <span className="tabular-nums">{members.length}</span>
                  </h3>
                  {members.map((thread) => (
                    <ThreadRow
                      key={thread.runId}
                      thread={thread}
                      rail={group.rail}
                      now={
                        opened.now === 0
                          ? Date.parse(thread.lastAt)
                          : opened.now
                      }
                      onOpenThread={onOpenThread}
                      onOpenHere={onOpenHere}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      </HoverPopover>
    </section>
  );
}
