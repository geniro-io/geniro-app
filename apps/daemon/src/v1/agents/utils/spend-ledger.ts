import type { AccountSpendEvent } from '../adapters/adapter.types';
import { parseJsonColumn } from './json-util';

/**
 * What one POLLED conversation has cost, as `NodeState.polledSpendLedger`
 * stores it per conversation id.
 *
 * Two halves, because an account's charges are not final when they first
 * appear. Cursor creates an event when a request starts and raises its charge
 * while the request runs, so a reading taken early is a fraction of the bill —
 * measured on a real account, a QA node that recorded $13.00 had been billed
 * $160 for the same events. So:
 *
 * - `recent` holds every event still inside the poll's window, at the amount
 *   the LAST poll read for it. Each poll REPLACES these with what the account
 *   says now, so an event that grew is counted at its grown amount, an event
 *   that was dropped is dropped, and nothing is counted twice.
 * - `settledCents` / `settledEvents` hold the events that have left the window
 *   — created before the poll's start, which trails the previous poll by a
 *   whole `MUTABLE_WINDOW_MS`, so nothing still running is ever settled.
 *
 * The conversation's cost is the sum of both ({@link conversationSpend}), and
 * the run's and node's totals are SET from those sums rather than added to, so
 * a total is always a restatement of what the account says and can never drift
 * from it the way an accumulator of deltas did.
 */
export interface ConversationSpend {
  /**
   * Every event created before this instant is in the settled half and is
   * never read into `recent` again — what keeps a poll whose window reaches
   * further back than the last one's (a restart, a newly priced conversation
   * widening it) from counting a settled event twice.
   */
  readonly settledBeforeMs: number;
  readonly settledCents: number;
  readonly settledEvents: number;
  /** `[atMs, cents]` per event still inside the window. */
  readonly recent: readonly (readonly [number, number])[];
}

/**
 * The stored ledger, by conversation id. Unreadable text — or the previous
 * column's per-conversation watermarks, which were numbers rather than objects
 * — reads as NOTHING PRICED, so the next poll prices those conversations from
 * their run's start rather than trusting a figure nothing can vouch for.
 */
export function readSpendLedger(
  raw: string | null,
): Map<string, ConversationSpend> {
  const ledger = new Map<string, ConversationSpend>();
  const value = parseJsonColumn(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ledger;
  }
  for (const [conversationId, entry] of Object.entries(value)) {
    const spend = readConversationSpend(entry);
    if (spend !== null) {
      ledger.set(conversationId, spend);
    }
  }
  return ledger;
}

/** The ledger as the column stores it — keys sorted, so equal ledgers compare equal. */
export function writeSpendLedger(
  ledger: ReadonlyMap<string, ConversationSpend>,
): string {
  return JSON.stringify(
    Object.fromEntries(
      [...ledger].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
}

/**
 * One conversation restated from one poll that read the window
 * `[windowStartMs, …]` WHOLE.
 *
 * The conversation's own window starts at `windowStartMs` or where its settled
 * half ends, whichever is LATER — so an event already settled is never read
 * back in, however far back this poll asked. What the previous poll held from
 * before that start is settled: the poll did not ask about it, so the last
 * reading is the final one. What it held from inside the window is thrown away
 * and `fresh` takes its place, because the account's current answer for an
 * event outranks any earlier reading of it.
 */
export function restateConversation(
  previous: ConversationSpend | undefined,
  fresh: readonly AccountSpendEvent[],
  windowStartMs: number,
): ConversationSpend {
  const startMs = Math.max(windowStartMs, previous?.settledBeforeMs ?? 0);
  let settledCents = previous?.settledCents ?? 0;
  let settledEvents = previous?.settledEvents ?? 0;
  for (const [atMs, cents] of previous?.recent ?? []) {
    if (atMs < startMs) {
      settledCents += cents;
      settledEvents += 1;
    }
  }
  return {
    settledBeforeMs: startMs,
    settledCents,
    settledEvents,
    recent: fresh
      .filter((event) => event.atMs >= startMs)
      .map((event) => [event.atMs, event.cents] as const)
      .sort((a, b) => a[0] - b[0]),
  };
}

/** What one conversation has cost in all, and over how many events. */
export function conversationSpend(spend: ConversationSpend): {
  cents: number;
  events: number;
} {
  return {
    cents: spend.recent.reduce(
      (sum, [, cents]) => sum + cents,
      spend.settledCents,
    ),
    events: spend.settledEvents + spend.recent.length,
  };
}

function readConversationSpend(entry: unknown): ConversationSpend | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const settledBeforeMs = record['settledBeforeMs'];
  const settledCents = record['settledCents'];
  const settledEvents = record['settledEvents'];
  const recent = record['recent'];
  if (
    !isFigure(settledBeforeMs) ||
    !isFigure(settledCents) ||
    !isFigure(settledEvents) ||
    !Array.isArray(recent)
  ) {
    return null;
  }
  const events: (readonly [number, number])[] = [];
  for (const pair of recent) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !isFigure(pair[0]) ||
      !isFigure(pair[1])
    ) {
      return null;
    }
    events.push([pair[0], pair[1]]);
  }
  return { settledBeforeMs, settledCents, settledEvents, recent: events };
}

function isFigure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
