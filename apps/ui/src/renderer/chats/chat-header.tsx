import {
  Bot,
  IdCard,
  ListTodo,
  PanelRight,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { Chip } from '../components/ui/chip';
import { cn } from '../components/ui/utils';
import { folderName as configDirName } from './directory-select';
import { formatElapsed } from './live-row';
import { formatRelativeTime } from './relative-time';
import {
  RUN_STATUS_META,
  RunStatusIcon,
  type RunStatusKind,
} from './run-status';
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
 * The open transcript's header: the same identity the sidebar row carries —
 * label, live status (spinning while running), last activity. The run's
 * working directory lives in the composer's folder chip below, not here.
 *
 * On the right, only the side-panel toggle. The context meter used to sit here
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
  openTurn = null,
  sidePanelOpen,
  onToggleSidePanel,
  runningSubagents = 0,
  openTasks = 0,
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
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  /** Delegates working right now — see {@link SidePanelLiveCounts}. */
  runningSubagents?: number;
  /** Tasks on the agents' own lists that are not finished. */
  openTasks?: number;
}): React.JSX.Element {
  return (
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
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {/* What the panel is holding, stated BEFORE its toggle — the toggle
            alone could not say whether opening it was worth the click. Each
            counter renders only while it has something to count ("if there
            is"), so a plain turn keeps the header exactly as it was, and both
            are part of the SAME control: pressing one opens the list they
            describe rather than making the user find it. */}
        {runningSubagents > 0 || openTasks > 0 ? (
          <button
            type="button"
            onClick={onToggleSidePanel}
            aria-label={`Side panel — ${runningSubagents} running sub-agents, ${openTasks} open tasks`}
            title={`${runningSubagents} sub-${runningSubagents === 1 ? 'agent' : 'agents'} working · ${openTasks} ${openTasks === 1 ? 'task' : 'tasks'} to go`}
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            {runningSubagents > 0 ? (
              <span
                data-slot="running-subagents"
                className="flex items-center gap-1">
                <Bot aria-hidden="true" className="size-3.5 shrink-0" />
                {runningSubagents}
              </span>
            ) : null}
            {openTasks > 0 ? (
              <span data-slot="open-tasks" className="flex items-center gap-1">
                <ListTodo aria-hidden="true" className="size-3.5 shrink-0" />
                {openTasks}
              </span>
            ) : null}
          </button>
        ) : null}
        <Button
          type="button"
          variant={sidePanelOpen ? 'secondary' : 'ghost'}
          size="icon"
          className={cn('size-7', !sidePanelOpen && 'text-muted-foreground')}
          aria-label={sidePanelOpen ? 'Close side panel' : 'Open side panel'}
          title="Side panel"
          onClick={onToggleSidePanel}>
          <PanelRight className="size-4 shrink-0" />
        </Button>
      </div>
    </div>
  );
}
