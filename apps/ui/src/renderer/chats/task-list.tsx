import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  ListChecks,
} from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { revealWithinBox } from '../scroll-to-bottom';
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
    <li
      // The row's own state, on the element. It is what {@link TaskScrollRows}
      // finds the row to follow by — and it is not derivable from the outside,
      // since the drawn state folds `live` into the payload's own status.
      data-task-status={task.status ?? 'unknown'}
      className="flex items-start gap-2 text-xs leading-relaxed">
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

/**
 * How tall the side panel's copy of a list may get before it scrolls itself.
 *
 * REPORTED as "also we need scroll for tasks list", against a card holding
 * thirteen tasks: the panel has one scroller over every agent card, so a long
 * list does not overflow — it makes its own card that tall, and everything
 * below it (the next agent, the artifacts) is pushed a screen down. Measured on
 * the reported list, the card ran past 1,000px in a 825px window with nothing
 * else of that agent visible.
 *
 * 12rem ≈ eight one-line rows, or four that wrap — enough that a short list is
 * untouched by this (a cap costs nothing until it is reached) and a long one
 * still shows several rows of context around whatever is running.
 */
const PANEL_LIST_MAX_HEIGHT = 'max-h-48';

/**
 * The same rows, bounded and scrolling themselves, following the task that is
 * RUNNING.
 *
 * The following is what makes the bound safe rather than merely tidy: a list of
 * thirteen with the sixth in progress would otherwise show the five that are
 * done and hide the one thing happening, which is a worse answer than the tall
 * card. It moves only when the active row leaves the frame, so a reader who
 * scrolled the box themselves keeps their place — see {@link revealWithinBox},
 * and note that `scrollIntoView` is not an option here for the reason recorded
 * there: this box sits inside the panel's scroller inside a clipped shell.
 *
 * Not used by {@link TaskListCard}. The transcript is a document a reader
 * scrolls, and a nested scroll box in it takes the wheel away from the page for
 * as long as the pointer is over the list.
 */
export function TaskScrollRows({
  tasks,
  live,
  className,
}: {
  tasks: readonly AgentTaskRow[];
  live: boolean;
  className?: string;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // The id, not the row: the effect must fire when the agent MOVES ON to the
  // next task, and re-running it on every re-render would drag a box the reader
  // had scrolled back to where the work is.
  const activeId =
    tasks.find((task) => task.status === 'in_progress')?.id ?? null;
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || activeId === null || !live) {
      return;
    }
    const row = box.querySelector<HTMLElement>(
      '[data-task-status="in_progress"]',
    );
    if (row === null) {
      return;
    }
    const top = revealWithinBox(box, row);
    if (top !== null) {
      box.scrollTop = top;
    }
  }, [activeId, live]);
  return (
    <div
      ref={boxRef}
      data-slot="task-scroll-rows"
      className={cn(
        // `relative` is load-bearing, not decoration: the reveal above reads
        // each row's `offsetTop`, which is measured against the nearest
        // POSITIONED ancestor — without it the numbers belong to some box
        // further up the tree and the arithmetic silently addresses the wrong
        // element.
        'relative overflow-y-auto overscroll-contain',
        PANEL_LIST_MAX_HEIGHT,
      )}>
      <TaskRows tasks={tasks} live={live} className={className} />
    </div>
  );
}

/** One agent's task set, as a surface that draws several of them at once. */
export interface AgentTaskGroup {
  /** The agent card's id — the React key, and what the caller grouped by. */
  agentId: string;
  /** What to call that agent on screen. */
  agentName: string;
  tasks: readonly AgentTaskRow[];
}

