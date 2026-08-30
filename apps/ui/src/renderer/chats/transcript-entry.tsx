import { memo, useContext } from 'react';

import { CallBlock } from './call-block';
import { ChartCard } from './chart-block';
import { ComparisonCard } from './comparison-block';
import { FindingsCard } from './findings-block';
import { MetricsCard } from './metrics-block';
import { formatClockTime } from './relative-time';
import { SenderRow } from './sender-row';
import { SubagentBlock } from './subagent-block';
import { NestedThreadContext } from './subagent-context';
import { TaskListCard } from './task-list';
import { ToolGroup } from './tool-group';
import type { TranscriptEntry } from './transcript-groups';
import {
  payloadString,
  TranscriptItem,
  type TranscriptNodeMeta,
} from './transcript-item';
import { TurnBlock } from './turn-block';
import { WorkflowCard } from './workflow-block';

/** Item kinds that read as a MESSAGE from someone (avatar + name + time). */
const SENDER_KINDS = new Set([
  'message',
  'reasoning',
  'error',
  'system',
  'call_question',
]);

/**
 * One transcript entry in the messenger frame: entries with a clear sender
 * (messages, reasoning, errors, tool groups, call blocks…) wrap in a
 * {@link SenderRow} — initials avatar, name, time metadata under — while
 * bookkeeping notes (statuses, receipts, verdicts) stay centered and
 * frameless. Shared by the main flow and the call block's nested flow so
 * both look identical.
 *
 * Memoized (with the other row shells): the transcript re-renders on every
 * composer keystroke, and `entry`/`nodes` are referentially stable across
 * those renders.
 */
export const TranscriptEntryView = memo(function TranscriptEntryView({
  entry,
  nodes,
  chatAgentName,
  soloAgent = false,
}: {
  entry: TranscriptEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  /** Sender name for a 1:1 chat's agent items (they carry no nodeId). */
  chatAgentName?: string | null;
  /**
   * The run has exactly one agent, so the agent side needs no identity: its
   * rows render bare instead of in a {@link SenderRow}. The USER's own
   * messages keep theirs — the conversation still has two sides.
   */
  soloAgent?: boolean;
}): React.JSX.Element | null {
  /**
   * Inside a sub-agent enclosure, which is `soloAgent` by a stronger argument
   * than "the identity is already on the header": a delegate's rows carry the
   * DELEGATING agent's `nodeId`, so a sender frame here would not repeat the
   * enclosure's identity but assert the wrong one — the chat's own agent named
   * one line beneath a header naming the delegate that actually spoke.
   * {@link TurnBlock} folds `nested` into `soloAgent` on exactly that reasoning
   * and records the symptom it was fixing.
   *
   * This path is the sibling `TurnBlock`'s fix did not cover: the row that did
   * NOT fold into a block. Today every kind in {@link SENDER_KINDS} except
   * `call_question` is owned by `ownerOf` and therefore always folds, so this
   * is a guard on the seam between two lists rather than a live symptom — the
   * two are free to disagree, and the row that falls through the gap is
   * captioned wrongly rather than merely plainly.
   */
  const nested = useContext(NestedThreadContext);
  const solo = soloAgent || nested;
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (nodes?.get(id)?.name ?? id);
  const agentName = (id: string | null): string =>
    nameOf(id) ?? chatAgentName ?? 'agent';

  if (entry.type === 'turn-block') {
    return (
      <TurnBlock
        block={entry}
        nodes={nodes}
        chatAgentName={chatAgentName}
        soloAgent={solo}
      />
    );
  }
  if (entry.type === 'tools') {
    // Geniro's WorkingBlock sits bare in the turn flow — no avatar frame.
    return <ToolGroup group={entry} />;
  }
  if (entry.type === 'call-block') {
    // The communication card carries its own identity (the eyebrow line,
    // the avatar-pair header) — no sender frame around it, per the
    // geniro web reference.
    return (
      <CallBlock block={entry} nodes={nodes} chatAgentName={chatAgentName} />
    );
  }
  if (entry.type === 'subagent-block') {
    // Same rule as the call block: the card names the delegate itself, so a
    // sender frame around it would attribute the aside to the main agent.
    return (
      <SubagentBlock
        block={entry}
        nodes={nodes}
        chatAgentName={chatAgentName}
      />
    );
  }
  if (entry.type === 'findings') {
    // No sender frame, for the task list's reason below: the card is a report
    // the agent handed the app to draw, and the turn block around it already
    // names who was working.
    return <FindingsCard report={entry.report} />;
  }
  if (entry.type === 'chart') {
    // No sender frame, for the findings card's reason directly above.
    return <ChartCard chart={entry.chart} />;
  }
  if (entry.type === 'metrics') {
    // Same again — the figures are a card the agent handed over, not words.
    return <MetricsCard metrics={entry.metrics} />;
  }
  if (entry.type === 'comparison') {
    // …and the table, for the same reason.
    return <ComparisonCard comparison={entry.comparison} />;
  }
  if (entry.type === 'task-list') {
    // No sender frame: the list is the AGENT's own bookkeeping about the work,
    // not something it said, and the surrounding turn block already names who
    // is working.
    return <TaskListCard entry={entry} />;
  }
  if (entry.type === 'workflow') {
    // Same rule as the sub-agent block: the card names the workflow itself, so
    // a sender frame around it would attribute the fleet to the main agent.
    return <WorkflowCard entry={entry} />;
  }

  const item = entry.item;
  if (!SENDER_KINDS.has(item.kind)) {
    return <TranscriptItem item={item} nodes={nodes} />;
  }
  const content = <TranscriptItem item={item} nodes={nodes} />;
  const time = formatClockTime(item.createdAt);
  if (item.kind === 'message' && item.role === 'user') {
    return (
      <SenderRow name="You" avatarName="U" solid align="end" time={time}>
        {content}
      </SenderRow>
    );
  }
  if (item.kind === 'call_question') {
    // The question comes FROM the callee (parked for its caller).
    const calleeId = payloadString(item.payload, 'calleeNodeId');
    return (
      <SenderRow
        name={agentName(calleeId)}
        colorKey={calleeId ?? undefined}
        time={time}>
        {content}
      </SenderRow>
    );
  }
  if (solo) {
    // The one agent needs no identity — its rows sit bare in the flow.
    return content;
  }
  return (
    <SenderRow
      name={agentName(item.nodeId)}
      colorKey={item.nodeId ?? undefined}
      time={time}>
      {content}
    </SenderRow>
  );
});
