import {
  Ban,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Folder,
  Hand,
  type LucideIcon,
  MessageSquarePlus,
  Trash2,
  Users,
} from 'lucide-react';
import { useContext } from 'react';

import {
  BoardCardLabel,
  GoToThreadButton,
  type ThreadAttention,
  ThreadLabelChip,
  ThreadStatusChip,
} from '../components/thread-labels';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { RunSettledContext } from './live-row';
import { ThreadOpenContext } from './thread-message-card';
import { readThreadStart, type ThreadStart } from './thread-start-payload';
import type { ToolPair } from './transcript-groups';
import { type LiveTask, useLiveTask } from './use-live-task';

type StartState =
  | 'filing'
  | 'stopped'
  | 'awaiting-start'
  | 'starting'
  | 'started'
  | 'not-started'
  | 'refused'
  | 'removed'
  | 'filed';

const STATE_META: Record<
  StartState,
  {
    label: string;
    icon: LucideIcon | 'spinner' | null;
    attention: ThreadAttention;
    note: string | null;
  }
> = {
  filing: {
    label: 'Filing…',
    icon: 'spinner',
    attention: 'quiet',
    note: null,
  },
  stopped: {
    label: 'No result',
    icon: Ban,
    attention: 'quiet',
    note: 'The call ended before the daemon answered it.',
  },
  'awaiting-start': {
    label: 'Waiting for your Start',
    icon: Hand,
    attention: 'question',
    note: 'Answer the Start card to run it.',
  },
  starting: {
    label: 'Starting…',
    icon: 'spinner',
    attention: 'working',
    note: null,
  },
  started: {
    label: 'Started',
    icon: CircleCheck,
    attention: 'working',
    note: null,
  },
  'not-started': {
    label: 'Not started',
    icon: Ban,
    attention: 'quiet',
    note: 'The card stays in backlog.',
  },
  refused: {
    label: 'Refused',
    icon: CircleAlert,
    attention: 'blocked',
    note: null,
  },
  removed: {
    label: 'Card removed',
    icon: Trash2,
    attention: 'inactive',
    note: 'Its board card was deleted.',
  },
  filed: { label: 'Filed', icon: null, attention: 'quiet', note: null },
};

function stateOf(
  start: ThreadStart,
  task: LiveTask,
  settled: boolean,
): StartState {
  if (start.answer === null) {
    return settled ? 'stopped' : 'filing';
  }
  if (start.answer === 'refused') {
    return 'refused';
  }
  switch (task.kind) {
    case 'unread':
    case 'loading':
    case 'unreadable':
      return 'filed';
    case 'gone':
      return 'removed';
    case 'found':
      if (task.task.runId !== null) {
        return 'started';
      }
      if (task.task.startRequest === null) {
        return 'not-started';
      }
      return task.task.startRequest.approvedAt === null
        ? 'awaiting-start'
        : 'starting';
  }
}

function StateChip({ state }: { state: StartState }): React.JSX.Element {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <ThreadStatusChip
      attention={meta.attention}
      slot="thread-start-state"
      className="gap-1">
      {Icon === 'spinner' ? (
        <Spinner />
      ) : Icon === null ? null : (
        <Icon aria-hidden="true" className="size-3 shrink-0" />
      )}
      {meta.label}
    </ThreadStatusChip>
  );
}

/**
 * The thread the command center's manager started with `start_thread`, drawn
 * from its call and its result: what it is called, where and as whom it runs,
 * the board card it filed, and where that card stands now — read live from the
 * board, since the start happens after the call (the user's Start, then
 * Electron main's drain).
 */
export function ThreadStartCard({
  pair,
}: {
  pair: ToolPair;
}): React.JSX.Element {
  const settled = useContext(RunSettledContext) !== null;
  const open = useContext(ThreadOpenContext);
  const start = readThreadStart(pair);
  const task = useLiveTask(start.taskId);
  const state = stateOf(start, task, settled);
  const found = task.kind === 'found' ? task.task : null;
  const runId = found?.runId ?? null;
  const title = found?.title ?? start.title ?? 'New thread';
  const note = state === 'refused' ? start.reason : STATE_META[state].note;
  const runsAs = start.team ?? start.agent;
  const canGo = runId !== null && open !== null;
  return (
    <div
      data-slot="thread-start-card"
      data-state={state}
      className="flex min-w-0 gap-3 rounded-card border border-border bg-card p-3 text-sm shadow-panel-sm">
      <span
        aria-hidden="true"
        data-slot="thread-start-icon"
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          state === 'refused'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-primary/10 text-primary',
        )}>
        <MessageSquarePlus className="size-4.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] tracking-wide text-muted-foreground uppercase">
            New thread
          </span>
          <StateChip state={state} />
        </div>
        <p
          data-slot="thread-start-title"
          className="m-0 min-w-0 text-sm leading-5 font-semibold break-words text-foreground">
          {title}
        </p>
        <div
          data-slot="thread-start-labels"
          className="flex min-w-0 flex-wrap items-center gap-1">
          {start.identifier === null ? null : found === null ? (
            <ThreadLabelChip
              slot="thread-start-card-id"
              icon={CircleDashed}
              text={start.identifier}
              title={`Board card ${start.identifier}`}
              yields={false}
            />
          ) : (
            <BoardCardLabel
              card={{
                identifier: start.identifier,
                title,
                status: found.status,
              }}
            />
          )}
          <ThreadLabelChip
            slot="thread-start-agent"
            icon={start.team === null ? Bot : Users}
            text={runsAs ?? 'Project default'}
            title={
              start.team !== null
                ? `Team ${start.team}`
                : runsAs === null
                  ? "The project's default agent or team"
                  : `Agent ${runsAs}`
            }
            yields={false}
          />
          {start.project === null ? null : (
            <ThreadLabelChip
              slot="thread-start-project"
              icon={Folder}
              text={start.project}
              title={`Project ${start.project}`}
              yields
            />
          )}
        </div>
        {note === null && !canGo ? null : (
          <div className="flex min-w-0 items-center justify-between gap-2">
            {note === null ? (
              <span />
            ) : (
              <p
                data-slot="thread-start-note"
                className={cn(
                  'm-0 min-w-0 text-xs break-words',
                  state === 'refused'
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}>
                {note}
              </p>
            )}
            {canGo ? <GoToThreadButton onGo={() => open(runId)} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}
