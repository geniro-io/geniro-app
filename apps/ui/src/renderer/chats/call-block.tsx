import { ArrowRight, ArrowRightLeft } from 'lucide-react';
import { memo, useContext } from 'react';

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
import { CalleeContextResolverContext } from './call-context';
import { ContextMeter } from './context-meter';
import { liveRowKind } from './live-row';
import { NestedThreadContext } from './subagent-context';
import { TaskCount, TaskIcon, TaskScrollRows } from './task-list';
import type { AgentTaskRow } from './task-payload';
import { taskProgress } from './task-payload';
import { TranscriptEntryView } from './transcript-entry';
import {
  callBlockActivity,
  callBlockContext,
  type CallBlockEntry,
  callBlockSummary,
  callBlockTasks,
  callBlockUsage,
  countTools,
  isCallContinuation,
} from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';
import { payloadString } from './transcript-payload';

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
 * The callee's figures — its task chip, how full its window is, and what it
 * spent — drawn ONE way whether the card is shut or open.
 *
 * REPORTED as "i wanna have same design of elements for footer when
 * uncollapsing agent conversation as in collapsed - with circle and so on": the
 * shut band drew the task chip and the context RING, while opening the card
 * swapped them for a plain-text footer reading `96 tools 233k ctx`, so opening
 * a card changed how its numbers looked rather than only what else was shown.
 * One component for both is what keeps the two states from drifting apart
 * again. `slot` only names the hooks, since the two are never on screen at once.
 */
