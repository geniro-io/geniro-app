import type { AccountSpendEvent } from '../adapters/adapter.types';
import { parseJsonColumn } from './json-util';

/**
 * What one polled CONVERSATION has cost, as `NodeState.polledSpend` keeps it.
 *
 * Two halves, because a vendor revises a charge after listing it (see
 * `AccountSpendEvent`): every event dated at or after {@link settledThroughMs}
 * is held under its own key and REPLACED by each poll that reads it again, and
 * only once an event is older than the settle horizon is it folded into the
 * settled sum and forgotten. A watermark that counted each event the first time
 * it was seen froze long requests at whatever they had cost when first listed.
 */
export interface ConversationSpend {
  /**
   * The final charges of every event dated before {@link settledThroughMs},
   * summed per BUCKET — a local calendar day and the model that served it
   * (`spendBucket`) — as `[cents, chargedEvents]`. Kept per bucket rather than
   * as one sum because the account names both for every charge, and the Stats
   * page's per-day chart and per-model breakdown are read from exactly this.
   */
  settled: Record<string, [number, number]>;
  /**
   * Epoch millis: events dated before this are in {@link settled} and are
   * never read again, events at or after it are still {@link open}. Also where
   * the next poll's window has to start for this conversation.
   */
  settledThroughMs: number;
  /** Each still-revisable event, by its key, as `[atMs, cents, model]`. */
  open: Record<string, [number, number, string]>;
}

/**
 * The bucket one charge is filed under: its LOCAL calendar day (the machine's,
 * as the Stats page buckets turns) and its model, `YYYY-MM-DD|model`; an
 * unknown model is the empty string.
 */
export function spendBucket(atMs: number, model: string): string {
  const day = new Date(atMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}|${model}`;
}

/** A bucket key read back into its day and model. */
export function readSpendBucket(bucket: string): {
  day: string;
  model: string;
} {
  const at = bucket.indexOf('|');
  return at === -1
    ? { day: bucket, model: '' }
    : { day: bucket.slice(0, at), model: bucket.slice(at + 1) };
}

export type PolledSpendLedger = Map<string, ConversationSpend>;

/**
 * The stored column, read. Unreadable text, or an entry of the wrong shape,
 * reads as NEVER PRICED — the next poll prices that conversation from its
 * start rather than trusting a figure nothing can vouch for.
 */
export function readPolledSpendLedger(raw: string | null): PolledSpendLedger {
  const ledger: PolledSpendLedger = new Map();
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

function readConversationSpend(entry: unknown): ConversationSpend | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const { settled, settledThroughMs, open } = entry as Record<string, unknown>;
  if (!finite(settledThroughMs) || !isRecord(settled) || !isRecord(open)) {
    return null;
  }
  const sums: Record<string, [number, number]> = {};
  for (const [bucket, pair] of Object.entries(settled)) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !finite(pair[0]) ||
      !finite(pair[1])
    ) {
      return null;
    }
    sums[bucket] = [pair[0], pair[1]];
  }
  const events: Record<string, [number, number, string]> = {};
  for (const [key, triple] of Object.entries(open)) {
    if (
      !Array.isArray(triple) ||
      triple.length !== 3 ||
      !finite(triple[0]) ||
      !finite(triple[1]) ||
      typeof triple[2] !== 'string'
    ) {
      return null;
    }
    events[key] = [triple[0], triple[1], triple[2]];
  }
  return { settled: sums, settledThroughMs, open: events };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The column to store, or null for a ledger holding nothing. */
export function writePolledSpendLedger(
  ledger: PolledSpendLedger,
): string | null {
  return ledger.size === 0 ? null : JSON.stringify(Object.fromEntries(ledger));
}

/** A conversation never priced before, whose events begin no earlier than `fromMs`. */
export function unpricedConversation(fromMs: number): ConversationSpend {
  return { settled: {}, settledThroughMs: fromMs, open: {} };
}

/**
 * One conversation after a poll: every event of it the poll read REPLACES the
 * figure held under its key, and — when `settleBeforeMs` is given — every open
 * event dated before that is folded into the settled sum.
 *
 * `settleBeforeMs` must be null unless the poll read its whole window: an event
 * a cut-short walk never reached may still be revised, and settling past it
 * would freeze whatever figure it had.
 */
export function withAccountEvents(
  spend: ConversationSpend,
  events: readonly AccountSpendEvent[],
  settleBeforeMs: number | null,
): ConversationSpend {
  const open = { ...spend.open };
  for (const event of events) {
    // Already settled: final, and counted in the sum.
    if (event.atMs < spend.settledThroughMs) {
      continue;
    }
    open[event.key] = [event.atMs, event.cents, event.model ?? ''];
  }
  if (settleBeforeMs === null || settleBeforeMs <= spend.settledThroughMs) {
    return { ...spend, open };
  }
  const settled = { ...spend.settled };
  for (const [key, [atMs, cents, model]] of Object.entries(open)) {
    if (atMs < settleBeforeMs) {
      const bucket = spendBucket(atMs, model);
      const [sum, count] = settled[bucket] ?? [0, 0];
      settled[bucket] = [sum + cents, count + (cents > 0 ? 1 : 0)];
      delete open[key];
    }
  }
  return { settled, settledThroughMs: settleBeforeMs, open };
}

/**
 * What a set of conversations has cost: cents, how many CHARGED events made it
 * up (a free event is not a turn anybody paid for), and the same split per
 * {@link spendBucket}.
 */
export function ledgerTotals(ledger: PolledSpendLedger): {
  cents: number;
  events: number;
  buckets: Map<string, { cents: number; events: number }>;
} {
  let cents = 0;
  let events = 0;
  const buckets = new Map<string, { cents: number; events: number }>();
  const add = (bucket: string, amount: number, charged: number): void => {
    cents += amount;
    events += charged;
    const held = buckets.get(bucket) ?? { cents: 0, events: 0 };
    buckets.set(bucket, {
      cents: held.cents + amount,
      events: held.events + charged,
    });
  };
  for (const spend of ledger.values()) {
    for (const [bucket, [amount, charged]] of Object.entries(spend.settled)) {
      add(bucket, amount, charged);
    }
    for (const [atMs, amount, model] of Object.values(spend.open)) {
      add(spendBucket(atMs, model), amount, amount > 0 ? 1 : 0);
    }
  }
  return { cents, events, buckets };
}
