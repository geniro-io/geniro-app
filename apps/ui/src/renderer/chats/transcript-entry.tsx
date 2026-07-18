import { CallBlock } from './call-block';
import { formatClockTime } from './relative-time';
import { SenderRow } from './sender-row';
import { ToolGroup } from './tool-group';
import type { TranscriptEntry } from './transcript-groups';
import {
  payloadString,
  TranscriptItem,
  type TranscriptNodeMeta,
} from './transcript-item';
import { TurnBlock } from './turn-block';

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
 */
export function TranscriptEntryView({
  entry,
  nodes,
  chatAgentName,
}: {
  entry: TranscriptEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  /** Sender name for a 1:1 chat's agent items (they carry no nodeId). */
  chatAgentName?: string | null;
}): React.JSX.Element | null {
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (nodes?.get(id)?.name ?? id);
  const agentName = (id: string | null): string =>
    nameOf(id) ?? chatAgentName ?? 'agent';

  if (entry.type === 'turn-block') {
    return (
      <TurnBlock block={entry} nodes={nodes} chatAgentName={chatAgentName} />
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
  return (
    <SenderRow
      name={agentName(item.nodeId)}
      colorKey={item.nodeId ?? undefined}
      time={time}>
      {content}
    </SenderRow>
  );
}
