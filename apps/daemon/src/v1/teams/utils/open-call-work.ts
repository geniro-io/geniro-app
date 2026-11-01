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
  calleeMemberId: string | null;
  mode: string | null;
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
 * The member turns a transcript leaves open, paired per (member, call) the way the
 * renderer counts them: every `running` row opens one, every terminal row
 * settles one, and a terminal row with nothing open settles nothing.
 *
 * The renderer reads a member's liveness off these rows BEFORE the daemon's
 * `node_state` row, so a turn a killed daemon never settled here keeps its
 * card spinning under a run the boot reconcile already failed.
 */
export function openNodeTurns(items: readonly Item[]): OpenNodeTurn[] {
  const open = new Map<string, { turn: OpenNodeTurn; count: number }>();
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
    const entry = open.get(key) ?? {
      turn: { memberId: item.memberId, callId },
      count: 0,
    };
    if (status === 'running') {
      entry.count += 1;
    } else if (TERMINAL_STATUSES.has(status)) {
      entry.count = Math.max(0, entry.count - 1);
    }
    open.set(key, entry);
  }
  const turns: OpenNodeTurn[] = [];
  for (const { turn, count } of open.values()) {
    for (let i = 0; i < count; i += 1) {
      turns.push(turn);
    }
  }
  return turns;
}

/**
 * The calls a transcript announced and never settled. A call's block is drawn
 * from its `call_started` row and closed by its `call_result`, so one left
 * without a result reads as in flight for as long as the transcript exists.
 */
export function openCalls(items: readonly Item[]): OpenCall[] {
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
      calleeMemberId: stringField(payload, 'calleeNodeId'),
      mode: stringField(payload, 'mode'),
    });
  }
  return [...open.values()];
}
