import { Bot, ListChecks, Maximize2 } from 'lucide-react';
import { memo, useContext } from 'react';

import { InitialsAvatar } from '../components/ui/avatar';
import { Button } from '../components/ui/button';
import {
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockTitle,
} from './block-shell';
import { formatElapsed, RunSettledContext, WorkingRow } from './live-row';
import { NestedThreadContext, SubagentDetailContext } from './subagent-context';
import { TaskCount } from './task-list';
import { taskProgress } from './task-payload';
import { TranscriptEntryView } from './transcript-entry';
import {
  countTools,
  type RunSettleAt,
  type SubagentBlockEntry,
  subagentBlockStatus,
  subagentTitle,
  type TaskListEntry,
} from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';

function shellStatusOf(
  block: SubagentBlockEntry,
  runSettledAt: RunSettleAt,
): BlockStatus {
  switch (subagentBlockStatus(block, runSettledAt)) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'stopped';
    default:
      return 'running';
  }
}

/**
 * How far the delegate is through its OWN task list, or null when it kept none.
 *
 * Read off the block's folded entries rather than the transcript, so it can only
 * ever describe rows this delegate actually produced — the same rule
 * {@link subagentSteps} follows, and the reason a delegate's list cannot leak
 * into the main agent's count or the other way round.
 */
function subagentTaskProgress(
  block: SubagentBlockEntry,
): { done: number; total: number } | null {
  const cards: TaskListEntry[] = [];
  const walk = (entries: SubagentBlockEntry['entries']): void => {
    for (const entry of entries) {
      if (entry.type === 'task-list') {
        cards.push(entry);
        continue;
      }
      if (entry.type === 'turn-block' || entry.type === 'call-block') {
        walk(entry.entries);
      }
    }
  };
  walk(block.entries);
  // The LAST card is the current list: each one already carries the fold of
  // every announcement before it.
  const tasks = cards.at(-1)?.tasks;
  if (tasks === undefined || tasks.length === 0) {
    return null;
  }
  const { done, total } = taskProgress(tasks);
  return { done, total };
}

/**
 * What is known about a delegate APART from what it said — the model it ran and
 * how long it took, when its CLI reports them.
 *
 * Renders nothing when neither is known, which is every claude delegate: its
 * work is the thread itself, so a metadata line would only repeat the header.
 * For a CLI that streams none of that work this is the whole substance of the
 * card, which is why it is stated rather than left in the payload.
 */
function SubagentFacts({
  block,
}: {
  block: SubagentBlockEntry;
}): React.JSX.Element | null {
  const facts: string[] = [];
  if (block.model !== null) {
    facts.push(block.model);
  }
  if (block.durationMs !== null) {
    facts.push(`took ${formatElapsed(block.durationMs)}`);
  }
  if (facts.length === 0) {
    return null;
  }
  return (
    <p
      data-role="subagent-facts"
      className="m-0 text-[11px] text-muted-foreground">
      {facts.join(' · ')}
    </p>
  );
}

/**
 * Why a delegate's conversation is absent, when the daemon said why.
 *
 * Only for a block with NOTHING in it: a delegate that reported one line and
 * then stopped streaming is a different case, and pinning a caveat under real
 * content would call working output incomplete.
 */
function SubagentStepsMissing({
  block,
}: {
  block: SubagentBlockEntry;
}): React.JSX.Element | null {
  if (block.entries.length > 0) {
    return null;
  }
  // The daemon's own sentence when there is one, and it outranks the generic
  // line: "has not done anything yet" is a claim about the DELEGATE, and saying
  // it about one whose steps this CLI never streams reports geniro's blind spot
  // as the sub-agent sitting idle — which is how it read for a cursor delegate
  // that had just spent thirteen seconds working.
  //
  // The generic line is only for a delegate that has genuinely not spoken YET,
  // so it is withheld from one that has RETURNED: a block carrying a result has
  // demonstrably done something, and beside that result the sentence is simply
  // false. It used to sit under a `Timeline` heading, where it read as "no
  // steps recorded"; the heading is gone (see {@link SubagentDetail}) and a
  // bare sentence has to be true on its own.
  const line =
    block.stepsUnavailableReason ??
    (block.returned || block.result !== null
      ? null
      : 'This sub-agent has not done anything yet.');
  if (line === null) {
    return null;
  }
  return (
    <p
      data-role="subagent-steps-missing"
      className="m-0 text-[11px] text-muted-foreground">
      {line}
    </p>
  );
}

/**
 * One sub-agent's conversation, for the detail dialog the panel row and the
 * block's own control open.
 *
 * **There is no timeline half any more.** It was a second reading of the very
 * entries below it — one line per tool call, message and task move — sitting
 * above the thread it was derived from, and it is the first thing a reader had
 * to scroll past to reach the conversation they opened the dialog for. The
 * report was blunt about which of the two answers the question: "we dont need
 * timeline - we can check messages instead". With it went `subagentSteps` and
 * its step type: nothing else built one, and a folder left behind for a surface
 * that no longer exists is how a codebase grows a second, drifting truth.
 *
 * What remains is one section, so it carries no heading: `Conversation` over
 * the only thing in the dialog is a heading repeated as its own content, and
 * the dialog's title already names what this is.
 */
export function SubagentDetail({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <SubagentThread
        block={block}
        nodes={nodes}
        chatAgentName={chatAgentName}
      />
    </div>
  );
}

/**
 * The BODY of a sub-agent block — its request, its thread, its result.
 *
 * Exported because the detail dialog shows exactly this: the whole point of
 * the popup is that the delegate's conversation reads identically wherever it
 * is opened, and two renderings of one thread is how they come to differ.
 */
