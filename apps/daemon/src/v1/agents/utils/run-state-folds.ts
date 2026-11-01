import type { Item } from '../../runs/entity/item.entity';
import {
  type DelegateLifecycle,
  type ItemWire,
  RUN_CALL_BRIEF_MAX,
  type RunCallState,
  type RunDelegateState,
  type RunWorkStatus,
  type TurnEnding,
} from '../chat.types';
import { callField } from './history-anchors';
import {
  asBoolean,
  asRecord,
  parseJsonColumn,
  payloadString,
} from './json-util';
import { SubagentRecoveryRefSchema } from './subagent-recovery-ref';

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

/** A `member` a row's payload states, or null. */
function memberOf(payload: unknown): number | null {
  const member = asRecord(payload)?.member;
  return typeof member === 'number' && Number.isInteger(member) ? member : null;
}

/**
 * Every call of a run out of its `call_started` / `call_result` rows, in start
 * order. Only the first row of either kind counts for a call, as the broker
 * writes one of each.
 *
 * `handOffs` are the run's pool hand-off rows (`ItemDao.callHandOffRows`), in
 * seq order: the member a call names is its settle's, else its newest
 * hand-off's, else its start's.
 *
 * `queuedCallIds` are the calls that waited under the run's active-turn cap
 * (`ItemDao.callQueueRows`) and `startedCallIds` those whose turn has since
 * begun (`ItemDao.callIdsWithStatus`): a call is `queued` while it is out,
 * waited, and has not begun.
 */
export function foldRunCalls(
  rows: readonly ItemWire[],
  handOffs: readonly ItemWire[] = [],
  queuedCallIds: ReadonlySet<string> = new Set(),
  startedCallIds: ReadonlySet<string> = new Set(),
): RunCallState[] {
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
      callerMemberId: callField(row.payload, 'callerNodeId') ?? row.memberId,
      calleeMemberId: callField(row.payload, 'calleeNodeId'),
      title: callField(row.payload, 'title'),
      brief: brief === null ? null : brief.slice(0, RUN_CALL_BRIEF_MAX),
      mode: callField(row.payload, 'mode'),
      thread: callField(row.payload, 'thread'),
      startSeq: row.seq,
      startedAt: row.createdAt,
      endedAt: null,
      status: 'running',
      queued: queuedCallIds.has(callId) && !startedCallIds.has(callId),
      member: memberOf(row.payload),
    });
  }
  for (const row of handOffs) {
    const call = calls.get(callField(row.payload, 'callId') ?? '');
    const member = memberOf(row.payload);
    if (call !== undefined && member !== null) {
      call.member = member;
    }
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
    call.queued = false;
    call.member = memberOf(row.payload) ?? call.member;
  }
  return [...calls.values()];
}

