import type { ItemKind } from '../../runs/runs.types';
import type { ActiveSpan } from '../chat.types';
import {
  asRecord,
  asString,
  parseJsonColumn,
  payloadString,
} from './json-util';
import { delegateIdOf } from './open-delegates';
import { usageFiguresFromRaw } from './usage-figures';

/** One row of the projection {@link activeSpansFrom} folds. */
export interface SpanRow {
  kind: string;
  nodeId: string | null;
  createdAt: Date;
  /** The row's JSON text, exactly as stored. */
  payload: string;
}

/**
 * Every kind {@link activeSpansFrom} reads — what its DAO projection selects.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/turn-duration.ts` →
 * `movesPausedSpans`, the rows on whose arrival the renderer re-reads these
 * spans (cards, background units, and `running` status rows).
 */
export const SPAN_ROW_KINDS = [
  'status',
  'turn_complete',
  'approval_request',
  'approval_verdict',
  'unanswerable',
  'shell_open',
  'shell_info',
  'subagent_info',
] as const satisfies readonly ItemKind[];

/** The card kinds among {@link SPAN_ROW_KINDS}: the fold reads only their `id` and `callId`. */
export const SPAN_CARD_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'approval_request',
  'approval_verdict',
  'unanswerable',
]);

/**
 * The wall-clock stretches in which SOME agent of a run was working, merged —
 * what the chat header's clock is drawn from on a WORKFLOW run.
 *
 * Why this exists rather than `ChatTotals.workedMs`: that figure is a SUM of
 * every turn's own duration, so two agents working a minute in parallel is two
 * minutes there. On a workflow that is the ordinary case — a Manager's turn
 * stays open for the whole time it waits in `await_agent` while its Engineer
 * works — and a clock built on the sum advances two seconds a second. A clock
 * is read as a clock, so its settled half is the UNION of these spans.
 *
 * A turn's span runs from its conversation's `running` status row (node and
 * `callId`) to its `turn_complete` — the same instant the renderer's live clock counts an open
 * turn from, so a turn landing does not move the total. A turn with no
 * `running` row reaches back from its end by the CLI's own `durationMs`; a turn
 * with neither is left out: a stretch nothing measured is not invented.
 *
 * The union then loses every {@link pausedSpansFrom} stretch — a card waiting
 * on the user with no background work running: an open turn does not count as
 * work through it.
 *
 * Rows must arrive in `seq` order.
 */
export function activeSpansFrom(
  rows: readonly SpanRow[],
  paused: readonly ActiveSpan[] = pausedSpansFrom(rows),
): ActiveSpan[] {
  const runningSince = new Map<string, number>();
  const spans: ActiveSpan[] = [];
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (
      !Number.isFinite(at) ||
      (row.kind !== 'status' && row.kind !== 'turn_complete')
    ) {
      continue;
    }
    const body = parseJsonColumn(row.payload);
    // Parallel calls run one node in several conversations at once.
    const key = `${row.nodeId ?? ''}\u0000${payloadString(body, 'callId') ?? ''}`;
    if (row.kind === 'status') {
      const status = asRecord(body)?.status;
      if (status === 'running' && !runningSince.has(key)) {
        runningSince.set(key, at);
      } else if (
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'skipped'
      ) {
        // A stretch that ended without a `turn_complete` — an off-turn badge
        // restored, a failed turn — must not lend its start to the node's NEXT
        // turn, or that one would be measured from here. A normal turn writes
        // its `turn_complete` before its `completed` row.
        runningSince.delete(key);
      }
      continue;
    }
    const since = runningSince.get(key);
    runningSince.delete(key);
    const durationMs = usageFiguresFromRaw(row.payload)?.durationMs ?? null;
    const startMs =
      since !== undefined
        ? since
        : durationMs !== null && durationMs > 0
          ? at - durationMs
          : null;
    if (startMs === null || startMs >= at) {
      continue;
    }
    spans.push({ startMs, endMs: at });
  }
  return subtractSpans(mergeSpans(spans), paused);
}

/**
 * The stretches in which the run waited on the USER and nothing else was going
 * on: an approval or question card open, with no background shell and no
 * background delegate running.
 *
 * Whatever turns were open meanwhile are not counted as working through it — a
 * Manager sitting in `await_agent` on an Engineer parked on a question is the
 * case this exists for. A background command or delegate IS work, so it keeps
 * the clock going through a card. A unit still open at the last row runs to
 * `Infinity`; the spans this is subtracted from bound it.
 *
 * Card and shell ids are per-process counters (`n:0`, `bash_1`), so every unit
 * is keyed by its node as well. A card that never got a closing row ends when
 * its own conversation starts its next turn, so one lost close cannot stop the
 * clock for the rest of the run.
 */
