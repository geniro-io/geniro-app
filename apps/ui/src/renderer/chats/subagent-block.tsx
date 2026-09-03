import { Bot, ListChecks, Maximize2 } from 'lucide-react';
import { memo, useContext } from 'react';

import { InitialsAvatar } from '../components/ui/avatar';
import { Button } from '../components/ui/button';
import { formatExactUsd, formatTokens } from './agent-activity';
import {
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockStatusIcon,
  blockStatusLabel,
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
    // Carried through rather than folded into `running`: this delegate is not
    // producing anything, and drawing a spinner over it is the half of the
    // reported oscillation that the derivation itself no longer emits.
    case 'unknown':
      return 'unknown';
    case 'running':
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
 * What is known about a delegate APART from what it said — the model it ran,
 * what it spent, and how long it took, as its CLI reports them.
 *
 * `factsStated` is the caller saying it has ALREADY printed them. The block
 * has: they sit on its header, where they are legible with the block still
 * shut, so repeating them under it is one reading printed twice a couple of
 * inches apart — the complaint this surface already has on record about its
 * context meter. The detail DIALOG has no header of its own, so there they are
 * the only statement of what this delegate ran on and what it cost, and are
 * always drawn.
 */
function SubagentFacts({
  block,
  factsStated,
}: {
  block: SubagentBlockEntry;
  factsStated: boolean;
}): React.JSX.Element | null {
  const facts = factsStated
    ? []
    : [
        ...(block.model === null ? [] : [block.model]),
        ...subagentSpendParts(block),
      ];
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
 * The present facts, with a middot between each pair and nowhere else.
 *
 * Takes nulls so a caller can list every possible fact in reading order and let
 * this decide which survive — the alternative being a separator condition that
 * names its neighbours, which is what the header had and what it could not
 * carry two more facts of.
 */
function joinFacts(facts: readonly React.ReactNode[]): React.ReactNode[] {
  const present = facts.filter((fact) => fact !== null && fact !== false);
  return present.flatMap((fact, index) =>
    index === 0 ? [fact] : [<span key={`sep-${index}`}>·</span>, fact],
  );
}

/**
 * What this delegate COST, as the words the header prints — its money, its
 * tokens and how long it ran.
 *
 * REPORTED as "in front of each agent i wanna see amount of tokens/costs/time",
 * against a transcript of collapsed delegate rows that said only
 * `general-purpose · 49 tools`, and then a second time when the tokens were
 * there but the money was not.
 *
 * **The money is APPROXIMATE and says so.** No CLI states a delegate's cost —
 * re-probed on claude 2.1.251, every channel describing a delegate carries
 * tokens and no dollars, and the turn's own price covers the main thread and
 * all of its delegates together. The daemon derives it instead, calibrating a
 * list-price table against what the CLI charged for that very turn; the `≈` is
 * the whole of what distinguishes it from the exact per-turn figures elsewhere
 * in this app, so it never renders without one.
 *
 * An empty list renders nothing at all: every CLI but claude reports none of
 * this, and a `— tokens` placeholder on every delegate row would be noise about
 * a blind spot the reader can do nothing with. A null cost drops out the same
 * way, which is the required reading — a delegate whose model this build cannot
 * price has an unknown cost, not a zero one.
 */
function subagentSpendParts(block: SubagentBlockEntry): string[] {
  const parts: string[] = [];
  if (block.costUsd !== null) {
    parts.push(`≈${formatExactUsd(block.costUsd)}`);
  }
  if (block.tokens !== null) {
    parts.push(`${formatTokens(block.tokens)} tokens`);
  }
  if (block.durationMs !== null) {
    // `took` stays on the word, header included. A bare `2s` on a row that
    // already reads `49 tools · 26.1k tokens` is as easily read as an age —
    // "this happened 2s ago" — which is the one thing it does not mean, and it
    // is the same wording the detail dialog has always used.
    parts.push(`took ${formatElapsed(block.durationMs)}`);
  }
  return parts;
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
  // so it is withheld from one whose OWN result is here: a block carrying that
  // has demonstrably done something, and beside it the sentence is simply
  // false. It used to sit under a `Timeline` heading, where it read as "no
  // steps recorded"; the heading is gone (see {@link SubagentDetail}) and a
  // bare sentence has to be true on its own.
  //
  // `resultIsOwn` rather than `returned || result !== null`, which is what it
  // was: a backgrounded delegate's launch is acknowledged within the second,
  // so both of those are true before it has done anything at all — and the one
  // line explaining why the thread below is empty was suppressed on precisely
  // the delegates whose thread is empty for that reason.
  const line =
    block.stepsUnavailableReason ??
    (block.resultIsOwn ? null : 'This sub-agent has not done anything yet.');
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
 * That the delegate ENDED, for a block where nothing else would say so.
 *
 * REPORTED against a finished cursor delegate as "cursor agent doesn't seem to
 * have success message". Its body is the brief, the model, and the sentence
 * explaining that this CLI streams none of the delegate's steps — and not one
 * of those three changes when the work finishes, so a delegate that ran for a
 * minute and came back reads exactly like one that did nothing. What marks the
 * ending is a 14px check in the header, which is not where a reader who has
 * opened the block is looking.
 *
 * Deliberately narrow, and the condition is the whole argument: only a body
 * with NO entries and no result that is the delegate's OWN.
 * {@link SubagentBlockEntry.resultIsOwn} and not merely `result`, on that
 * field's own reading: a launch acknowledgement is the CLI answering the
 * launching call, not the delegate reporting, so a block showing one under
 * `Reply to the launching call` still has nothing in it that says the work
 * ended. A delegate that streamed its work
 * ends on that work, and one whose answer is printed ends on the answer —
 * stating it a second time there is the footer this thread already removed
 * once, for repeating what the header says better. This states what neither
 * says: nothing else in the body reports the outcome.
 *
 * The word comes from the block vocabulary's own table
 * ({@link blockStatusLabel}), never a literal here, so a delegate cut off by
 * Stop reads `cancelled` in the same sentence its header, its panel row and
 * the run badge use.
 */
function SubagentEnded({
  block,
  status,
}: {
  block: SubagentBlockEntry;
  status: BlockStatus;
}): React.JSX.Element | null {
  if (status === 'running' || block.entries.length > 0 || block.resultIsOwn) {
    return null;
  }
  return (
    <p
      data-role="subagent-ended"
      className="m-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <BlockStatusIcon status={status} className="size-3" />
      <span>Sub-agent {blockStatusLabel(status)}</span>
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
  factsStated = false,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
  /**
   * The caller's own chrome already states the model, the tokens and the
   * duration.
   */
  factsStated?: boolean;
}): React.JSX.Element {
  const title = subagentTitle(block);
  // Read from the SAME source the header's own spinner uses, so the block
  // cannot show a live row under a header that says the delegate has stopped.
  const runSettledAt = useContext(RunSettledContext);
  // ONE reading for both the live row and the ending below it, so the thread
  // can never show a spinner and a "completed" line at once.
  const status = shellStatusOf(block, runSettledAt);
  const working = status === 'running';
  return (
    <NestedThreadContext.Provider value={true}>
      {block.prompt ? (
        <BlockRequest label={`Task for ${title}`} text={block.prompt} />
      ) : null}
      <SubagentFacts block={block} factsStated={factsStated} />
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
        <BlockResult
          // Whose answer this is, said in the heading — see
          // `SubagentBlockEntry.resultIsOwn`. A backgrounded delegate's call is
          // answered with a launch acknowledgement while the work is still to
          // come, and calling that "Result from X" beside a spinner reporting X
          // as working is the card contradicting itself in two inches.
          label={
            block.resultIsOwn
              ? `Result from ${title}`
              : 'Reply to the launching call'
          }
          text={block.result}
        />
      ) : null}
      <SubagentEnded block={block} status={status} />
      {/*
        No footer beyond that one line. It used to close every delegate's
        thread with `<title> is
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
            {/* Every fact about the delegate as ONE run of text with middots,
                not a span per fact that the header's `gap-2` pushes apart. They
                answer one question — what this delegate is and what it did —
                and spaced out they read as unrelated chips.

                Interleaved from a LIST rather than by a separator condition per
                pair: at three facts that was already three conditions naming
                each other, and adding the tokens and the duration would have
                made it six, each of which is a place for a leading or doubled
                middot to appear on some combination nobody thought to check. */}
            {/* SHRINKABLE, and capped, which the title's own `flex-1 basis-0`
                cannot do for itself: every other child of this row is
                unshrinkable, so an unshrinkable fact run left `BlockTitle` the
                only thing that could give way — and the name is the one thing
                that tells two parallel delegates apart, so it was the first to
                go. The run has grown to six facts, and past the cap it clips
                its own tail (the task progress, which the card's
                `overflow-hidden` was clipping anyway) instead of taking the
                name with it. */}
            <span className="flex min-w-0 max-w-[55%] shrink items-center gap-1 overflow-hidden text-[10px] text-muted-foreground">
              {joinFacts([
                block.kind && block.label ? (
                  <span key="kind">{block.kind}</span>
                ) : null,
                /* WHICH MODEL it ran, asked for by name against a column of a
                   dozen verifiers that named their agent type and nothing
                   else. On the header rather than only inside the block for
                   the reason the figures are: it is closed by default, and a
                   fact behind a click is one nobody reads while scanning. */
                block.model ? <span key="model">{block.model}</span> : null,
                toolCount > 0 ? (
                  <span key="tools">
                    {toolCount} tool{toolCount === 1 ? '' : 's'}
                  </span>
                ) : null,
                /* What it spent, and how long it took — the reported ask. On
                   the header and not only inside for the same reason the task
                   progress is: the block is CLOSED by default, so a figure that
                   needs a click is a figure nobody reads while scanning a
                   column of twenty delegates. */
                ...subagentSpendParts(block).map((part) => (
                  <span key={part}>{part}</span>
                )),
                /* On the header rather than only inside, because the block is
                   CLOSED by default: "how far is this delegate through its own
                   plan" is the one thing worth knowing without opening it. */
                tasks !== null ? (
                  <span key="tasks" className="flex items-center gap-1">
                    <ListChecks aria-hidden="true" className="size-3" />
                    <TaskCount done={tasks.done} total={tasks.total} />
                  </span>
                ) : null,
              ])}
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
          // The header above states them — see {@link SubagentFacts}.
          factsStated
        />
      </BlockShell>
    </div>
  );
});
