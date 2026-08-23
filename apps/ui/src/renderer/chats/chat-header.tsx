import { Bot, IdCard, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { HoverPopover } from '../components/hover-popover';
import { Chip } from '../components/ui/chip';
import { cn } from '../components/ui/utils';
import type { AgentThread } from './agent-activity';
import { folderName as configDirName } from './directory-select';
import { formatElapsed } from './live-row';
import { formatRelativeTime } from './relative-time';
import {
  RUN_STATUS_META,
  RunStatusIcon,
  type RunStatusKind,
} from './run-status';
import { TaskCount, TaskIcon, TaskScrollRows } from './task-list';
import type { AgentTaskRow } from './task-payload';
import {
  formatDuration,
  type OpenTurn,
  openTurnWorkedMs,
} from './turn-duration';

/**
 * One re-render a second, for as long as `active`.
 *
 * The two live readouts in this header own their own ticking rather than the
 * header being repainted from above once a second — the same reason the
 * transcript's live rows own theirs.
 */
function useSecondTick(active: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
}

/**
 * How long the turn on screen has been running, ticking every second.
 *
 * Its own component so the second-by-second re-render stays here instead of
 * repainting the whole header — the same reason the transcript's live rows own
 * their clocks. Renders nothing without a start time, so the header can place
 * it unconditionally.
 */
function ElapsedTime({
  since,
}: {
  since: string | null;
}): React.JSX.Element | null {
  useSecondTick(since !== null);
  const startedAt = since === null ? NaN : Date.parse(since);
  if (!Number.isFinite(startedAt)) {
    return null;
  }
  return (
    <span
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
      title="How long this turn has been running">
      · {formatElapsed(Date.now() - startedAt)}
    </span>
  );
}

/**
 * What this thread has WORKED — the settled turns plus the one in flight,
 * ticking while it runs.
 *
 * The whole figure moves, rather than the running turn being stated separately
 * beside it: "how much work is in here" is one number, and a thread mid-turn
 * had it standing still for the entire turn — a header reading `running · 18s ·
 * worked 64m 34s` where the 64m had not moved in an hour of watching. The
 * elapsed clock beside it is NOT the same answer: that one is this turn alone,
 * and it is the raw wall clock — it keeps running while the agent sits parked
 * on a question, which is exactly when this one must not.
 */
function WorkedTime({
  settledMs,
  turnCount,
  openTurn,
}: {
  settledMs: number;
  turnCount: number;
  openTurn: OpenTurn | null;
}): React.JSX.Element | null {
  useSecondTick(openTurn !== null);
  const liveMs = openTurnWorkedMs(openTurn, Date.now());
  const totalMs = settledMs + liveMs;
  if (totalMs <= 0) {
    return null;
  }
  // The running turn counts toward the tally because its time counts toward
  // the total — a sum over fifteen turns labelled "14 turns" is the kind of
  // small lie a reader has no way to catch.
  const turns = turnCount + (openTurn === null ? 0 : 1);
  return (
    <span
      data-slot="thread-worked"
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
      title={
        openTurn === null
          ? `Total time the agent worked in this thread, across ${turns} ${turns === 1 ? 'turn' : 'turns'} — not the span since it started`
          : `Total time the agent worked in this thread, across ${turns} ${turns === 1 ? 'turn' : 'turns'} — the turn in flight included, measured by the wall clock and paused while it waits on you`
      }>
      · worked {formatDuration(totalMs)}
      {turns > 1 ? ` / ${turns} turns` : ''}
    </span>
  );
}

/**
 * What this thread has SPENT — the reported ask, beside what it worked.
 *
 * Null renders NOTHING rather than `$0.00`, and the distinction is the whole
 * rule the figures obey end to end: cursor-agent reports no cost unless its
 * currency is USD, so a thread on it has not spent nothing — it has not been
 * measured. Writing `$0.00` there would be the app inventing a number the CLI
 * refused to give.
 *
 * Its own component so a spend that arrives after the header first painted
 * re-renders this span alone, not the identity line beside it.
 */
function ThreadSpend({
  costUsd,
}: {
  costUsd: number | null;
}): React.JSX.Element | null {
  if (costUsd === null) {
    return null;
  }
  return (
    <span
      data-slot="thread-spend"
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
      title="What this thread has cost, summed over every turn that reported one">
      · {formatUsd(costUsd)}
    </span>
  );
}

/**
 * A spend, in the smallest number of digits that still distinguishes two turns.
 *
 * Cents for anything a user would recognise as an amount, and four decimals
 * below one cent — a thread that has cost $0.0003 must not round to `$0.00`,
 * which is the same "we measured nothing" claim the null case is careful to
 * avoid making.
 */
function formatUsd(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01
    ? `$${costUsd.toFixed(4)}`
    : `$${costUsd.toFixed(2)}`;
}

/**
 * What the sub-agent count is a count OF — the delegates themselves, behind the
 * number.
 *
 * The count alone was the whole readout, and a number is not an answer to "what
 * is it doing": REPORTED as "при наведении на поп-овер эйджентов: список
 * текущих эйджентов". Each row states its own status through the app's one
 * status vocabulary ({@link RunStatusIcon}), so a delegate that finished, one
 * that failed and one still working are told apart here exactly as they are in
 * the panel below.
 *
 * The empty case is a SENTENCE rather than an empty box, because the counter is
 * now drawn at zero: "0" with nothing behind it reads as a readout that failed
 * to load.
 */
function SubagentList({
  threads,
}: {
  threads: readonly AgentThread[];
}): React.JSX.Element {
  if (threads.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No sub-agents yet — this thread’s agent has delegated nothing.
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {threads.map((thread) => (
        <li
          key={thread.id}
          className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RunStatusIcon status={thread.status} />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {thread.label}
          </span>
          <span
            className={cn(
              'shrink-0',
              RUN_STATUS_META[thread.status].className,
            )}>
            {RUN_STATUS_META[thread.status].label}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The open transcript's header: the same identity the sidebar row carries —
 * label, live status (spinning while running), last activity. The run's
 * working directory lives in the composer's folder chip below, not here.
 *
 * On the right, only what the agents panel is holding, as a readout. It used to
 * be that panel's toggle; the panel is always on screen now, so there is nothing
 * left to open. The context meter used to sit here
 * too and has moved into the composer, beside Send — the question it answers
 * ("how much room is left") is asked while composing the next message, not
 * while reading the header, and the eye leaves this row as soon as the
 * conversation starts. Everything per-agent (threads, per-node context) stays
 * in the panel.
 */
export function ChatHeader({
  label,
  isWorkflow,
  agentKind = null,
  configDir = null,
  status,
  lastActivityAt,
  turnStartedAt = null,
  workedMs = 0,
  turnCount = 0,
  costUsd = null,
  openTurn = null,
  runningSubagents = 0,
  tasks = null,
  subagents = [],
  taskRows = [],
}: {
  label: string;
  isWorkflow: boolean;
  /**
   * The CLI driving a single-agent chat. It lives HERE rather than in the
   * composer below: it is fixed for the life of the run, and a chip stating an
   * unchangeable fact sat among five that change things. Null for a workflow
   * run, whose agents are per node — the panel lists those.
   */
  agentKind?: string | null;
  /**
   * The agent config directory this run's turns use — which account/profile
   * the CLI runs as — or null for the CLI's own default.
   *
   * HERE, beside the agent, for the same reason the agent is: it is fixed for
   * the life of the run and it changes what the conversation IS — a different
   * profile is a different subscription, different plugins, different history.
   * A run on the default profile shows nothing, because "the usual one" is not
   * news; only a run that departs from it earns a chip.
   */
  configDir?: string | null;
  /**
   * The DISPLAY status, not the daemon's row value — wider than `RunStatus`
   * because `needs-input` is derived in the renderer (`displayRunStatus`) and
   * no daemon row ever carries it.
   */
  status: RunStatusKind;
  lastActivityAt: string;
  /**
   * When the turn currently on screen began — the ISO timestamp of the message
   * that started it. Drives the running clock; null while nothing is running.
   *
   * A TIMESTAMP rather than an elapsed number, for the same reason the
   * daemon's `thinkingSince` is one: a duration computed by the owner freezes
   * at the moment it was passed, and keeping it moving would mean re-rendering
   * the header once a second from above. It is read from the transcript, so it
   * survives a reload mid-turn — a clock started at mount would restart at zero
   * and claim a four-minute turn had just begun.
   */
  turnStartedAt?: string | null;
  /**
   * What this thread has WORKED in total — the sum of its turns, not the span
   * from its first message to its last.
   *
   * The two differ enormously and only one answers the question: a chat left
   * open across three days with five minutes of work in it spans `3d` and
   * worked `5m`. Zero (a thread whose turns reported nothing, or that has none
   * yet) renders nothing rather than `0s`.
   */
  workedMs?: number;
  /** How many settled turns {@link workedMs} is the sum of. */
  turnCount?: number;
  /**
   * What this thread has spent in USD, or null when nothing measured it.
   *
   * Summed by the DAEMON over the run's own turns rather than folded from the
   * transcript on screen — see `use-chat-totals.ts`. Null is a real answer and
   * renders nothing: a CLI that reports no cost has not made this thread free.
   */
  costUsd?: number | null;
  /**
   * The turn still in flight, so the total keeps MOVING while one is — null
   * when nothing is running.
   *
   * {@link workedMs} alone is the settled sum, which is a figure that stands
   * still for the whole of a turn: the reported defect was a header sitting on
   * `worked 64m 34s` while the agent visibly worked. Handed over as the turn's
   * pieces rather than as a number, because a number would freeze the instant
   * it was computed — the same reason {@link turnStartedAt} is a timestamp.
   */
  openTurn?: OpenTurn | null;
  /** Delegates working right now. */
  runningSubagents?: number;
  /**
   * The agents' own task lists, as DONE OUT OF TOTAL — null when no agent here
   * keeps one.
   *
   * A bare count of what is left was what got reported: `6` alone says nothing
   * about whether that is six of seven or six of sixty, and it only ever
   * shrinks, so it reads as a countdown out of an unstated number. The pair is
   * also the one form the rest of the app already uses for a list's progress
   * ({@link TaskCount}, in the transcript cards, the panel and the sub-agent
   * headers), so the header now agrees with every other place the same lists
   * are summarized instead of speaking its own dialect.
   */
  tasks?: { done: number; total: number } | null;
  /**
   * Every delegate this run has launched, for the list behind the count —
   * running ones and the ones that have finished, in the order the agents panel
   * holds them.
   *
   * The COUNT still comes from {@link runningSubagents}: it is a reading over
   * every agent of the run, taken where the agents are, and re-deriving it here
   * from a list assembled for a popover would be a second answer to a question
   * the sidebar and the panel already answer once.
   */
  subagents?: readonly AgentThread[];
  /**
   * The task rows behind {@link tasks}' count — the agents' own lists, merged
   * in the order the panel shows them.
   */
  taskRows?: readonly AgentTaskRow[];
}): React.JSX.Element {
  return (
    // A header for the TRANSCRIPT, not for the window: the shell's title bar is
    // one band above every column (`components/title-bar.tsx`), and this row no
    // longer moves the window — dragging a row full of chips was surprising
    // once a real title bar existed.
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-card/60 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {isWorkflow ? (
          <WorkflowIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : null}
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">
          {label}
        </h2>
        {agentKind ? <Chip className="h-6 px-1.5">{agentKind}</Chip> : null}
        {configDir ? (
          // The LEAF, with the whole path on hover: a profile directory is
          // usually deep (`~/Desktop/Projects/X/.claude-thing`) and the header
          // is a one-line identity, not a place to read paths.
          <Chip
            className="h-6 min-w-0 px-1.5"
            title={`Agent config directory (account / profile): ${configDir}`}>
            <IdCard />
            <span className="max-w-40 truncate">
              {configDirName(configDir)}
            </span>
          </Chip>
        ) : null}
        <span className="flex shrink-0 items-center gap-1 text-xs">
          <RunStatusIcon status={status} />
          <span className={RUN_STATUS_META[status].className}>
            {RUN_STATUS_META[status].label}
          </span>
        </span>
        {status === 'running' ? (
          // WHILE running the question is "how long has this been going", not
          // "when did it last do something" — the relative time reads
          // "just now" for the whole turn and answers nothing.
          <ElapsedTime since={turnStartedAt} />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            · {formatRelativeTime(lastActivityAt)}
          </span>
        )}
        {/* Beside the relative time, and deliberately NOT instead of it: the
            two answer different questions ("when did this last speak" vs "how
            much work is in here"), and it was the second that had no answer
            anywhere in the app once a turn had settled. */}
        <WorkedTime
          settledMs={workedMs}
          turnCount={turnCount}
          openTurn={openTurn}
        />
        {/* The reported ask: what the thread COST, next to what it worked. The
            pair is the point — a price with no sense of the work behind it is
            the same half-answer the duration was on its own. */}
        <ThreadSpend costUsd={costUsd} />
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {/* What the agents panel is holding, at a glance. It used to BE that
            panel's toggle — "how much work is in here" was the one thing a bare
            chevron could not say, so the counts and the control were one
            button. The panel is always on screen now, so there is nothing left
            to OPEN; what a press does here is pin the readout each count holds
            behind it.

            The sub-agent counter is drawn WHATEVER the count — the reported
            "здесь должна быть всегда иконка саб-эйджентов, даже если их ноль".
            A counter that appears only once something is running answers "are
            any working" with the same blank space as a header that never had
            one, and the reader cannot tell which of the two they are looking
            at. The task counter still comes and goes: a thread whose agent
            keeps no list has no list to report on, where every thread has
            delegates it could have launched and did not. */}
        <span
          data-slot="side-panel-counts"
          className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <HoverPopover
            slot="running-subagents"
            label={`${runningSubagents} sub-${runningSubagents === 1 ? 'agent' : 'agents'} working`}
            panelLabel="Sub-agents"
            side="bottom"
            triggerClassName="gap-1 rounded-md px-1 py-0.5 hover:bg-accent"
            // Bounded and scrolling, like every other list this app hangs off a
            // count: a delegating turn can hold a dozen, and a panel that grows
            // with them runs off the bottom of the window.
            panelClassName="max-h-64 w-[18rem] overflow-y-auto"
            trigger={
              <>
                <Bot aria-hidden="true" className="size-3.5 shrink-0" />
                {runningSubagents}
              </>
            }>
            <SubagentList threads={subagents} />
          </HoverPopover>
          {tasks !== null && tasks.total > 0 ? (
            <HoverPopover
              slot="open-tasks"
              label={`${tasks.done} of ${tasks.total} ${tasks.total === 1 ? 'task' : 'tasks'} done`}
              panelLabel="Task list"
              side="bottom"
              triggerClassName="gap-1 rounded-md px-1 py-0.5 hover:bg-accent"
              panelClassName="w-[20rem]"
              trigger={
                <>
                  <TaskIcon className="size-3.5" />
                  <TaskCount done={tasks.done} total={tasks.total} />
                </>
              }>
              {/* The panel's own bounded list — it already scrolls itself and
                  follows the task that is running, so a thirteen-row list opens
                  on the row that matters rather than on five finished ones. */}
              <TaskScrollRows tasks={taskRows} live={status === 'running'} />
            </HoverPopover>
          ) : null}
        </span>
      </div>
    </div>
  );
}