/**
 * Several agents' task sets, one BLOCK each under the name of the agent that
 * keeps it.
 *
 * REPORTED against a workflow run: "if we working with workflows - each task
 * set should be inside popover in block related to its connected agent". The
 * shelf chip flattened every agent's rows into one run, so a Manager's four
 * tasks and an Engineer's nine arrived as thirteen rows with nothing between
 * them — and the two lists are not one list: they are two agents' plans, each
 * complete on its own, and read end to end they say neither.
 *
 * Each block keeps its OWN bounded scroller ({@link TaskScrollRows}) rather
 * than the panel holding one over all of them, which is what makes a block
 * readable: the follow lands each set on the row that agent is working, so a
 * long list belonging to one agent cannot push another's off the panel. It is
 * the arrangement the agents panel already draws — a card per agent, each with
 * its own scrolling list — so the popover and the column agree.
 *
 * A group's own `done/total` sits on its heading for the reason the chip's
 * does: a bare set of rows says nothing about how far through it that agent is,
 * and the shelf's figure is the SUM across every agent, which answers a
 * different question.
 *
 * The heading is drawn for every group INCLUDING a lone one. Whether the
 * grouping happens at all is the caller's decision (a workflow, never a 1:1
 * chat — the same gate the terminals chip's labels take), so a run whose only
 * task list happens to belong to one node still says whose it is.
 */
export function TaskGroupRows({
  groups,
  live,
}: {
  groups: readonly AgentTaskGroup[];
  /**
   * Whether anything is still working through these lists — the RUN's own
   * liveness, exactly as the flat list takes it.
   */
  live: boolean;
}): React.JSX.Element {
  return (
    <div data-slot="task-groups" className="flex flex-col gap-3">
      {groups.map((group) => {
        const progress = taskProgress(group.tasks);
        return (
          <section key={group.agentId} data-slot="task-group">
            <SectionLabel>
              <span className="flex items-baseline gap-2">
                <span
                  data-slot="task-group-agent"
                  className="min-w-0 flex-1 truncate">
                  {group.agentName}
                </span>
                <span className="shrink-0 normal-case tabular-nums">
                  <TaskCount done={progress.done} total={progress.total} />
                </span>
              </span>
            </SectionLabel>
            <TaskScrollRows tasks={group.tasks} live={live} />
          </section>
        );
      })}
    </div>
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
 *
 * **Only the latest card of a thread shows its rows.** An agent that says a
 * sentence between two announcements gets a card on each side of it, and both
 * printed the whole list — eight rows, then eight rows again with one more
 * spinner, one paragraph apart. That is the reported "Todo is duplicating":
 * there is one list, and the transcript was reprinting it wholesale every time
 * a single row moved. A superseded card collapses to the line it already had —
 * the count and the task that was running then — which is the history the
 * chronological placement is FOR, without the wall of repeated rows.
 *
 * The open state is DERIVED from `latest` with a manual override on top, not
 * seeded into `useState`: an initial value would only apply at mount, so the
 * card that was latest when it mounted would stay expanded forever and the
 * duplication would come straight back on the next announcement. Once a reader
 * has opened or closed one by hand, their choice sticks.
 */
export function TaskListCard({
  entry,
}: {
  entry: TaskListEntry;
}): React.JSX.Element | null {
  const runSettledAt = useContext(RunSettledContext);
  const [override, setOverride] = useState<boolean | null>(null);
  if (entry.tasks.length === 0) {
    return null;
  }
  const { done, total, current } = taskProgress(entry.tasks);
  const live = taskCardIsLive(entry, runSettledAt);
  const open = override ?? entry.latest;
  // What the list was DOING at this point in the conversation — the whole value
  // of a collapsed card, and the reason it is not simply hidden.
  const currentLabel =
    current === null ? null : (current.activeForm ?? current.title);
  return (
    <div
      data-slot="task-list-card"
      // Stated on the element because it is not derivable from the outside: the
      // rule reads a context value and the card's own place in the thread, so a
      // test (and anyone with the inspector open) has no other way to see which
      // way it went.
      data-live={live}
      data-open={open}
      className="min-w-0">
      <SectionLabel>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOverride(!open)}
          className="flex w-full items-center gap-1.5 text-left uppercase transition-colors hover:text-foreground">
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
          <TaskIcon />
          Task list
          <span className="shrink-0">
            · <TaskCount done={done} total={total} />
          </span>
          {!open && currentLabel !== null ? (
            <span
              data-slot="task-list-current"
              className="min-w-0 truncate normal-case">
              · {currentLabel}
            </span>
          ) : null}
        </button>
      </SectionLabel>
      {open ? (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <TaskRows tasks={entry.tasks} live={live} />
        </div>
      ) : null}
    </div>
  );
}
