import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  ListChecks,
} from 'lucide-react';
import { useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import {
  type AgentTaskRow,
  taskProgress,
  type TaskStatus,
} from './task-payload';

/**
 * The agent's own task list, rendered.
 *
 * Two surfaces over one row renderer: the {@link TaskListCard} the transcript
 * shows where the list moved, and the {@link TaskStrip} pinned above the
 * composer showing where it stands NOW. They must agree glyph for glyph — the
 * strip is the same list — which is what the shared {@link TaskRows} is for.
 */

const STATUS_ICON: Record<
  TaskStatus,
  React.ComponentType<{ className?: string }>
> = {
  completed: CircleCheck,
  // Never a static glyph: a task the agent says it is ON is the one thing in
  // the list that is happening, and it reads as an ordinary row without the
  // motion. It is also the only signal that the list is live at all.
  in_progress: Spinner,
  pending: Circle,
};

const STATUS_CLASS: Record<TaskStatus, string> = {
  completed: 'text-success',
  in_progress: 'text-primary',
  pending: 'text-muted-foreground',
};

function TaskRow({ task }: { task: AgentTaskRow }): React.JSX.Element {
  // A status the daemon could not name gets a glyph of its own rather than
  // borrowing `pending`'s: the CLI moved this task somewhere, and drawing it as
  // not-yet-started would state the opposite.
  const Icon = task.status === null ? CircleDashed : STATUS_ICON[task.status];
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
            the one running — which is what the agent's own UI shows there. */}
        {task.status === 'in_progress' && task.activeForm !== null
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
  className,
}: {
  tasks: readonly AgentTaskRow[];
  className?: string;
}): React.JSX.Element {
  return (
    <ul className={cn('m-0 flex list-none flex-col gap-1 p-0', className)}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
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

/**
 * The transcript card: the list as it stood after one burst of work on it.
 *
 * This is what replaced the tool row the ticket was about — `TaskUpdate` in a
 * collapsed tool group on claude, an argument-free `Update TODOs` on cursor.
 */
export function TaskListCard({
  tasks,
}: {
  tasks: readonly AgentTaskRow[];
}): React.JSX.Element | null {
  if (tasks.length === 0) {
    return null;
  }
  const { done, total } = taskProgress(tasks);
  return (
    <div data-slot="task-list-card" className="min-w-0">
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <ListChecks aria-hidden="true" className="size-3" />
          Task list
          <span className="text-muted-foreground">
            · <TaskCount done={done} total={total} />
          </span>
        </span>
      </SectionLabel>
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <TaskRows tasks={tasks} />
      </div>
    </div>
  );
}

/**
 * The list as it stands NOW, pinned above the composer.
 *
 * The transcript cards are history — they scroll away, and the ticket's actual
 * ask was to be able to READ the current list somewhere. Collapsed by default so
 * it costs one line, but that line carries the count and the task being worked
 * on, so the current state is legible without opening it.
 */
export function TaskStrip({
  tasks,
  className,
}: {
  tasks: readonly AgentTaskRow[];
  className?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) {
    return null;
  }
  const { done, total, current } = taskProgress(tasks);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div
      data-slot="task-strip"
      className={cn(
        'rounded-xl border border-border bg-muted/40 px-3 py-2',
        className,
      )}>
      <button
        type="button"
        aria-expanded={open}
        aria-label="The agent's task list"
        className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((value) => !value)}>
        <Chevron aria-hidden="true" className="size-3.5 shrink-0" />
        <ListChecks aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">Tasks</span>
        <TaskCount done={done} total={total} />
        {current !== null ? (
          <span className="min-w-0 flex-1 truncate">
            · {current.activeForm ?? current.title ?? `Task ${current.id}`}
          </span>
        ) : null}
      </button>
      {open ? <TaskRows tasks={tasks} className="mt-2 pl-1" /> : null}
    </div>
  );
}
