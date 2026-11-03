import { asRecord, parseJsonColumn, payloadString } from './json-util';

/**
 * How long one call has been open, minus what it waited on the user.
 *
 * A call's clock runs from each `running` status row filed under it to the
 * ending status that answers it (`completed` / `failed` / `cancelled` /
 * `skipped`): its turns, the stretches it is held for its own calls or its
 * monitors, the turns those wake, and a stretch its callee runs by itself after
 * the call settled (an `offTurn` running row and the status that restores it).
 * An approval card the callee opened inside a stretch parks the clock until its
 * verdict, or until the stretch ends.
 *
 * Wall time on both sides, so the live figure and the settled one are the
 * same measure: nothing replaces the clock when a turn lands.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/call-clock.ts` continues each
 * clock from `throughSeq` over the rows a client loaded after the read.
 */
export interface CallClock {
  /** The stretches already ended, less their parked waits. */
  closedMs: number;
  /** When the stretch still open began, epoch ms; null when none is. */
  runningSince: number | null;
  /** Of the open stretch, the parked waits already over. */
  parkedMs: number;
  /** When the cards still open began parking the clock; null when none is. */
  parkedSince: number | null;
  /** The ids of the approval cards still open in this call. */
  openCards: string[];
  /** The newest row this clock has read. */
  throughSeq: number;
}

/** One row of the projection {@link callClocksFrom} folds, in seq order. */
export interface CallClockRow {
  seq: number;
  kind: string;
  memberId: string | null;
  createdAt: Date;
  /** The row's JSON text, as stored. */
  payload: string;
}

const ENDING_STATUSES: ReadonlySet<unknown> = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

const CARD_CLOSING_KINDS: ReadonlySet<string> = new Set([
  'approval_verdict',
  'unanswerable',
]);

/** Every call's clock over these rows, keyed by call id. */
export function callClocksFrom(
  rows: readonly CallClockRow[],
): Map<string, CallClock> {
  const clocks = new Map<string, CallClock>();
  // A verdict names its card and its member, never its call.
  const cardCalls = new Map<string, string>();
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (row.memberId === null || !Number.isFinite(at)) {
      continue;
    }
    const body = parseJsonColumn(row.payload);
    if (CARD_CLOSING_KINDS.has(row.kind)) {
      const id = payloadString(body, 'id');
      const cardKey = `${row.memberId}\u0000${id ?? ''}`;
      const callId = id === null ? undefined : cardCalls.get(cardKey);
      const clock = callId === undefined ? undefined : clocks.get(callId);
      if (clock !== undefined && id !== null) {
        cardCalls.delete(cardKey);
        closeCard(clock, id, at);
        clock.throughSeq = Math.max(clock.throughSeq, row.seq);
      }
      continue;
    }
    const callId = payloadString(body, 'callId');
    if (
      callId === null ||
      (row.kind !== 'status' && row.kind !== 'approval_request')
    ) {
      continue;
    }
    const clock = clocks.get(callId) ?? emptyCallClock();
    clocks.set(callId, clock);
    clock.throughSeq = Math.max(clock.throughSeq, row.seq);
    if (row.kind === 'status') {
      const status = asRecord(body)?.status;
      if (status === 'running') {
        startStretch(clock, at);
      } else if (ENDING_STATUSES.has(status)) {
        for (const id of clock.openCards) {
          cardCalls.delete(`${row.memberId}\u0000${id}`);
        }
        endStretch(clock, at);
      }
    } else if (row.kind === 'approval_request') {
      const id = payloadString(body, 'id');
      if (id !== null && clock.runningSince !== null) {
        cardCalls.set(`${row.memberId}\u0000${id}`, callId);
        openCard(clock, id, at);
      }
    }
  }
  return clocks;
}

export function emptyCallClock(): CallClock {
  return {
    closedMs: 0,
    runningSince: null,
    parkedMs: 0,
    parkedSince: null,
    openCards: [],
    throughSeq: -1,
  };
}

function startStretch(clock: CallClock, at: number): void {
  if (clock.runningSince === null) {
    clock.runningSince = at;
    clock.parkedMs = 0;
  }
}

function endStretch(clock: CallClock, at: number): void {
  if (clock.runningSince !== null) {
    const parked =
      clock.parkedMs +
      (clock.parkedSince === null ? 0 : Math.max(0, at - clock.parkedSince));
    clock.closedMs += Math.max(0, at - clock.runningSince - parked);
  }
  clock.runningSince = null;
  clock.parkedMs = 0;
  clock.parkedSince = null;
  clock.openCards = [];
}

function openCard(clock: CallClock, id: string, at: number): void {
  if (clock.openCards.includes(id)) {
    return;
  }
  clock.openCards.push(id);
  clock.parkedSince ??= at;
}

function closeCard(clock: CallClock, id: string, at: number): void {
  clock.openCards = clock.openCards.filter((open) => open !== id);
  if (clock.openCards.length === 0 && clock.parkedSince !== null) {
    clock.parkedMs += Math.max(0, at - clock.parkedSince);
    clock.parkedSince = null;
  }
}
