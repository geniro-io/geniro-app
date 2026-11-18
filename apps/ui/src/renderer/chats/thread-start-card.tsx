import {
  ArrowUpRight,
  Ban,
  Bot,
  CircleAlert,
  CircleCheck,
  FolderKanban,
  Hand,
  ListPlus,
  type LucideIcon,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useContext } from 'react';

import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { TaskChip } from '../tasks/task-chip';
import { taskStatusMeta } from '../tasks/task-status';
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
  { label: string; icon: LucideIcon | null; className: string }
> = {
  filing: { label: 'Filing…', icon: null, className: 'text-muted-foreground' },
  stopped: {
    label: 'No result',
    icon: Ban,
    className: 'text-muted-foreground',
  },
  'awaiting-start': {
    label: 'Waiting for your Start',
    icon: Hand,
    className: 'text-warning',
  },
  starting: { label: 'Starting…', icon: null, className: 'text-primary' },
  started: { label: 'Started', icon: CircleCheck, className: 'text-success' },
  'not-started': {
    label: 'Not started',
    icon: Ban,
    className: 'text-muted-foreground',
  },
  refused: {
    label: 'Refused',
    icon: CircleAlert,
    className: 'text-destructive',
  },
  removed: {
    label: 'Card removed',
    icon: Trash2,
    className: 'text-muted-foreground',
  },
  filed: { label: 'Filed', icon: null, className: 'text-muted-foreground' },
};

const STATE_NOTE: Partial<Record<StartState, string>> = {
  stopped: 'The call ended before the daemon answered it.',
  'awaiting-start': 'Answer the Start card to run it.',
  'not-started': 'The card stays in backlog.',
  removed: 'Its board card was deleted.',
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

function StateLine({ state }: { state: StartState }): React.JSX.Element {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <span
      data-slot="thread-start-state"
      data-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-xs font-medium',
        meta.className,
      )}>
      {Icon === null ? (
        state === 'filing' || state === 'starting' ? (
          <Spinner />
        ) : null
      ) : (
        <Icon aria-hidden="true" className="size-3.5" />
      )}
      {meta.label}
    </span>
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
  const column =
    state === 'started' && found !== null ? taskStatusMeta(found.status) : null;
  const note = state === 'refused' ? start.reason : (STATE_NOTE[state] ?? null);
  return (
    <div
      data-slot="thread-start-card"
      data-state={state}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm shadow-panel-sm">
      <div className="flex min-w-0 items-center gap-2">
        <ListPlus
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          New thread
        </span>
        <span className="flex-1" />
        <StateLine state={state} />
      </div>
      <p
        data-slot="thread-start-title"
        className="m-0 min-w-0 font-medium break-words text-foreground">
        {title}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {start.identifier === null ? null : (
          <TaskChip title="Board card" className="font-mono text-foreground/80">
            {start.identifier}
          </TaskChip>
        )}
        {start.project === null ? null : (
          <TaskChip title="Project">
            <FolderKanban aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{start.project}</span>
          </TaskChip>
        )}
        <TaskChip title={start.team === null ? 'Agent' : 'Team'}>
          {start.team === null ? (
            <Bot aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <UsersRound aria-hidden="true" className="size-3 shrink-0" />
          )}
          <span className="truncate">
            {start.team ?? start.agent ?? 'Project default'}
          </span>
        </TaskChip>
        {column === null ? null : (
          <TaskChip title="Board column">
            <column.icon
              aria-hidden="true"
              className={cn('size-3 shrink-0', column.className)}
            />
            {column.label}
          </TaskChip>
        )}
      </div>
      {note === null && runId === null ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {note === null ? null : (
            <p
              data-slot="thread-start-note"
              className={cn(
                'm-0 min-w-0 flex-1 text-xs break-words',
                state === 'refused'
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}>
              {note}
            </p>
          )}
          {runId === null || open === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-slot="thread-start-open"
              title="Open this thread"
              onClick={() => open(runId)}>
              Open thread
              <ArrowUpRight aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