function CallFigures({
  slot,
  tasks,
  live,
  callee,
  contextTokens,
  contextWindowTokens,
  tokens,
  costUsd,
}: {
  slot: 'call-summary' | 'call-footer';
  tasks: readonly AgentTaskRow[];
  live: boolean;
  callee: string;
  contextTokens: number | null;
  contextWindowTokens: number | null;
  tokens: number | null;
  costUsd: number | null;
}): React.JSX.Element {
  return (
    <>
      {/* WHAT IT IS ON, without opening the card — asked for beside the
          figures ("also current tasks icon with popover"). The list is the
          callee's own, folded out of this block. */}
      <CallTaskChip tasks={tasks} live={live} callee={callee} />
      {/* HOW FULL the callee's own window is — the one figure about this call
          that the caller's ring cannot state, each side of a call holding a
          window of its own. `runId` is deliberately null: that prop opens the
          run-wide breakdown, which is a question the run's one live process
          cannot answer for a particular call. */}
      {contextTokens === null ? null : (
        <span data-slot={`${slot}-context`} className="shrink-0">
          <ContextMeter
            runId={null}
            contextTokens={contextTokens}
            contextWindowTokens={contextWindowTokens}
          />
        </span>
      )}
      {/* The ring's own figure, in words. This slot used to print the callee's
          input + output as "N tokens" right beside the ring, and it was read as
          the context — REPORTED as wrong numbers over a call reading "838
          tokens" whose window held 843k. What a call SPENT is its cost beside
          it; the in/out split rides the hover, said for what it is. */}
      {contextTokens === null ? null : (
        <span
          data-slot={`${slot}-tokens`}
          title={
            tokens === null
              ? undefined
              : `${formatTokens(tokens)} tokens in/out`
          }
          className="shrink-0 tabular-nums">
          {contextWindowTokens === null
            ? `${formatTokens(contextTokens)} context`
            : `${formatTokens(contextTokens)} / ${formatTokens(contextWindowTokens)}`}
        </span>
      )}
      {costUsd === null ? null : (
        <span data-slot={`${slot}-cost`} className="shrink-0 tabular-nums">
          {formatExactUsd(costUsd)}
        </span>
      )}
    </>
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
  const foldedUsage = callBlockUsage(block);
  /**
   * The callee's window, live first and the block's own settled rows last.
   *
   * The fold alone could only ever answer AFTER the call — a `turn_complete` is
   * the one row it reads and the callee has not written one yet — so the ring
   * was blank for the whole of every call and appeared at the moment it stopped
   * being worth watching. REPORTED against a running cursor call, and measured
   * on that same run: no ring for 46 seconds, then `80.4k / 200k` at the settle.
   *
   * Each figure falls back on its own, the rule `resolveCalleeContext` states in
   * full: a source that reports one half says nothing about the other, so a
   * live delta carrying only a count must not erase a window the settled turn
   * already had.
   *
   * The resolver is handed every call of the conversation, so a continuation
   * that has not reported yet reads on the same rule the agents panel's instance
   * ring does (`CalleeContextResolver`).
   */
  const folded = callBlockContext(block);
  const resolveCallReading = useContext(CalleeContextResolverContext);
  const live =
    resolveCallReading !== null && block.calleeNodeId !== null
      ? resolveCallReading(block.calleeNodeId, block.callIds)
      : null;
  // The daemon's whole-run spend for this conversation, over the window's
  // fold — a call that started above the loaded window, or was continued many
  // times, otherwise states only the part of its cost on screen.
  const usage = live?.spend ?? foldedUsage;
  const context = {
    contextTokens: live?.contextTokens ?? folded.contextTokens,
    contextWindowTokens:
      live?.contextWindowTokens ?? folded.contextWindowTokens,
  };
  const tasks = callBlockTasks(block);
  const failed = block.status === 'failed';
  const identityText = caller ? `${caller} → ${callee}` : callee;
  const baseToggleLabel = caller ? `${identityText} call` : `Call to ${callee}`;
  /**
   * The accessible name for the disclosure button says WHY the call was made
   * before it says WHO it was to, matching what a sighted reader sees on the
   * header; with no reason on record it names the call by its pair alone.
   */
  const toggleLabel = block.title
    ? `${block.title} — ${baseToggleLabel}`
    : baseToggleLabel;
  const requestLabel = `Providing instructions for ${callee}`;
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
   * What to say while the callee has produced no words yet — composed ONCE,
   * because the shut band and the open card both show it.
   *
   * Not gated on {@link pending}: the open card draws this line under a
   * different condition (running, with no live row of its own), so a lookup
   * tied to the shut card's state would leave that one saying `is thinking...`
   * about a callee three tools deep.
   */
  const activity = callBlockActivity(block);
  /**
   * A STALLED call outranks both — naming the tool it was last on would report
   * work that is no longer happening, and `is thinking...` would be the same
   * claim in softer words. The call is still open; only its silence is
   * reported. A later callee row clears `stalled` upstream, so this cannot
   * outlive the silence it describes.
   */
  const pendingLine = block.stalled
    ? `${callee} has gone quiet — the call is still open`
    : activity === null
      ? `${callee} is thinking...`
      : `${callee} is running ${activity}`;
  /**
   * Whether there is anything to put in the band at all — `BlockShell` renders
   * it on `summary ?`, and an element is always truthy, so the caller has to
   * pass `undefined` to say it has nothing to show.
   */
  const hasFigures =
    tasks.length > 0 ||
    usage.costUsd !== null ||
    context.contextTokens !== null;
  const figures = (slot: 'call-summary' | 'call-footer'): React.JSX.Element => (
    <CallFigures
      slot={slot}
      tasks={tasks}
      live={status === 'running'}
      callee={callee}
      contextTokens={context.contextTokens}
      contextWindowTokens={context.contextWindowTokens}
      tokens={usage.tokens}
      costUsd={usage.costUsd}
    />
  );
  const hasSummary =
    summaryText !== null ||
    pending ||
    // A call that has gone quiet with nothing else to show still owes the
    // reader that one fact, so it earns the band on its own — on the same
    // terms the marker itself is drawn, or the band could open empty.
    (block.stalled && status === 'running') ||
    hasFigures;
  return (
    <div data-role="call-block" className="w-full">
      <BlockShell
        eyebrow="Agent communication"
        eyebrowIcon={<ArrowRightLeft aria-hidden="true" className="size-3" />}
        status={status}
        collapsible
        memoryKey={`call:${block.id}`}
        toggleLabel={toggleLabel}
        summary={
          hasSummary ? (
            <>
              {pending ? (
                // The same sentence the OPEN card shows in this state, so the
                // fold changes what is on screen and not what is true. ONE
                // line here, which is this band's own rule — its other arm has
                // always truncated, and this arm grew the shut card for the
                // same reason it grew the open one: an ACP tool name is
                // routinely a whole shell command.
                <BlockPendingLine clamp="one">{pendingLine}</BlockPendingLine>
              ) : (
                /* The words give way — the figures and the chip beside them are a
                 fixed handful of characters, while a callee's last message is a
                 paragraph. */
                <span className="min-w-0 flex-1 truncate">
                  {summaryText ?? ''}
                </span>
              )}
              {/* GONE QUIET — its own marker rather than a variation on the
                pending line, because that line is drawn only while there are
                no words yet: a callee that spoke and THEN stopped is exactly
                the case worth reporting, and it would have had none. Muted
                rather than destructive: nothing has failed and nothing has
                been cancelled, so the loudest tone on the page would be a
                claim this row is careful not to make. */}
              {block.stalled && status === 'running' ? (
                <span
                  data-slot="call-summary-stalled"
                  title={`${callee} has produced nothing for a while. The call is still open — nothing has been cancelled.`}
                  className="shrink-0 text-xs text-muted-foreground">
                  quiet
                </span>
              ) : null}
              {figures('call-summary')}
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
            {/* TWO LINES when the caller named a reason: the `title` it passed
                on `call_agent` first, the caller→callee pair under it — ASKED
                FOR as "на первой строке тайтл, на второй «Менеджер инженер»",
                since the pair says WHO is talking and the title says what this
                particular call is for. Without a title the pair IS the title,
                on one line, exactly as the header read before the field
                existed. */}
            {block.title ? (
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <BlockTitle>{block.title}</BlockTitle>
                <span
                  data-slot="call-identity"
                  className="truncate text-[11px] text-muted-foreground">
                  {identityText}
                </span>
              </span>
            ) : (
              <BlockTitle>{identityText}</BlockTitle>
            )}
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
            label={requestLabel}
            text={block.message}
            memoryKey={`call:${block.id}:request`}
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
          {block.entries.map((entry) => {
            // A CONTINUED call's ask, at the point it was sent — drawn exactly
            // as the first ask is, since the card is one conversation and each
            // ask is a brief to the same callee.
            if (isCallContinuation(entry)) {
              const ask = payloadString(entry.item.payload, 'message');
              return ask ? (
                <BlockRequest
                  key={entry.item.id}
                  label={requestLabel}
                  text={ask}
                />
              ) : null;
            }
            return (
              <TranscriptEntryView
                key={entry.type === 'item' ? entry.item.id : entry.id}
                entry={entry}
                nodes={nodes}
                chatAgentName={chatAgentName}
              />
            );
          })}
        </NestedThreadContext.Provider>
        {block.result ? (
          <BlockResult
            label={`Result from ${callee}`}
            text={block.result}
            memoryKey={`call:${block.id}:result`}
          />
        ) : null}
        {status === 'running' && !liveTail ? (
          // THREE lines — the reported ask. The full command is still in the
          // callee's own tool rows directly above; what this line is for is
          // "what is it on right now", which three lines answer and
          // twenty-five bury.
          <BlockPendingLine clamp="three">{pendingLine}</BlockPendingLine>
        ) : null}
        <BlockToolFooter
          count={toolCount}
          // The SAME figures the shut band draws — task chip, ring, tokens and
          // cost, in the band's own size — pushed to the right as they sit
          // there, so opening the card never changes how its numbers look.
          note={
            failed || hasFigures ? (
              <>
                {failed ? <span>finished with an error</span> : null}
                {hasFigures ? (
                  <span
                    data-slot="call-footer-figures"
                    className="ml-auto flex min-w-0 items-center gap-2 text-xs">
                    {figures('call-footer')}
                  </span>
                ) : null}
              </>
            ) : undefined
          }
        />
      </BlockShell>
    </div>
  );
});
