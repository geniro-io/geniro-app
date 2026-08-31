import { Bot, ChevronRight } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { usePersistedFlag } from '../components/use-persisted-flag';
import type { AgentThread } from './agent-activity';
import {
  isSettledRunStatus,
  RUN_STATUS_META,
  RunStatusIcon,
} from './run-status';

/**
 * The delegates a thread has launched, rendered — the list behind the shelf's
 * sub-agent count.
 *
 * It lived inside `chat-header.tsx` while the count did, and moved out with it
 * when the count became a composer-shelf chip. A list renderer in the file of
 * the ONE surface that happens to draw it is how the shell rows and the task
 * rows each came to need extracting later; this one is extracted on the way
 * past rather than after the second caller appears.
 */

/** Where the fold's state lives, so it survives the popover being reopened. */
const SETTLED_OPEN_FLAG = 'chats.subagentRowsSettledOpen';

/** The glyph that marks a delegate, wherever one is summarized. */
export function SubagentIcon({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <Bot aria-hidden="true" className={cn('size-3.5 shrink-0', className)} />
  );
}

/**
 * One delegate's row: its status glyph, its name, and its status in words.
 *
 * Its own component because the list draws it in two places now — above the
 * fold and inside it — and two copies is how the settled rows would come to
 * lose the open control, or the status word, or the `data-slot` every spec
 * reads them by.
 */
function SubagentRow({
  thread,
  onOpen,
}: {
  thread: AgentThread;
  onOpen?: (subagentId: string) => void;
}): React.JSX.Element {
  return (
    <li
      data-slot="subagent-row"
      data-subagent-status={thread.status}
      className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <RunStatusIcon status={thread.status} />
      {onOpen === undefined ? (
        <span className="min-w-0 flex-1 truncate text-foreground">
          {thread.label}
        </span>
      ) : (
        <button
          type="button"
          // `text-xs font-normal` is an OVERRIDE, not decoration:
          // `styles/global.css` gives every bare `button` the base 15px at
          // medium weight, so without it this row would render half again the
          // size of the status word beside it — the same correction the agents
          // panel's own delegate rows carry.
          className="min-w-0 flex-1 truncate rounded text-left text-xs font-normal text-foreground transition-colors hover:underline"
          title={`Open ${thread.label}'s timeline and conversation`}
          onClick={() => onOpen(thread.id)}>
          {thread.label}
        </button>
      )}
      <span
        className={cn('shrink-0', RUN_STATUS_META[thread.status].className)}>
        {RUN_STATUS_META[thread.status].label}
      </span>
    </li>
  );
}

/**
 * Every delegate this thread has launched — the LIVE ones listed, the finished
 * ones counted behind a fold that is shut by default.
 *
 * Each states its own status through the app's one status vocabulary
 * ({@link RunStatusIcon}), so a delegate that finished, one that failed and one
 * still working are told apart here exactly as they are in the agents panel.
 *
 * **The fold REPLACES a sort, and this file used to argue it could not have
 * one.** The rows arrive in the agents panel's order, which groups them under
 * the agent that launched each — right for a column of cards, wrong for one
 * flat list, because a fan-out that spawned forty and finished thirty-eight
 * buries the two live ones in the middle of a scrolling box. The panel answers
 * that by folding its settled rows away; this list answered it by sorting the
 * running ones to the top, on the reasoning that a popover cannot fold. That
 * reasoning was simply wrong — the panel is pinned and its rows already carry
 * buttons — and sorting is the weaker fix, which is what got REPORTED
 * ("completed subagents should be collapsed"): with six running and four
 * finished the box was ten rows deep and scrolling, and every row past the
 * sixth was work that is over. The two surfaces now fold the same way, which is
 * also one less thing for them to disagree about.
 *
 * SETTLED is `isSettledRunStatus`, not `status !== 'running'`: a delegate that
 * is `held`, `pending` or waiting on an answer has not finished, and hiding it
 * behind a control captioned "finished" would put the one row that cannot
 * advance without the user out of sight.
 *
 * The fold is remembered ({@link usePersistedFlag}) because the popover's panel
 * is mounted afresh on every hover — component state would forget the choice
 * between two glances at the same list, which reads as the control not working.
 *
 * The count in front of this list is the RUNNING ones only, and the list is all
 * of them on purpose: a chip reading `Sub-agents 2` over a box holding just two
 * rows says nothing a reader could not already see, while `2` over two spinners
 * and a fold reading `11 finished` says what the turn has been doing.
 *
 * The empty case is a SENTENCE rather than an empty box. The shelf chip that
 * draws this never appears empty — it comes and goes with the work — but the
 * rule is worth keeping in the component rather than in its caller: a panel
 * with nothing in it reads as a readout that failed to load, and the next
 * surface to hang this off a count that IS drawn at zero gets the sentence for
 * free.
 */
export function SubagentRows({
  threads,
  onOpen,
}: {
  threads: readonly AgentThread[];
  /**
   * Show one delegate's own timeline and conversation, by the id of the tool
   * call that launched it. Absent leaves the rows as plain text — the list
   * never invents a surface it was not given, the same rule `ShellRows` and the
   * panel's own sub-agent rows follow.
   */
  onOpen?: (subagentId: string) => void;
}): React.JSX.Element {
  const [settledOpen, setSettledOpen] = usePersistedFlag(
    SETTLED_OPEN_FLAG,
    false,
  );
  if (threads.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No sub-agents yet — this thread&rsquo;s agent has delegated nothing.
      </p>
    );
  }
  const live = threads.filter((thread) => !isSettledRunStatus(thread.status));
  const settled = threads.filter((thread) => isSettledRunStatus(thread.status));
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {live.map((thread) => (
        <SubagentRow key={thread.id} thread={thread} onOpen={onOpen} />
      ))}
      {settled.length > 0 ? (
        <li className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={settledOpen}
            onClick={() => setSettledOpen((open) => !open)}
            // `font-normal` for the reason the row label carries it:
            // global.css's base `button` rule would otherwise weight this
            // heavier than the rows it is counting.
            className="flex items-center gap-1.5 rounded text-left text-xs font-normal text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3 shrink-0 transition-transform',
                settledOpen && 'rotate-90',
              )}
            />
            {/* Counted, not listed — and the noun is left out, unlike the
              agents panel's own copy of this control: that one sits under an
              agent's name, while this panel hangs off a chip already reading
              `Sub-agents`, so spelling it again states no second fact. */}
            <span>{settled.length} finished</span>
          </button>
          {settledOpen ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-4">
              {settled.map((thread) => (
                <SubagentRow key={thread.id} thread={thread} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}
