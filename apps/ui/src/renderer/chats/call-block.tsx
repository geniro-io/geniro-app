import { ArrowRight, ArrowRightLeft } from 'lucide-react';
import { memo } from 'react';

import { HoverPopover } from '../components/hover-popover';
import { avatarTone, initialsOf } from '../components/ui/avatar';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import { formatExactUsd, formatTokens } from './agent-activity';
import { shortAgentLabel } from './agent-label';
import {
  BlockPendingLine,
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockTitle,
  BlockToolFooter,
} from './block-shell';
import { ContextMeter } from './context-meter';
import { liveRowKind } from './live-row';
import { NestedThreadContext } from './subagent-context';
import { TaskCount, TaskIcon, TaskScrollRows } from './task-list';
import type { AgentTaskRow } from './task-payload';
import { taskProgress } from './task-payload';
import { TranscriptEntryView } from './transcript-entry';
import {
  callBlockContext,
  type CallBlockEntry,
  callBlockSummary,
  callBlockTasks,
  callBlockUsage,
  countTools,
} from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';

function blockStatusOf(status: CallBlockEntry['status']): BlockStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'stopped';
    default:
      return 'running';
  }
}

/** Geniro web's AgentAvatars pair (caller → callee) for the block header. */
function AvatarPair({
  caller,
  callerKey,
  callee,
  calleeKey,
}: {
  caller: string;
  callerKey: string;
  callee: string;
  calleeKey: string;
}): React.JSX.Element {
  const chip = (name: string, key: string): React.JSX.Element => (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full text-[8px] leading-none font-bold text-primary-foreground',
        avatarTone(key),
      )}>
      {initialsOf(name)}
    </span>
  );
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chip(caller, callerKey)}
      <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
      {chip(callee, calleeKey)}
    </span>
  );
}

/**
 * The callee's task list behind a glyph and its `done/total` — on the SHUT
 * card, where the list itself is folded away.
 *
 * ASKED FOR as "also current tasks icon with popover", beside the figures. A
 * checklist is the one thing in a call block that answers "how far through is
 * it" without reading anything, and folding the card had put it two clicks
 * away.
 *
 * Drawn only when the callee keeps a list — a chip reading `0/0` states that
 * this agent has no plan, which is not a fact about its progress. The popover
 * is the SAME {@link TaskScrollRows} the composer shelf and the agents panel
 * draw, bounded and following the running row, so three surfaces cannot
 * disagree about one list.
 *
 * It opens UPWARD only if it must: a call block sits anywhere in a scrolling
 * transcript, so `bottom` is right for the common case and `Popover`'s own
 * clamping keeps it on screen at the edges.
 */
function CallTaskChip({
  tasks,
  live,
  callee,
}: {
  tasks: readonly AgentTaskRow[];
  live: boolean;
  callee: string;
}): React.JSX.Element | null {
  if (tasks.length === 0) {
    return null;
  }
  const { done, total } = taskProgress(tasks);
  return (
    <HoverPopover
      slot="call-tasks"
      label={`${done} of ${total} ${total === 1 ? 'task' : 'tasks'} done \u2014 ${callee}`}
      panelLabel={`${callee}'s task list`}
      panelClassName="w-[20rem]"
      className="shrink-0"
      triggerClassName="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-normal text-muted-foreground transition-colors hover:bg-muted"
      trigger={
        <>
          <TaskIcon className="size-3 text-muted-foreground" />
          <span className="tabular-nums">
            <TaskCount done={done} total={total} />
          </span>
        </>
      }>
      <TaskScrollRows tasks={tasks} live={live} />
    </HoverPopover>
  );
}

/**
 * One agent-to-agent call — geniro web's CommunicationBlock, always
 * expanded: an "Agent communication" eyebrow, a neutral card whose header
 * carries the caller→callee avatar pair, the name line, a live spinner and
 * the status chip; the body holds the clamped "Instructions for X" section,
 * the callee's streamed work (each entry in its own sender frame), the
 * clamped "Result from X" (or error) section, and an "N tools" footer.
 *
 * The card chrome itself lives in {@link BlockShell}, shared with the
 * sub-agent block.
 *
 * It is COLLAPSIBLE and shut to start, which REVERSES what shipped first. The
 * old reasoning — "a call is the point of the row it sits on, so it stays
 * open" — is true of one call and false of the conversation a workflow
 * actually produces: a manager routing work to three agents draws three cards
 * each holding a clamped brief, the callee's whole sub-turn and a clamped
 * result, so the caller's own sentences are pages apart and the transcript
 * reads as somebody else's inbox. REPORTED as "those blocks should be
 * collapsable. By default it should be collapsed."
 *
 * What a shut card still says is the point of the rest of that report — "we
 * always should see last message there, like its current state": the header
 * carries the pair, the CLI and the live spinner, and {@link callBlockSummary}
 * puts the callee's newest words under it. So the fold costs the reader
 * nothing they were scanning for; opening one is for the work behind it.
 */