/** What a delegate said about itself, merged last-non-null as the client merges it. */
interface Declared {
  label: string | null;
  kind: string | null;
  open: boolean | null;
  outcome: string | null;
  /**
   * A recovery ref was recorded and not withdrawn since, so the daemon can
   * still look the delegate's outcome up. Rows written before refs existed
   * carry none, and keep the reading they had then.
   *
   * TWIN of the refs map in `SubagentRecoveryService.candidates` (a ref sets
   * it, `recovery: null` clears it) and of `recoverable` in
   * apps/ui/src/renderer/chats/subagent-payload.ts.
   */
  recoverable: boolean;
  /** The row that stated the outcome said the hosting process had ended. */
  processEnded: boolean;
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
 * that launched it ended. A delegate the user's Stop cut off reads
 * `cancelled`; one whose ending simply went unreported reads `untracked` only
 * while a recovery ref can still resolve it. It is the reading for a delegate
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
  runCancelled = false,
  endings = [],
}: {
  declarations: readonly ItemWire[];
  launches: readonly ItemWire[];
  replies: readonly ItemWire[];
  runSettled: boolean;
  /**
   * The run itself was stopped. Read only for a delegate whose own turn has
   * no ending in `endings` — a team cancel, which ends no turn row.
   */
  runCancelled?: boolean;
  /**
   * The run's turn endings after its oldest unanswered delegate, settled run
   * or not. A delegate nothing answered cannot be working once the turn
   * waiting on it is over. The renderer reads no turn endings for a delegate:
   * this fold is where a missing ending is resolved.
   */
  endings?: readonly TurnEnding[];
}): DelegateLifecycle[] {
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
        open === true
          ? null
          : (payloadString(row.payload, 'backgroundOutcome') ??
            previous?.outcome ??
            null),
      recoverable:
        record?.recovery === null
          ? false
          : isRecoveryRefFor(record?.recovery, id) ||
            (previous?.recoverable ?? false),
      processEnded:
        open === true
          ? false
          : payloadString(row.payload, 'backgroundOutcome') !== null
            ? payloadString(row.payload, 'trackingLost') === 'process-ended'
            : (previous?.processEnded ?? false),
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

  const delegates: DelegateLifecycle[] = [];
  for (const id of new Set([...launched.keys(), ...declared.keys()])) {
    const launch = launched.get(id);
    const declaration = declared.get(id);
    const anchor = launch ?? declaration!.first;
    const input = asRecord(asRecord(launch?.payload)?.input);
    // The delegate's OWN turn ending decides first: a run's status describes
    // only its latest turn, and a chat settles after every one.
    const status = delegateStatus(
      declaration,
      answered.get(id),
      endedBy(endings, anchor) ??
        (runCancelled ? 'stopped' : runSettled ? 'ended' : null),
    );
    delegates.push({
      id,
      memberId: anchor.memberId,
      callId: payloadString(anchor.payload, 'callId'),
      label: payloadString(input, 'description') ?? declaration?.label ?? null,
      kind: payloadString(input, 'subagent_type') ?? declaration?.kind ?? null,
      status,
      processEnded:
        status === 'untracked' && (declaration?.processEnded ?? false),
      launchSeq: anchor.seq,
      startedAt: anchor.createdAt,
    });
  }
  return delegates.sort((a, b) => a.launchSeq - b.launchSeq);
}

/**
 * A turn-ending row as {@link foldRunDelegates} reads it — the one mapping
 * every caller hands the fold, so they cannot read one row two ways.
 */
export function turnEndingOf(
  row: Pick<Item, 'seq' | 'memberId' | 'kind' | 'payload'>,
): TurnEnding {
  return {
    seq: row.seq,
    memberId: row.memberId,
    callId: payloadString(parseJsonColumn(row.payload), 'callId'),
    cancelled: row.kind === 'turn_cancelled',
  };
}

/** A recovery ref the recovery service would act on, for delegate `id`. */
function isRecoveryRefFor(value: unknown, id: string): boolean {
  const parsed = SubagentRecoveryRefSchema.safeParse(value);
  return parsed.success && parsed.data.toolCallId === id;
}

/**
 * How the agent and call that launched `anchor` ended a turn after it: by the
 * user's Stop, otherwise, or not yet.
 */
function endedBy(
  endings: readonly TurnEnding[],
  anchor: ItemWire,
): 'stopped' | 'ended' | null {
  const callId = payloadString(anchor.payload, 'callId');
  const ending = endings.find(
    (candidate) =>
      candidate.seq > anchor.seq &&
      candidate.memberId === anchor.memberId &&
      candidate.callId === callId,
  );
  if (ending === undefined) {
    return null;
  }
  return ending.cancelled ? 'stopped' : 'ended';
}

function delegateStatus(
  declaration: Declared | undefined,
  replyIsError: boolean | undefined,
  parentEnded: 'stopped' | 'ended' | null,
): RunDelegateState['status'] {
  const recoverable = declaration?.recoverable ?? false;
  switch (declaration?.outcome) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'untracked':
      return 'untracked';
    case undefined:
    case null:
      break;
    case 'stopped':
      return 'cancelled';
    default:
      return 'untracked';
  }
  if (declaration?.open === true) {
    return 'running';
  }
  if (declaration?.open === false) {
    // A close that named no outcome: an error reply says how it ended; else an
    // ending the daemon can still look up, or — on a row from before refs —
    // the reading it always had.
    if (replyIsError === true) {
      return 'failed';
    }
    return recoverable ? 'untracked' : 'completed';
  }
  if (replyIsError !== undefined) {
    return replyIsError ? 'failed' : 'completed';
  }
  switch (parentEnded) {
    case null:
      return 'running';
    case 'stopped':
      return 'cancelled';
    case 'ended':
      return recoverable ? 'untracked' : 'cancelled';
  }
}
