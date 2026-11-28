import type { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';

/** The only kinds {@link openNodeTurns} and {@link openCalls} read. */
export const OPEN_WORK_KINDS = [
  'status',
  'call_started',
  'call_result',
] as const satisfies readonly ItemKind[];

/**
 * A member turn the transcript opened (`status: running`) and never settled.
 * `callId` is set when the turn was a callee's sub-turn for that call.
 */
export interface OpenNodeTurn {
  memberId: string;
  callId: string | null;
}

/** A call the broker announced (`call_started`) and never settled (`call_result`). */
export interface OpenCall {
  callId: string;
  callerMemberId: string | null;
  /** The callee conversation the caller made it from, null for its own. */
  callerConversationId: string | null;
  calleeMemberId: string | null;
  mode: string | null;
  /**
   * The callee pool member it runs on now — its newest hand-off's, else the
   * one it started on — null without a pool.
   */
  member: number | null;
}

/** Every status that ends a turn — `skipped` included, which may have no start. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

function payloadOf(item: Item): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(item.payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The member turns a transcript leaves open, one per (member, call) the way the
 * renderer folds them (`computeAgentActivity`): a `running` row opens it, a
 * second one while it is open is the same turn (a wake, a pool hand-on), and a
 * terminal row settles it.
 *
 * The renderer reads a member's liveness off these rows BEFORE the daemon's
 * `node_state` row, so a turn a killed daemon never settled here keeps its
 * card spinning under a run the boot reconcile already failed.
 */
export function openNodeTurns(items: readonly Item[]): OpenNodeTurn[] {
  const open = new Map<string, OpenNodeTurn>();
  for (const item of items) {
    if (item.kind !== 'status' || item.memberId === null) {
      continue;
    }
    const payload = payloadOf(item);
    const status = stringField(payload, 'status');
    if (status === null) {
      continue;
    }
    const callId = stringField(payload, 'callId');
    const key = JSON.stringify([item.memberId, callId]);
    if (status === 'running') {
      open.set(key, { memberId: item.memberId, callId });
    } else if (TERMINAL_STATUSES.has(status)) {
      open.delete(key);
    }
  }
  return [...open.values()];
}

/**
 * The member turns a stop closed only for a continuation to pick up (their
 * last row is a `continues` one) and that nothing picked up since: the
 * renderer skips such a row, so the turn still reads as working until a row of
 * its own ends it.
 */
export function turnsLeftForContinuation(
  items: readonly Item[],
): OpenNodeTurn[] {
  const last = new Map<string, { turn: OpenNodeTurn; continues: boolean }>();
  for (const item of items) {
    if (item.kind !== 'status' || item.memberId === null) {
      continue;
    }
    const payload = payloadOf(item);
    const status = stringField(payload, 'status');
    if (status === null) {
      continue;
    }
    const callId = stringField(payload, 'callId');
    last.set(JSON.stringify([item.memberId, callId]), {
      turn: { memberId: item.memberId, callId },
      continues: status !== 'running' && payload?.continues === true,
    });
  }
  return [...last.values()]
    .filter((entry) => entry.continues)
    .map((entry) => entry.turn);
}

function memberField(payload: Record<string, unknown> | null): number | null {
  const member = payload?.member;
  return typeof member === 'number' && Number.isInteger(member) && member >= 1
    ? member
    : null;
}

/**
 * The calls a transcript announced and never settled. A call's block is drawn
 * from its `call_started` row and closed by its `call_result`, so one left
 * without a result reads as in flight for as long as the transcript exists.
 *
 * `handOffs` are the run's pool hand-off rows (`ItemDao.callHandOffRows`), in
 * seq order: a call's `member` is its newest hand-off's, so it names the
 * member whose session the call last ran in.
 */
export function openCalls(
  items: readonly Item[],
  handOffs: readonly Item[] = [],
): OpenCall[] {
  const open = new Map<string, OpenCall>();
  for (const item of items) {
    if (item.kind !== 'call_started' && item.kind !== 'call_result') {
      continue;
    }
    const payload = payloadOf(item);
    const callId = stringField(payload, 'callId');
    if (callId === null) {
      continue;
    }
    if (item.kind === 'call_result') {
      open.delete(callId);
      continue;
    }
    open.set(callId, {
      callId,
      callerMemberId: stringField(payload, 'callerNodeId') ?? item.memberId,
      callerConversationId: stringField(payload, 'callerConversationId'),
      calleeMemberId: stringField(payload, 'calleeNodeId'),
      mode: stringField(payload, 'mode'),
      member: memberField(payload),
    });
  }
  for (const row of handOffs) {
    const payload = payloadOf(row);
    const call = open.get(stringField(payload, 'callId') ?? '');
    const member = memberField(payload);
    if (call !== undefined && member !== null) {
      call.member = member;
    }
  }
  return [...open.values()];
}