export const CallBlock = memo(function CallBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: CallBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (nodes?.get(id)?.name ?? id);
  const callee = nameOf(block.calleeNodeId) ?? 'agent';
  const caller = nameOf(block.callerNodeId);
  const calleeAgent = shortAgentLabel(
    block.calleeNodeId === null
      ? null
      : (nodes?.get(block.calleeNodeId)?.agent ?? null),
  );
  const agentBadge = calleeAgent === callee ? null : calleeAgent;
  const status = blockStatusOf(block.status);
  const toolCount = countTools(block.entries);
  const usage = callBlockUsage(block);
  const context = callBlockContext(block);
  const tasks = callBlockTasks(block);
  const failed = block.status === 'failed';
  // The callee's live row draws its own spinner and its own clock, so the
  // static hint below it would be the second line in a row saying the same
  // agent is still going.
  const tail = block.entries[block.entries.length - 1];
  const liveTail =
    tail?.type === 'item' && liveRowKind(tail.item.payload) !== null;
  const summaryText = callBlockSummary(block);
  /**
   * A shut card must still say its state, and between `call_started` and the
   * callee's first non-status row there are no words, no tasks and no figures
   * to say it with.
   */
  const pending = status === 'running' && summaryText === null;
  /**
   * Whether there is anything to put in the band at all — `BlockShell` renders
   * it on `summary ?`, and an element is always truthy, so the caller has to
   * pass `undefined` to say it has nothing to show.
   */
  const hasSummary =
    summaryText !== null ||
    pending ||
    tasks.length > 0 ||
    usage.tokens !== null ||
    usage.costUsd !== null ||
    context.contextTokens !== null;
  return (
    <div data-role="call-block" className="w-full">
      <BlockShell
        eyebrow="Agent communication"
        eyebrowIcon={<ArrowRightLeft aria-hidden="true" className="size-3" />}
        status={status}
        collapsible
        toggleLabel={
          caller ? `${caller} → ${callee} call` : `Call to ${callee}`
        }
        summary={
          hasSummary ? (
            <>
              {pending ? (
                // The same sentence the OPEN card shows in this state, so the
                // fold changes what is on screen and not what is true.
                <BlockPendingLine>{callee} is thinking...</BlockPendingLine>
              ) : (
                /* The words give way — the figures and the chip beside them are a
                 fixed handful of characters, while a callee's last message is a
                 paragraph. */
                <span className="min-w-0 flex-1 truncate">
                  {summaryText ?? ''}
                </span>
              )}
              {/* WHAT IT IS ON, without opening the card — asked for beside the
                figures ("also current tasks icon with popover"). The list is
                the callee's own, folded out of this block, so a card that is
                shut still answers the question a reader opens it for. */}
              <CallTaskChip
                tasks={tasks}
                live={status === 'running'}
                callee={callee}
              />
              {/* HOW FULL the callee's own window is — the one figure about
                this call that the caller's ring cannot state, each side of a
                call holding a window of its own. `runId` is deliberately null:
                that prop opens the run-wide breakdown, which is a question the
                run's one live process cannot answer for a particular call. */}
              {context.contextTokens === null ? null : (
                <span data-slot="call-summary-context" className="shrink-0">
                  <ContextMeter
                    runId={null}
                    contextTokens={context.contextTokens}
                    contextWindowTokens={context.contextWindowTokens}
                  />
                </span>
              )}
              {usage.tokens === null ? null : (
                <span
                  data-slot="call-summary-tokens"
                  className="shrink-0 tabular-nums">
                  {formatTokens(usage.tokens)} tokens
                </span>
              )}
              {usage.costUsd === null ? null : (
                <span
                  data-slot="call-summary-cost"
                  className="shrink-0 tabular-nums">
                  {formatExactUsd(usage.costUsd)}
                </span>
              )}
            </>
          ) : undefined
        }
        header={
          <>
            {caller ? (
              <AvatarPair
                caller={caller}
                callerKey={block.callerNodeId ?? caller}
                callee={callee}
                calleeKey={block.calleeNodeId ?? callee}
              />
            ) : null}
            <BlockTitle>{caller ? `${caller} → ${callee}` : callee}</BlockTitle>
            {/* WHICH CLI answered. The card is the callee's work, so it is the
                callee's binary that is named — a graph routinely mixes the two,
                and a node's name is the user's word for a persona rather than a
                statement about what is under it. Dropped when it would repeat
                the name beside it (a node called `claude` on claude), the same
                rule the agents panel's card badge follows, and drawn as nothing
                at all when the graph does not say — an unstated agent is not a
                fact about the agent. */}
            {agentBadge ? (
              <Badge variant="muted" className="shrink-0">
                {agentBadge}
              </Badge>
            ) : null}
          </>
        }>
        {block.message ? (
          <BlockRequest
            label={`Providing instructions for ${callee}`}
            text={block.message}
          />
        ) : null}
        {/*
          The card's header IS the callee's identity, so its rows carry none of
          their own — the same rule, and the same context, the sub-agent block
          applies to a delegate's thread. Without it every message the callee
          streamed wore an avatar and a `<callee> · 14:51` line of its own, so a
          six-message sub-turn drew the same face six times inside a card whose
          header had just named it. Reported as "иконка инженера просто
          дублируется — она должна быть просто один раз в хедере блока".
        */}
        <NestedThreadContext.Provider value={true}>
          {block.entries.map((entry) => (
            <TranscriptEntryView
              key={entry.type === 'item' ? entry.item.id : entry.id}
              entry={entry}
              nodes={nodes}
              chatAgentName={chatAgentName}
            />
          ))}
        </NestedThreadContext.Provider>
        {block.result ? (
          <BlockResult label={`Result from ${callee}`} text={block.result} />
        ) : null}
        {status === 'running' && !liveTail ? (
          <BlockPendingLine>{callee} is thinking...</BlockPendingLine>
        ) : null}
        <BlockToolFooter
          count={toolCount}
          // What this callee has spent, summed from its OWN `turn_complete`
          // rows inside the block — so the figure grows as its turns land
          // rather than being a total somebody has to go and look up.
          tokens={usage.tokens}
          costUsd={usage.costUsd}
          note={failed ? <span>finished with an error</span> : undefined}
        />
      </BlockShell>
    </div>
  );
});
