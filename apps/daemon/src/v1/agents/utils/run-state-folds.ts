import {
  type ItemWire,
  RUN_CALL_BRIEF_MAX,
  type RunCallState,
  type RunDelegateState,
  type RunWorkStatus,
  type TurnEnding,
} from '../chat.types';
import { callField } from './history-anchors';
import { asBoolean, asRecord, payloadString } from './json-util';

/**
 * How a settled call ended, read off its broker envelope.
 *
 * TWIN PARSER: `callResultStatus` in
 * apps/ui/src/renderer/chats/transcript-groups.ts — a call card and the run's
 * own list of calls must not disagree about how one ended.
 */
export function callEndStatus(payload: unknown): RunWorkStatus {
  if (payloadString(payload, 'status') === 'ok') {
    return 'completed';
  }
  return payloadString(payload, 'error')?.startsWith('CALLEE_CANCELLED')
    ? 'cancelled'
    : 'failed';
}

/**
 * Every call of a run out of its `call_started` / `call_result` rows, in start
 * order. Only the first row of either kind counts for a call, as the broker
 * writes one of each.
 */
export function foldRunCalls(rows: readonly ItemWire[]): RunCallState[] {
  const calls = new Map<string, RunCallState>();
  for (const row of rows) {
    if (row.kind !== 'call_started') {
      continue;
    }
    const callId = callField(row.payload, 'callId');
    if (callId === null || calls.has(callId)) {
      continue;
    }
    const brief = callField(row.payload, 'message');
    calls.set(callId, {
      callId,
      callerNodeId: callField(row.payload, 'callerNodeId') ?? row.nodeId,
      calleeNodeId: callField(row.payload, 'calleeNodeId'),
      title: callField(row.payload, 'title'),
      brief: brief === null ? null : brief.slice(0, RUN_CALL_BRIEF_MAX),
      mode: callField(row.payload, 'mode'),
      thread: callField(row.payload, 'thread'),
      startSeq: row.seq,
      startedAt: row.createdAt,
      endedAt: null,
      status: 'running',
    });
  }
  for (const row of rows) {
    if (row.kind !== 'call_result') {
      continue;
    }
    const call = calls.get(callField(row.payload, 'callId') ?? '');
    if (call === undefined || call.endedAt !== null) {
      continue;
    }
    call.endedAt = row.createdAt;
    call.status = callEndStatus(row.payload);
  }
  return [...calls.values()];
}

/** What a delegate said about itself, merged last-non-null as the client merges it. */
interface Declared {
  label: string | null;
  kind: string | null;
  open: boolean | null;
  outcome: string | null;
  first: ItemWire;
}

/**
 * Every delegate a run launched or declared, in launch order, with how it
 * stands.
 *
 * Two admissions, the client's own (`buildSubagentBlocks`): a tool call whose
 * NAME is a delegation, and a `subagent_info` declaration the daemon wrote. The
 * status ranks what the delegate's own bookkeeping says above the reply to its
 * launch: an outcome it reported, then a background unit still open, then the
 * launch's reply (a delegation answered is a delegate that returned), and
 * otherwise whether anything more can come — the run settled, or the turn
 * that launched it ended. It is the reading for a delegate
 * whose rows are NOT in the client's window; one whose rows are is read off
 * those rows, which say more.
 *
 * TWIN PARSER: the declaration fields are `readSubagentDeclaration` in
 * apps/ui/src/renderer/chats/subagent-payload.ts.
 */
export function foldRunDelegates({
  declarations,
  launches,
  replies,
  runSettled,
  endings = [],
}: {
  declarations: readonly ItemWire[];
  launches: readonly ItemWire[];
  replies: readonly ItemWire[];
  runSettled: boolean;
  /**
   * The run's turn endings after its oldest unanswered delegate. A delegate
   * nothing answered cannot be working once the turn waiting on it is over.
   *
   * TWIN PARSER: `SubagentBlockEntry.closed` in
   * apps/ui/src/renderer/chats/transcript-groups.ts reads a turn-end item as
   * the same evidence, with two differences: it measures from the block's LAST
   * row where this has only the launch, and it counts an `insideTurn`
   * completion where this does not.
   */
  endings?: readonly TurnEnding[];
}): RunDelegateState[] {
  const declared = new Map<string, Declared>();
  for (const row of declarations) {
    const id = payloadString(row.payload, 'id');
    if (id === null) {
      continue;
    }
    const record = asRecord(row.payload);
    const open = record?.backgroundOpen;
    const previous = declared.get(id);
    declared.set(id, {
      label: payloadString(row.payload, 'label') ?? previous?.label ?? null,
      kind: payloadString(row.payload, 'kind') ?? previous?.kind ?? null,
      open: typeof open === 'boolean' ? open : (previous?.open ?? null),
      outcome:
        payloadString(row.payload, 'backgroundOutcome') ??
        previous?.outcome ??
        null,
      first: previous?.first ?? row,
    });
  }
  const launched = new Map<string, ItemWire>();
  for (const row of launches) {
    const id = payloadString(row.payload, 'id');
    if (id !== null && !launched.has(id)) {
      launched.set(id, row);
    }
  }
  const answered = new Map<string, boolean>();
  for (const row of replies) {
    const id = payloadString(row.payload, 'id');
    if (id !== null && !answered.has(id)) {
      answered.set(id, asBoolean(asRecord(row.payload)?.isError));
    }
  }

  const delegates: RunDelegateState[] = [];
  for (const id of new Set([...launched.keys(), ...declared.keys()])) {
    const launch = launched.get(id);
    const declaration = declared.get(id);
    const anchor = launch ?? declaration!.first;
    const input = asRecord(asRecord(launch?.payload)?.input);
    delegates.push({
      id,
      nodeId: anchor.nodeId,
      callId: payloadString(anchor.payload, 'callId'),
      label: payloadString(input, 'description') ?? declaration?.label ?? null,
      kind: payloadString(input, 'subagent_type') ?? declaration?.kind ?? null,
      status: delegateStatus(
        declaration,
        answered.get(id),
        runSettled || turnEndedAfter(endings, anchor),
      ),
      launchSeq: anchor.seq,
      startedAt: anchor.createdAt,
    });
  }
  return delegates.sort((a, b) => a.launchSeq - b.launchSeq);
}

/** Whether the agent and call that launched `anchor` ended a turn after it. */
function turnEndedAfter(
  endings: readonly TurnEnding[],
  anchor: ItemWire,
): boolean {
  const callId = payloadString(anchor.payload, 'callId');
  return endings.some(
    (ending) =>
      ending.seq > anchor.seq &&
      ending.nodeId === anchor.nodeId &&
      ending.callId === callId,
  );
}

function delegateStatus(
  declaration: Declared | undefined,
  replyIsError: boolean | undefined,
  nothingMoreComing: boolean,
): RunWorkStatus {
  switch (declaration?.outcome) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case undefined:
    case null:
      break;
    default:
      return 'cancelled';
  }
  if (declaration?.open === true) {
    return 'running';
  }
  if (replyIsError !== undefined) {
    return replyIsError ? 'failed' : 'completed';
  }
  return nothingMoreComing ? 'cancelled' : 'running';
}
