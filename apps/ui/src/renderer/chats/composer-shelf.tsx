import { GitPullRequest, Workflow as WorkflowIcon } from 'lucide-react';
import { useContext } from 'react';

import type { PullRequestRefResult } from '../../shared/contracts';
import { HoverPopover } from '../components/hover-popover';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import type { AgentThread } from './agent-activity';
import { RunSettledContext } from './live-row';
import { revealThreadPullRequests, revealWorkflows } from './panel-flags';
import { ThreadPullRequestChip } from './pull-request-row';
import {
  SHELF_CHIP_CLASS,
  SHELF_CHIP_TRIGGER_CLASS,
  SHELF_CHIP_WRAPPER_CLASS,
  SHELF_GROUP_CLASS,
  SHELF_SEGMENT_CLASS,
} from './shelf-chip';
import type { ShellRun } from './shell-activity';
import { ShellRows } from './shell-list';
import { SubagentRows } from './subagent-list';
import {
  type AgentTaskGroup,
  TaskCount,
  TaskGroupRows,
  TaskIcon,
  TaskScrollRows,
} from './task-list';
import type { AgentTaskRow } from './task-payload';
import type { WorkflowEntry } from './transcript-groups';
import { shelfThreadPullRequests } from './use-thread-pull-requests';
import { WorkflowChip, workflowShellStatus } from './workflow-block';

/**
 * The row of small cards directly above the composer.
 *
 * ONE LINE, always. What sits here is whatever the thread has produced that the
 * user might want to reach without scrolling the transcript — pull requests are
 * the first of those rather than the only one, and anything added later is
 * another chip in this row, not another line above the composer, which is how
 * the area became a stack of one-item rows in the first place. A row that
 * wrapped would push the textarea down by however much the thread happened to
 * produce, so each chip takes a bounded width and gives the rest back: what
 * truncates is the TITLE, never the number, since the number identifies it.
 *
 * The chips stay SEPARATE, with gaps — a row of distinct readings, each its own
 * object. The whole row was joined into one segmented bar for a moment and that
 * was rejected on sight ("but chips still should be separate, as before. What i
 * told - ts only for prs"): touching is a claim that two things are one, and it
 * is true of a pull request and the `All 4` that counts it, false of a terminal
 * and a task list. The one joined run therefore lives inside
 * {@link ThreadPullRequestChips} rather than here.
 *
 * It renders NOTHING when it holds nothing (`empty:hidden`), so a thread that
 * has produced none of this costs no space and no gap.
 */
export function ComposerShelf({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="composer-shelf"
      className="flex items-center gap-1.5 overflow-hidden px-1 empty:hidden">
      {children}
    </div>
  );
}

/**
 * How wide ONE pull-request chip may get, by how many are drawn beside it.
 *
 * The shelf is a single line that never wraps, so width taken by one chip is
 * width the next one does not have — "we always should fit all available chips
 * to one line". Two mechanisms do that and they answer different situations. A
 * CROWDED row is handled by flex on its own: every chip carries `min-w-0` and
 * the default shrink while the terminals chip beside them is `shrink-0`, so the
 * pull requests give up width first and the row fits by construction. What flex
 * cannot do is the ROOMY row, where three chips would each take their full
 * width and leave the rest of the shelf pressed against the edge — hence a cap
 * that comes down as the count goes up.
 *
 * The steps are not linear because the chip is not all title: a number, a glyph
 * and the padding are fixed at about 5rem, so 14 → 11 → 9rem leaves roughly
 * 9rem, 6rem and 4rem of title. That is a readable title, a recognisable one,
 * and a hint — which is the right shape for a row where the leftmost chip is
 * the one the thread is most likely on.
 */
const PULL_REQUEST_CHIP_WIDTH: Record<number, string> = {
  1: 'max-w-56',
  2: 'max-w-44',
  3: 'max-w-36',
};