export function pausedSpansFrom(rows: readonly SpanRow[]): ActiveSpan[] {
  const cards = new Map<
    string,
    { since: number; nodeId: string | null; callId: string | null }
  >();
  const shells = new Map<string, { since: number; keys: string[] }>();
  const delegates = new Map<string, number>();
  const waits: ActiveSpan[] = [];
  const background: ActiveSpan[] = [];
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (!Number.isFinite(at) || row.kind === 'turn_complete') {
      continue;
    }
    const body = parseJsonColumn(row.payload);
    // Not the payload's `callId`: an `unanswerable` close carries none.
    const unitKey = (id: string | null): string | null =>
      id === null ? null : `${row.nodeId ?? ''}\u0000${id}`;
    if (row.kind === 'status') {
      // An off-turn badge is activity between turns, not the conversation
      // taking its next turn — a deferred question stays open through it.
      const record = asRecord(body);
      if (record?.status !== 'running' || record.offTurn === true) {
        continue;
      }
      const callId = payloadString(body, 'callId');
      for (const [id, card] of cards) {
        if (card.nodeId === row.nodeId && card.callId === callId) {
          cards.delete(id);
          waits.push({ startMs: card.since, endMs: at });
        }
      }
    } else if (row.kind === 'approval_request') {
      const id = unitKey(payloadString(body, 'id'));
      if (id !== null && !cards.has(id)) {
        cards.set(id, {
          since: at,
          nodeId: row.nodeId,
          callId: payloadString(body, 'callId'),
        });
      }
    } else if (row.kind === 'approval_verdict' || row.kind === 'unanswerable') {
      const id = unitKey(payloadString(body, 'id'));
      const card = id === null ? undefined : cards.get(id);
      if (id !== null && card !== undefined) {
        cards.delete(id);
        waits.push({ startMs: card.since, endMs: at });
      }
    } else if (row.kind === 'shell_open') {
      // Either id may be the one its settle names, so both find the shell.
      const keys = [
        unitKey(payloadString(body, 'workId')),
        unitKey(payloadString(body, 'id')),
      ].filter((key): key is string => key !== null);
      if (keys.length > 0 && !keys.some((key) => shells.has(key))) {
        const shell = { since: at, keys };
        for (const key of keys) {
          shells.set(key, shell);
        }
      }
    } else if (row.kind === 'shell_info') {
      const shell =
        shells.get(unitKey(payloadString(body, 'workId')) ?? '') ??
        shells.get(unitKey(payloadString(body, 'id')) ?? '');
      if (shell !== undefined) {
        for (const key of shell.keys) {
          shells.delete(key);
        }
        background.push({ startMs: shell.since, endMs: at });
      }
    } else if (row.kind === 'subagent_info') {
      // `openDelegateIds`' ranking: a stated outcome outranks `backgroundOpen`.
      const id = unitKey(delegateIdOf(body));
      const record = asRecord(body);
      if (id === null || record === null) {
        continue;
      }
      const closed =
        asString(record.backgroundOutcome) !== null ||
        record.backgroundOpen === false;
      const since = delegates.get(id);
      if (closed && since !== undefined) {
        delegates.delete(id);
        background.push({ startMs: since, endMs: at });
      } else if (
        !closed &&
        record.backgroundOpen === true &&
        since === undefined
      ) {
        delegates.set(id, at);
      }
    }
  }
  for (const card of cards.values()) {
    waits.push({ startMs: card.since, endMs: Number.POSITIVE_INFINITY });
  }
  for (const shell of new Set(shells.values())) {
    background.push({ startMs: shell.since, endMs: Number.POSITIVE_INFINITY });
  }
  for (const since of delegates.values()) {
    background.push({ startMs: since, endMs: Number.POSITIVE_INFINITY });
  }
  return subtractSpans(mergeSpans(waits), mergeSpans(background));
}

/**
 * Sort and coalesce overlapping (or touching) spans into disjoint ones.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/turn-duration.ts` → `mergeSpans`,
 * which merges these again for the live half.
 */
export function mergeSpans(spans: readonly ActiveSpan[]): ActiveSpan[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const merged: ActiveSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * `from` with every stretch of `minus` cut out; both disjoint and sorted.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/turn-duration.ts` →
 * `subtractSpans`, the same cut made on the live half.
 */
export function subtractSpans(
  from: readonly ActiveSpan[],
  minus: readonly ActiveSpan[],
): ActiveSpan[] {
  const out: ActiveSpan[] = [];
  for (const span of from) {
    let start = span.startMs;
    for (const cut of minus) {
      if (cut.endMs <= start || cut.startMs >= span.endMs) {
        continue;
      }
      if (cut.startMs > start) {
        out.push({ startMs: start, endMs: cut.startMs });
      }
      start = Math.max(start, cut.endMs);
      if (start >= span.endMs) {
        break;
      }
    }
    if (start < span.endMs) {
      out.push({ startMs: start, endMs: span.endMs });
    }
  }
  return out;
}