export function SubagentThread({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const title = subagentTitle(block);
  // Read from the SAME source the header's own spinner uses, so the block
  // cannot show a live row under a header that says the delegate has stopped.
  const runSettledAt = useContext(RunSettledContext);
  const working = subagentBlockStatus(block, runSettledAt) === 'running';
  return (
    <NestedThreadContext.Provider value={true}>
      {block.prompt ? (
        <BlockRequest label={`Task for ${title}`} text={block.prompt} />
      ) : null}
      <SubagentFacts block={block} />
      {/* Above the (empty) thread rather than below the result: it explains why
          there is nothing between here and there, and a caveat placed after the
          result reads as a caveat ABOUT the result. */}
      <SubagentStepsMissing block={block} />
      {block.entries.map((entry) => (
        <TranscriptEntryView
          key={entry.type === 'item' ? entry.item.id : entry.id}
          entry={entry}
          nodes={nodes}
          chatAgentName={chatAgentName}
        />
      ))}
      {/*
        The same live row the main flow ends on, for a delegate that is still
        going. Without it a sub-agent's thread — and the popup that shows the
        same thread at full width — simply stopped at whatever it last said,
        with nothing telling a delegate that is thinking apart from one that has
        wedged. The header's spinner says it is running; this says the same
        thing where the reader is actually looking, and carries the clock.

        `lastRowAt` rather than mount time, exactly as the main flow's does:
        reopening the popup would otherwise restart the count and report a
        four-minute wait as one second.

        It carries no PHRASE — see `WorkingRow`, which stands the activity down
        inside a nested thread because the run's phrase belongs to the parent.
      */}
      {working ? <WorkingRow since={block.lastRowAt} /> : null}
      {block.result ? (
        <BlockResult label={`Result from ${title}`} text={block.result} />
      ) : null}
      {/*
        No footer. It used to close every delegate's thread with `<title> is
        working...` and `N tools` — both of which the header directly above
        already says, and says better: the status is a spinner and a chip, the
        tool count is a chip, and both are legible with the block still closed.
        Repeating them under the thread put the delegate's NAME back on screen a
        third time, in the place a reader is looking for what it produced. The
        call block keeps its own footer, which heads no such header.
      */}
    </NestedThreadContext.Provider>
  );
}

/**
 * One background sub-agent as a collapsed aside in the conversation.
 *
 * Drawn on the same {@link BlockShell} as the agent-call block, and closed by
 * default — which is the difference that matters. A delegate's run of work is
 * not part of the conversation the reader is having; it is a thing that
 * happened underneath it. Open, it shows exactly the thread the detail dialog
 * shows, which is exactly the thread the main flow renders — one
 * {@link TranscriptEntryView} pass, so a delegate's messages, tool groups and
 * reasoning look the way they look anywhere else.
 */
export const SubagentBlock = memo(function SubagentBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const openDetail = useContext(SubagentDetailContext);
  const runSettledAt = useContext(RunSettledContext);
  const title = subagentTitle(block);
  const toolCount = countTools(block.entries);
  const tasks = subagentTaskProgress(block);
  return (
    <div data-role="subagent-block" data-subagent={block.id} className="w-full">
      <BlockShell
        eyebrow="Sub-agent"
        eyebrowIcon={<Bot aria-hidden="true" className="size-3" />}
        status={shellStatusOf(block, runSettledAt)}
        collapsible
        toggleLabel={`Show ${title}'s conversation`}
        header={
          <>
            {/* `sm` — a 20px disc rather than 32px. At the old size the avatar
                set the height of the whole header, so a closed delegate was a
                44px band for one line of text. It is still the thing that tells
                two parallel delegates apart at a glance, which is why it is
                shrunk rather than dropped. */}
            <InitialsAvatar name={title} colorKey={block.id} size="sm" />
            <BlockTitle>{title}</BlockTitle>
            {/* The three facts about the delegate as ONE run of text with
                middots, not three spans the header's `gap-2` pushes apart. They
                answer one question — what this delegate is and how much it did —
                and spaced out they read as three unrelated chips. */}
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
              {block.kind && block.label ? <span>{block.kind}</span> : null}
              {block.kind && block.label && toolCount > 0 ? (
                <span>·</span>
              ) : null}
              {toolCount > 0 ? (
                <span>
                  {toolCount} tool{toolCount === 1 ? '' : 's'}
                </span>
              ) : null}
              {/* On the header rather than only inside, because the block is
                  CLOSED by default: "how far is this delegate through its own
                  plan" is the one thing worth knowing without opening it. */}
              {tasks !== null ? (
                <>
                  {block.kind || toolCount > 0 ? <span>·</span> : null}
                  <ListChecks aria-hidden="true" className="size-3" />
                  <TaskCount done={tasks.done} total={tasks.total} />
                </>
              ) : null}
            </span>
          </>
        }
        // A real <button>, and it sits BESIDE the disclosure rather than
        // inside it: interactive content nested in a <button> is invalid HTML
        // whatever role it carries, and a control there also swallows presses
        // meant for the toggle.
        headerAction={
          openDetail ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground"
              aria-label={`Open ${title} in a panel`}
              title="Open this sub-agent's conversation"
              onClick={() => openDetail(block)}>
              <Maximize2 className="size-3 shrink-0" />
            </Button>
          ) : null
        }>
        <SubagentThread
          block={block}
          nodes={nodes}
          chatAgentName={chatAgentName}
        />
      </BlockShell>
    </div>
  );
});
