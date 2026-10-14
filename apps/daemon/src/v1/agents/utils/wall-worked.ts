import type { ItemKind } from '../../runs/runs.types';
import { asRecord, parseJsonColumn, payloadString } from './json-util';
import { usageFiguresFrom } from './usage-figures';

/**
 * How long a workflow node's turns WORKED by the wall clock, for the turns its
 * CLI did not time itself — what `NodeWallWorkService` adds to
 * `NodeState.workedMs`, so a cursor node's figure no longer depends on how much
 * history a client happened to load.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/turn-duration.ts` → `scanTurns`
 * with `nodeScoped: true`, the renderer's wall-clock fallback over the rows it
 * has loaded. Both read the same durable rows the same way: a turn opens on its
 * conversation's first `running` status row after the previous terminal row,
 * an approval card parks the clock from its `approval_request` to the
 * `approval_verdict` / `unanswerable` with the same `id` (a card still open at
 * the settle is parked up to the settle), and the turn worked
 * `max(0, settle − start − parked)`. An `insideTurn` continuation carrying a
 * CLI figure moves the open turn's start to itself (its own stretch is inside
 * that figure), and a settle `answeredByContinuation` after such a row is no
 * second turn. A key renamed on either side must be renamed on both.
 *
 * Where this deliberately differs from the renderer:
 *
 * - A conversation is keyed by node AND the row's `callId`, as
 *   `activeSpansFrom` keys it: parallel calls run one node in several
 *   conversations at once, and the renderer's node-only key measures the
 *   second call's turn from the first call's start. A card's close is paired by
 *   its `id` within the node rather than by conversation, because a verdict
 *   row carries no `callId`.
 * - A terminal `status` row (`completed` / `failed` / `cancelled` /
 *   `skipped`) closes an open turn UNMEASURED, as `activeSpansFrom` does. On
 *   ACP an off-turn stretch (`running` with `offTurn`) never gets a terminal
 *   row of its own — the executor answers it with a `completed` status when
 *   the next turn starts — so without this the next turn was measured from the
 *   stretch's start, idle gap included. A normal turn writes its
 *   `turn_complete` before its ending status, so nothing it measures moves.
 * - Only a `turn_complete` is measured. A turn ending in `error` or
 *   `turn_cancelled` closes unmeasured, which is what the CLI-timed path does
 *   for claude (the executor adds the duration only on `turn_complete`).
 * - The renderer's `interrupted` rule (a boot-closed turn ends at its last
 *   row) has nothing to act on: only an `error` row carries the flag, the
 *   workflow boot reconcile writes it with no `nodeId`, and an `error` row is
 *   never measured here.
 */

/** One row of the projection {@link wallMeasuredTurns} folds, in seq order. */
export interface WallClockRow {
  seq: number;
  kind: string;
  nodeId: string | null;
  createdAt: Date;
  /** The row's JSON text, as stored (card rows: projected to `id` / `callId`). */
  payload: string;
}

/** Every kind the fold reads — what its DAO projection selects. */
export const WALL_CLOCK_ROW_KINDS = [
  'status',
  'turn_complete',
  'turn_cancelled',
  'error',
  'approval_request',
  'approval_verdict',
  'unanswerable',
] as const satisfies readonly ItemKind[];

/** The card kinds among {@link WALL_CLOCK_ROW_KINDS}: only `id` and `callId` are read. */
export const WALL_CLOCK_CARD_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'approval_request',
  'approval_verdict',
  'unanswerable',
]);

/** One settled turn measured by the wall clock, keyed by its `turn_complete`. */
export interface WallTurn {
  /** The seq of the `turn_complete` that ended the turn. */
  seq: number;
  ms: number;
}

/** Item kinds that end a turn — the twin of the renderer's `TERMINAL_KINDS`. */
const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'turn_complete',
  'turn_cancelled',
  'error',
]);

/** `status` values that end a conversation's stretch without a terminal row. */
const ENDING_STATUSES: ReadonlySet<unknown> = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

const APPROVAL_CLOSING_KINDS: ReadonlySet<string> = new Set([
  'approval_verdict',
  'unanswerable',
]);

/**
 * The CLI's own duration for a turn, or null when it reported none — the one
 * predicate that decides which clock measures a turn, on the renderer's
 * `cliTurnDurationMs` terms: a non-finite or negative figure is no figure,
 * and `0` IS one (the CLI timed the turn; it just took no time).
 */
export function cliTurnDurationMs(payload: unknown): number | null {
  const ms = usageFiguresFrom(payload)?.durationMs ?? null;
  return ms !== null && ms >= 0 ? ms : null;
}