/**
 * The pull requests this thread has OPEN as shelf chips, and a way to the rest.
 *
 * Up to {@link MAX_SHELF_PULL_REQUESTS} of them — see `shelfThreadPullRequests`
 * for which, and why an open one is what earns a chip. It named exactly ONE for
 * a release, which was right for a thread whose work is one branch and wrong
 * for the case it was reported against ("in case if we have few opened PRS -
 * all of them, but maximum 3"): several reviews open at once, only the newest
 * reachable from here.
 *
 * The CAP is the point, though, and it is the same one the single chip was
 * chosen for. A thread opens as many pull requests as it opens — thirty-one
 * across six repositories in the case this was built for — and drawing them all
 * pushed the textarea most of the way up the pane. Past the cap the button
 * hands the list to the PANEL, which is a scrolling column built for it.
 */
export function ThreadPullRequestChips({
  results,
}: {
  results: readonly PullRequestRefResult[];
}): React.JSX.Element | null {
  const shown = shelfThreadPullRequests(results);
  if (shown.length === 0) {
    return null;
  }
  const repos = new Set(
    results.map((row) => `${row.ref.owner}/${row.ref.repo}`),
  );
  return (
    // ONE card over the pull requests and the control that counts them — the
    // only joined run on the shelf. `All 4` standing apart as a fifth identical
    // pill read as a peer of `Tasks 2/6`, because nothing said which items
    // belonged together; touching says it, and here it is true. The chips
    // beside this group stay separate, which is the other half of the same
    // rule — see `ComposerShelf`.
    //
    // Drawn even for a lone pull request with no control beside it: a group of
    // one is visually identical to the standalone chip it replaces (the card is
    // the same card), so there is no branch, and no way for the two shapes to
    // drift apart.
    <div data-slot="pull-request-group" className={SHELF_GROUP_CLASS}>
      {shown.map((result) => (
        <ThreadPullRequestChip
          key={result.ref.url}
          result={result}
          showRepo={repos.size > 1}
          widthClassName={PULL_REQUEST_CHIP_WIDTH[shown.length]}
        />
      ))}
      {/* Counting what the THREAD opened, not what is left over: the button
          goes to a panel listing every one of them, merged included, so `All 6`
          beside three chips is the honest number even though only three are
          hidden. It appears only once something IS hidden. */}
      {results.length > shown.length ? (
        <button
          type="button"
          data-slot="all-pull-requests"
          title="Show every pull request this thread opened"
          aria-label={`Show all ${results.length} pull requests this thread opened`}
          // A SEGMENT of the group, not a card standing beside it — which is
          // the whole point of the group. `font-normal` is an override:
          // `global.css` gives every bare `button` the base 15px at medium
          // weight, which the segment's own `text-xs` covers for size but not
          // for weight.
          className={cn(
            SHELF_SEGMENT_CLASS,
            'shrink-0 font-normal text-muted-foreground',
          )}
          onClick={revealThreadPullRequests}>
          {/* The GLYPH is the other half of making `All 4` mean something. It
              was the one item on the shelf that named no subject, and the
              hardest to guess, being a control rather than a reading: carrying
              the mark of the chips it is joined to, the run says "pull
              requests, and all four of them" without a word more. */}
          <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0" />
          All {results.length}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The commands this thread has running on the machine RIGHT NOW, as a shelf
 * chip: a spinner, a count, and the list behind it.
 *
 * It sits here rather than in the chat header because that is where it was
 * asked for — the shelf is the row of things a thread is currently producing,
 * and a running terminal is the most immediate of them. The interaction is the
 * header's own (`HoverPopover`), so the same hover-then-pin behaviour and the
 * same white panel serve both; only the anchor moved.
 *
 * It is drawn as a SHELF CHIP (`SHELF_CHIP_CLASS`) with its neighbours' exact
 * three-part structure — MARK, NAME, FIGURE — and the parts are what two
 * rounds of reports were about. First it was a bare spinner and a number
 * ("должна быть не просто цифра… в таком же белом блоке"), then a terminal
 * glyph with the number and a trailing spinner, which was still wrong on both
 * the wording and the order: "там прям должно быть написано «Terminals»… а
 * вторая кнопочка должна быть вот эта вот Loader, которая должна находиться
 * где-то слева".
 *
 * So the SPINNER is the mark, in the leading slot where the pull request has
 * its state icon and the workflow its status mark. It is the right thing to
 * put there rather than a terminal glyph, because it carries what this chip is
 * FOR: every row behind it is live by construction (`runningShellsByAgent`
 * hands over only what nothing has settled), so the chip exists exactly while
 * something is running. `Terminals` is the name, in the same medium weight the
 * other two set their name in, and the count is the muted tabular figure that
 * trails it — `#78 Fix the shelf` and `Terminals 2` are then the same shape.
 *
 * The panel opens UPWARD. `Popover` does no collision detection, and this
 * trigger sits directly on top of the composer card — downward would open the
 * list over the textarea the user is about to type in.
 *
 * Nothing is drawn when nothing is running, unlike the header counter it
 * replaced: that one was deliberately drawn at zero because a reader scanning a
 * fixed row needs "none" told apart from "no such readout", and a shelf makes
 * that distinction for itself — it is a row of what EXISTS, and every chip on
 * it comes and goes.
 */
export function RunningShellChips({
  shells,
  agentNameOf,
  onOpen,
}: {
  shells: readonly ShellRun[];
  /**
   * Which agent started each command — see {@link ShellRows}. This is the ONE
   * list in the app that mixes several agents' shells, so it is the one place
   * the question arises; a 1:1 chat passes none.
   */
  agentNameOf?: ReadonlyMap<string, string>;
  onOpen: (shell: ShellRun) => void;
}): React.JSX.Element | null {
  if (shells.length === 0) {
    return null;
  }
  return (
    <HoverPopover
      slot="running-shells"
      label={`${shells.length} shell${shells.length === 1 ? '' : 's'} running`}
      panelLabel="Shells"
      side="top"
      align="start"
      className={SHELF_CHIP_WRAPPER_CLASS}
      triggerClassName={SHELF_CHIP_TRIGGER_CLASS}
      // Bounded and scrolling, as in the header: a fan-out can hold a dozen,
      // and the rows are long — a command, not a name.
      panelClassName="max-h-64 w-[22rem] overflow-y-auto"
      trigger={
        <>
          <Spinner className="size-3.5" />
          <span className="font-medium">Terminals</span>
          <span className="text-muted-foreground tabular-nums">
            {shells.length}
          </span>
        </>
      }>
      <ShellRows shells={shells} agentNameOf={agentNameOf} onOpen={onOpen} />
    </HoverPopover>
  );
}

/**
 * The delegates this thread has working RIGHT NOW, as a shelf chip: a glyph, a
 * name, the count, and the list behind it.
 *
 * It came from the CHAT HEADER, where it was a bare glyph-and-number in the
 * right-hand group beside the worked/spend figures, and it moved here on the
 * same ask that moved the terminals chip ahead of it: the shelf is the row of
 * things a thread is producing right now, and a fan-out of delegates is one of
 * them. The interaction is unchanged — the same {@link HoverPopover}, the same
 * hover-then-pin, the same white panel — so only the anchor moved.
 *
 * What DID change is when it is drawn, and the change is the shelf's rule
 * rather than a second opinion about delegates. In the header it was drawn at
 * zero on request ("здесь должна быть всегда иконка саб-эйджентов, даже если их
 * ноль"), and the reason was real: a counter that appears only once something
 * is running answers "are any working" with the same blank space as a header
 * that never had one, and a reader scanning a FIXED row cannot tell those
 * apart. A shelf makes that distinction for itself — it is a row of what
 * EXISTS, and every chip on it comes and goes — so the zero state is the row
 * being one chip shorter, which is the same reading the terminals chip beside
 * it already gives.
 *
 * The MARK is the delegate glyph, not a spinner. That is a deliberate departure
 * from its neighbour, whose spinner was asked for by name: every row behind
 * `Terminals` is live by construction, while this list holds the FINISHED
 * delegates too — so a spinner here would claim something about rows it does
 * not describe, and two spinners on one row is noise besides.
 *
 * The panel opens UPWARD, like every chip on this row: `Popover` does no
 * collision detection and this trigger sits directly on the composer card, so
 * downward would open the list over the textarea the user is about to type in.
 */
export function RunningSubagentChips({
  running,
  threads,
  onOpen,
}: {
  /**
   * How many delegates are working — the FIGURE, and what decides whether the
   * chip exists at all.
   *
   * Handed over rather than counted off {@link threads}, because it is a
   * reading taken across every agent of the run where the agents are
   * (`Chats.tsx`), and the agents panel renders the same number. A second count
   * here would be a second answer to a question the app already answers once.
   */
  running: number;
  /** Every delegate the thread has launched, for the list behind the count. */
  threads: readonly AgentThread[];
  onOpen?: (subagentId: string) => void;
}): React.JSX.Element | null {
  if (running === 0) {
    return null;
  }
  return (
    <HoverPopover
      slot="running-subagents"
      label={`${running} sub-${running === 1 ? 'agent' : 'agents'} working`}
      panelLabel="Sub-agents"
      side="top"
      align="start"
      className={SHELF_CHIP_WRAPPER_CLASS}
      triggerClassName={SHELF_CHIP_TRIGGER_CLASS}
      // Bounded and scrolling, as it was in the header: a delegating turn can
      // hold a dozen live and forty finished, and a panel that grows with them
      // runs off the top of the window.
      panelClassName="max-h-64 w-[20rem] overflow-y-auto"
      trigger={
        <>
          {/* A SPINNER, like the terminals chip beside it — asked for by name
              ("i wanna have loader for subagents chip as well"), and honest
              here for exactly the reason it is honest there: this chip is not
              drawn at all unless `running > 0`, so every time it is on screen a
              delegate IS working. The earlier objection — that this list holds
              the finished delegates too — is true of the PANEL behind the chip
              and never of the chip, whose figure has always been the live count
              alone. */}
          <Spinner className="size-3.5" />
          <span className="font-medium">Sub-agents</span>
          <span className="text-muted-foreground tabular-nums">{running}</span>
        </>
      }>
      <SubagentRows threads={threads} onOpen={onOpen} />
    </HoverPopover>
  );
}

/**
 * The agent's own TODO list as a shelf chip: the checklist glyph, the name, and
 * `done/total` — with the list itself behind it.
 *
 * Moved off the chat header beside {@link RunningSubagentChips}, on the same
 * ask and with the same interaction. It keeps the header's condition rather
 * than its neighbour's: a chip appears once the thread's agents keep a list at
 * all and STAYS once the turn settles, because a finished list is still the
 * answer to "what did it do, and what did it leave" — where a finished delegate
 * or a returned command is history the transcript already holds.
 *
 * That also fixes where it sits on the row. The shelf runs from durable to
 * volatile, so a chip that outlives the turn belongs among the pull requests
 * rather than out at the end with the terminals: chips that come and go must
 * not shift the ones that stay.
 *
 * The FIGURE is the pair, never a bare remaining count. `6` says nothing about
 * whether that is six of seven or six of sixty and can only shrink, which reads
 * as a countdown out of a number nothing states — reported exactly that way,
 * and `done/total` is how the transcript cards, the agents panel and the
 * sub-agent headers all say it ({@link TaskCount}).
 */
export function TaskListChip({
  done,
  total,
  tasks,
  groups,
  live,
}: {
  done: number;
  total: number;
  tasks: readonly AgentTaskRow[];
  /**
   * The same rows split per agent, drawn as one block each. Absent leaves the
   * flat list — the caller decides, on the terminals chip's rule: a 1:1 chat
   * has one agent, so a heading over its only list is a word that names
   * nothing the reader could have doubted.
   */
  groups?: readonly AgentTaskGroup[];
  /**
   * Whether anything is still working through the list — what stops the
   * in-progress row spinning on a thread nobody is advancing.
   */
  live: boolean;
}): React.JSX.Element | null {
  if (total === 0) {
    return null;
  }
  return (
    <HoverPopover
      slot="open-tasks"
      label={`${done} of ${total} ${total === 1 ? 'task' : 'tasks'} done`}
      panelLabel="Task list"
      side="top"
      align="start"
      className={SHELF_CHIP_WRAPPER_CLASS}
      triggerClassName={SHELF_CHIP_TRIGGER_CLASS}
      // Grouped, the panel holds one bounded block per agent, so it needs a
      // bound of its own — three agents' blocks stack past the top of the
      // window otherwise. Flat, the single block already bounds itself and a
      // second scroller over it would be one nested inside another.
      panelClassName={cn(
        'w-[20rem]',
        groups && 'max-h-[26rem] overflow-y-auto',
      )}
      trigger={
        <>
          <TaskIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium">Tasks</span>
          <span className="text-muted-foreground tabular-nums">
            <TaskCount done={done} total={total} />
          </span>
        </>
      }>
      {/* Each list is bounded and scrolls itself, following the task that is
          RUNNING, so a thirteen-row list opens on the row that matters rather
          than on five finished ones. */}
      {groups === undefined ? (
        <TaskScrollRows tasks={tasks} live={live} />
      ) : (
        <TaskGroupRows groups={groups} live={live} />
      )}
    </HoverPopover>
  );
}

/**
 * The workflow this thread is running RIGHT NOW, as a shelf chip.
 *
 * Only the running ones, and that is what makes it a shelf item at all: a
 * finished workflow is history and has its card in the transcript, while a
 * running one is the most expensive thing in the chat and the reader wants it
 * reachable without scrolling. It therefore appears when one starts and goes
 * away when it ends, costing no space either side of that.
 *
 * ONE chip and a count, exactly as the pull requests beside it: two workflows
 * running at once is rare, but the shelf is a single line and a rule that holds
 * only while a thread behaves is not a rule.
 */
export function ActiveWorkflowChips({
  workflows,
  onReveal,
}: {
  workflows: readonly WorkflowEntry[];
  onReveal: (workflowId: string) => void;
}): React.JSX.Element | null {
  const runSettledAt = useContext(RunSettledContext);
  const running = workflows.filter(
    (entry) => workflowShellStatus(entry, runSettledAt) === 'running',
  );
  // The NEWEST, which is the last one launched — `workflowCardsOf` hands them
  // over in launch order.
  const current = running.at(-1);
  if (current === undefined) {
    return null;
  }
  return (
    <>
      <WorkflowChip entry={current} onReveal={onReveal} />
      {running.length > 1 ? (
        <button
          type="button"
          data-slot="all-workflows"
          title="Show every workflow this thread is running"
          aria-label={`Show all ${running.length} workflows this thread is running`}
          // A CHIP of its own, not a segment: the joining was asked for on
          // the pull requests alone ("ts only for prs"), and the same
          // reasoning applying here is a case to make rather than a licence to
          // take. The GLYPH it did get is separable from that and is the half
          // that carries the meaning — `All 2` alone names no subject.
          className={cn(
            SHELF_CHIP_CLASS,
            'shrink-0 font-normal text-muted-foreground',
          )}
          onClick={revealWorkflows}>
          <WorkflowIcon aria-hidden="true" className="size-3.5 shrink-0" />
          All {running.length}
        </button>
      ) : null}
    </>
  );
}
