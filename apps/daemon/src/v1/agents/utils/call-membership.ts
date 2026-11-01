import type { ItemKind } from '../../runs/runs.types';
import type { CallStart } from './history-anchors';
import { payloadString } from './json-util';

/**
 * `Item.inCall` for a row drawn in the run's own flow rather than inside a call
 * card. NULL is taken: it marks a row no build has stamped yet.
 */
export const OUTSIDE_ANY_CALL = '';

/**
 * The version of {@link callMembershipOf}'s answer. Bump it with ANY change to
 * what the rule answers: a launch that finds stamps of another version clears
 * them and stamps every row again (`ItemCallIndexService.indexAllQuietly`).
 */
export const CALL_MEMBERSHIP_VERSION = 2;

/**
 * Rows about a call that sit in the run's own flow even though they name it —
 * a published page or button among them: it is made for the user, and inside a
 * shut call card nobody would see it.
 *
 * `action` / `action_outcome` joined without a {@link CALL_MEMBERSHIP_VERSION}
 * bump: no row of either kind carries a top-level `callId` (a callee's call is
 * named inside its `publisher`), so every stored one already answered
 * {@link OUTSIDE_ANY_CALL}.
 */
const CALLER_FLOW_KINDS = new Set<ItemKind>([
  'call_started',
  'await_collected',
  'approval_request',
  'approval_verdict',
  'show_artifact',
  'action',
  'action_outcome',
]);

/** Caller-written rows about a call that are drawn inside its card. */
const CALL_FOLLOWUP_KINDS = new Set<ItemKind>([
  'call_question',
  'call_answer',
  'call_result',
]);

export interface CallMembershipRow {
  kind: ItemKind;
  memberId: string | null;
  payload: unknown;
}

/** What the run already holds that a row's membership depends on. */
export interface CallMembershipLookup {
  /** The callee member of a call the run started, or undefined when it started none by that id. */
  calleeNodeOf(callId: string): string | null | undefined;
  /** The call a delegate was launched in, from its first declaration naming one. */
  delegateCallOf(delegateId: string): string | null;
}

/** The kinds a {@link CallMembershipLookup} is built from. */
export const CALL_MEMBERSHIP_SOURCE_KINDS: readonly ItemKind[] = [
  'call_started',
  'subagent_info',
];

/**
 * A lookup over a run's `call_started` and `subagent_info` rows, in seq order —
 * the first start of a call and the first declaration of a delegate naming a
 * call win, as they do in the renderer's fold.
 */
export function callMembershipLookupOf(
  rows: readonly CallMembershipRow[],
): CallMembershipLookup & {
  learn(row: CallMembershipRow): void;
  /** Every call the run started, with the conversation it continues — what call chains are built from. */
  starts(): CallStart[];
} {
  const callees = new Map<string, string | null>();
  const starts: CallStart[] = [];
  const delegates = new Map<string, string>();
  const learn = (row: CallMembershipRow): void => {
    if (row.kind === 'call_started') {
      const callId = payloadString(row.payload, 'callId');
      if (callId !== null && !callees.has(callId)) {
        callees.set(callId, payloadString(row.payload, 'calleeNodeId'));
        starts.push({ callId, thread: payloadString(row.payload, 'thread') });
      }
    } else if (row.kind === 'subagent_info') {
      const id = payloadString(row.payload, 'id');
      const callId = payloadString(row.payload, 'callId');
      if (id !== null && callId !== null && !delegates.has(id)) {
        delegates.set(id, callId);
      }
    }
  };
  rows.forEach(learn);
  return {
    learn,
    starts: () => [...starts],
    calleeNodeOf: (callId) => callees.get(callId),
    delegateCallOf: (delegateId) => delegates.get(delegateId) ?? null,
  };
}

/**
 * The call whose card a row is drawn in, or {@link OUTSIDE_ANY_CALL}.
 *
 * TWIN PARSER: the claim pass of `groupTranscript` in
 * apps/ui/src/renderer/chats/transcript-groups.ts (`UNCLAIMABLE_KINDS`,
 * `CALL_FOLLOWUP_KINDS`, the callee-member match, `delegateCalls`). A row this
 * puts inside a call is fetched only with that call's conversation, so a row the
 * renderer would draw in the main flow and this files under a call disappears
 * from the transcript. A change here bumps {@link CALL_MEMBERSHIP_VERSION}.
 */
export function callMembershipOf(
  row: CallMembershipRow,
  lookup: CallMembershipLookup,
): string {
  if (CALLER_FLOW_KINDS.has(row.kind)) {
    return OUTSIDE_ANY_CALL;
  }
  const delegateId =
    row.kind === 'subagent_info' ? payloadString(row.payload, 'id') : null;
  const callId =
    payloadString(row.payload, 'callId') ??
    (delegateId === null ? null : lookup.delegateCallOf(delegateId));
  if (callId === null) {
    return OUTSIDE_ANY_CALL;
  }
  const callee = lookup.calleeNodeOf(callId);
  if (callee === undefined) {
    return OUTSIDE_ANY_CALL;
  }
  if (CALL_FOLLOWUP_KINDS.has(row.kind)) {
    return callId;
  }
  return row.memberId !== null && row.memberId === callee
    ? callId
    : OUTSIDE_ANY_CALL;
}