interface ConversationClock {
  startedAt: number | null;
  /** Open approval cards, by id. */
  parkedSince: Map<string, number>;
  parkedMs: number;
  /** An `insideTurn` continuation already carried the CLI's figure for the open turn. */
  continuationMeasured: boolean;
}

/**
 * Every settled, wall-measured turn of these rows: a `turn_complete` with no
 * CLI duration whose conversation had opened a turn. Rows of other nodes and
 * run-level rows (`nodeId` null) are ignored, so the input may be a whole
 * run's rows. A turn with no start in the rows yields nothing rather than a
 * figure measured from the epoch.
 */
export function wallMeasuredTurns(rows: readonly WallClockRow[]): WallTurn[] {
  const clocks = new Map<string, ConversationClock>();
  /** Which conversation each open card parks — `nodeId \0 cardId` → key. */
  const cardOwners = new Map<string, string>();
  const measured: WallTurn[] = [];
  const clockOf = (key: string): ConversationClock => {
    const found = clocks.get(key);
    if (found !== undefined) {
      return found;
    }
    const fresh: ConversationClock = {
      startedAt: null,
      parkedSince: new Map(),
      parkedMs: 0,
      continuationMeasured: false,
    };
    clocks.set(key, fresh);
    return fresh;
  };
  const reset = (nodeId: string, clock: ConversationClock): void => {
    for (const id of clock.parkedSince.keys()) {
      cardOwners.delete(`${nodeId}\u0000${id}`);
    }
    clock.startedAt = null;
    clock.parkedSince.clear();
    clock.parkedMs = 0;
    clock.continuationMeasured = false;
  };

  for (const row of rows) {
    if (row.nodeId === null) {
      continue;
    }
    const time = row.createdAt.getTime();
    const at = Number.isFinite(time) ? time : null;
    const body = parseJsonColumn(row.payload);
    const key = `${row.nodeId}\u0000${payloadString(body, 'callId') ?? ''}`;

    if (row.kind === 'status') {
      const status = asRecord(body)?.status;
      if (status === 'running') {
        const clock = clockOf(key);
        clock.startedAt ??= at;
      } else if (ENDING_STATUSES.has(status)) {
        const clock = clocks.get(key);
        if (clock !== undefined) {
          reset(row.nodeId, clock);
        }
      }
      continue;
    }
    if (row.kind === 'approval_request') {
      const id = payloadString(body, 'id');
      if (id !== null && at !== null) {
        clockOf(key).parkedSince.set(id, at);
        cardOwners.set(`${row.nodeId}\u0000${id}`, key);
      }
      continue;
    }
    if (APPROVAL_CLOSING_KINDS.has(row.kind)) {
      const id = payloadString(body, 'id');
      if (id === null || at === null) {
        continue;
      }
      const cardKey = `${row.nodeId}\u0000${id}`;
      const owner = cardOwners.get(cardKey);
      const clock = owner === undefined ? undefined : clocks.get(owner);
      const since = clock?.parkedSince.get(id);
      if (clock !== undefined && since !== undefined) {
        clock.parkedSince.delete(id);
        cardOwners.delete(cardKey);
        clock.parkedMs += Math.max(0, at - since);
      }
      continue;
    }
    if (!TERMINAL_KINDS.has(row.kind)) {
      continue;
    }
    const clock = clockOf(key);
    const cli = cliTurnDurationMs(body);
    if (asRecord(body)?.insideTurn === true) {
      // A continuation finishing inside the open turn ends nothing. With a CLI
      // figure, its stretch is already timed, so the open turn is measured
      // from here — the renderer's rule, for the same double-count reason.
      if (cli !== null) {
        clock.continuationMeasured = true;
        if (clock.startedAt !== null && at !== null) {
          clock.startedAt = Math.max(clock.startedAt, at);
          clock.parkedMs = 0;
          for (const [id, since] of clock.parkedSince) {
            clock.parkedSince.set(id, Math.max(since, at));
          }
        }
      }
      continue;
    }
    // A card still open at the settle was never answered: parked to the settle.
    if (at !== null) {
      for (const since of clock.parkedSince.values()) {
        clock.parkedMs += Math.max(0, at - since);
      }
    }
    const answeredInside =
      asRecord(body)?.answeredByContinuation === true &&
      clock.continuationMeasured;
    if (
      row.kind === 'turn_complete' &&
      cli === null &&
      !answeredInside &&
      clock.startedAt !== null &&
      at !== null
    ) {
      measured.push({
        seq: row.seq,
        ms: Math.max(0, at - clock.startedAt - clock.parkedMs),
      });
    }
    reset(row.nodeId, clock);
  }
  return measured;
}
