import { Bot } from 'lucide-react';

import { cn } from '../components/ui/utils';
import type { AgentThread } from './agent-activity';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

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
 * Which delegates go FIRST: the ones still working.
 *
 * The rows arrive in the agents panel's own order, which puts them under the
 * agent that launched each — right for a column of cards, wrong for one flat
 * list, because a fan-out that spawned forty and finished thirty-eight buries
 * the two live ones somewhere in the middle of a scrolling box. That is the
 * exact problem the panel answers by folding its settled rows away, and this
 * list cannot fold (it is already inside a popover), so it sorts instead.
 *
 * STABLE within each half — `Array.prototype.sort` is required to be, and the
 * comparator returns 0 for two rows on the same side — so the panel's order
 * survives inside the running block and inside the settled one.
 */
function runningFirst(threads: readonly AgentThread[]): readonly AgentThread[] {
  return [...threads].sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1;
    const bRunning = b.status === 'running' ? 0 : 1;
    return aRunning - bRunning;
  });
}

/**
 * Every delegate this thread has launched, each stating its own status through
 * the app's one status vocabulary ({@link RunStatusIcon}) — so a delegate that
 * finished, one that failed and one still working are told apart here exactly
 * as they are in the agents panel.
 *
 * The count in front of this list is the RUNNING ones only, and the list is all
 * of them on purpose: a chip reading `Sub-agents 2` over a box holding just two
 * rows says nothing a reader could not already see, while `2` over two spinners
 * and eleven finished rows says what the turn has been doing.
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
  if (threads.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No sub-agents yet — this thread&rsquo;s agent has delegated nothing.
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {runningFirst(threads).map((thread) => (
        <li
          key={thread.id}
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
              // medium weight, so without it this row would render half again
              // the size of the status word beside it — the same correction the
              // agents panel's own delegate rows carry.
              className="min-w-0 flex-1 truncate rounded text-left text-xs font-normal text-foreground transition-colors hover:underline"
              title={`Open ${thread.label}'s timeline and conversation`}
              onClick={() => onOpen(thread.id)}>
              {thread.label}
            </button>
          )}
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
