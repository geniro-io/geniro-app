import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  ListChecks,
} from 'lucide-react';
import { useContext } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import { RunSettledContext } from './live-row';
import {
  type AgentTaskRow,
  taskProgress,
  type TaskStatus,
} from './task-payload';
import { taskCardIsLive, type TaskListEntry } from './transcript-groups';

/**
 * The agent's own task list, rendered.
 *
 * Two surfaces over one row renderer: the {@link TaskListCard} the transcript
 * shows where the list moved, and the side panel's copy of the CURRENT list
 * ({@link TaskRows} + {@link TaskCount}, composed in `agents-panel.tsx` beside
 * that agent's threads). They must agree glyph for glyph, which is what the
 * shared row renderer is for.
 */

const STATUS_ICON: Record<
  TaskStatus,
  React.ComponentType<{ className?: string }>
> = {
  completed: CircleCheck,
  // A task the agent says it is ON is the one thing in the list that is
  // happening, so it spins — but only while something is actually working
  // through the list. See `live`.
  in_progress: Spinner,
  pending: Circle,
};

const STATUS_CLASS: Record<TaskStatus, string> = {
  completed: 'text-success',
  in_progress: 'text-primary',
  pending: 'text-muted-foreground',
};

/**
 * The in-progress glyph for a list nothing is working through any more.
 *
 * A half-drawn ring rather than `pending`'s plain one, because the two states
 * are different: the agent STARTED this task and stopped there. Drawing it as
 * pending would report the work as untouched, and leaving the spinner on it is
 * the defect this exists to remove — a list that ended mid-task span forever,
 * exactly as the sub-agent blocks used to.
 */
const STALLED_ICON = CircleDotDashed;

function TaskRow({
  task,
  live,
}: {
  task: AgentTaskRow;
  live: boolean;
}): React.JSX.Element {
  // A status the daemon could not name gets a glyph of its own rather than
  // borrowing `pending`'s: the CLI moved this task somewhere, and drawing it as
  // not-yet-started would state the opposite.
  const Icon =
    task.status === null
      ? CircleDashed
      : task.status === 'in_progress' && !live
        ? STALLED_ICON
        : STATUS_ICON[task.status];
  const tone =
    task.status === null ? 'text-muted-foreground' : STATUS_CLASS[task.status];
  return (
    <li className="flex items-start gap-2 text-xs leading-relaxed">
      <Icon
        aria-hidden="true"
        className={cn('mt-0.5 size-3.5 shrink-0', tone)}
      />
      <span
        className={cn(
          'min-w-0 break-words',
          task.status === 'completed' && 'text-muted-foreground line-through',
          task.status === 'in_progress' && 'font-medium text-foreground',
        )}>
        {/* The present-continuous label when the CLI sends one and the task is
            the one running — which is what the agent's own UI shows there. Only
            while it is live: "Editing the file" about a list nobody is advancing
            reads as a claim that the edit is under way. */}
        {task.status === 'in_progress' && live && task.activeForm !== null
          ? task.activeForm
          : (task.title ??
            // A task first seen in a patch that carried no text: the id is all
            // that is known, and saying so beats an empty row.
            `Task ${task.id}`)}
      </span>
    </li>
  );
}

export function TaskRows({
  tasks,
  live = true,
  className,
}: {
  tasks: readonly AgentTaskRow[];
  /**
   * Whether anything is still working through this list. False stops the
   * in-progress row spinning — a settled turn, and a HISTORICAL card, are both
   * lists nobody is advancing.
   */
  live?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <ul className={cn('m-0 flex list-none flex-col gap-1 p-0', className)}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} live={live} />
      ))}
    </ul>
  );
}

/** `2/5` — said the same way wherever a list is summarized. */
export function TaskCount({
  done,
  total,
}: {
  done: number;
  total: number;
}): React.JSX.Element {
  return (
    <span className="tabular-nums">
      {done}/{total}
    </span>
  );
}

/** The `ListChecks` glyph, so the panel and the blocks mark tasks alike. */
export function TaskIcon({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <ListChecks
      aria-hidden="true"
      className={cn('size-3 shrink-0', className)}
    />
  );
}

/**
 * The transcript card: the list as it stood after one burst of work on it.
 *
 * This is what replaced the tool row the ticket was about — `TaskUpdate` in a
 * collapsed tool group on claude, an argument-free `Update TODOs` on cursor.
 *
 * It reads its own liveness rather than taking it as a prop, from the same
 * context `SubagentBlock` reads for the same question: only the LATEST card of a
 * thread can be live, and only while the run has not settled past it.
 */
export function TaskListCard({
  entry,
}: {
  entry: TaskListEntry;
}): React.JSX.Element | null {
  const runSettledAt = useContext(RunSettledContext);
  if (entry.tasks.length === 0) {
    return null;
  }
  const { done, total } = taskProgress(entry.tasks);
  const live = taskCardIsLive(entry, runSettledAt);
  return (
    <div
      data-slot="task-list-card"
      // Stated on the element because it is not derivable from the outside: the
      // rule reads a context value and the card's own place in the thread, so a
      // test (and anyone with the inspector open) has no other way to see which
      // way it went.
      data-live={live}
      className="min-w-0">
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <TaskIcon />
          Task list
          <span className="text-muted-foreground">
            · <TaskCount done={done} total={total} />
          </span>
        </span>
      </SectionLabel>
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <TaskRows tasks={entry.tasks} live={live} />
      </div>
    </div>
  );
}
