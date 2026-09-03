import { asNumber, asRecord, asString } from './json-util';

/**
 * What one cursor CONVERSATION has cost, read from the only place that knows.
 *
 * This module is the pure half: the request body, the reply reader, and the
 * fold. The service beside it owns the credential, the cadence and the writes.
 *
 * **Why this exists at all, and why it is a network read.** cursor-agent tells
 * geniro nothing about cost — measured 2026-08-31 by capturing a whole turn's
 * ACP frames through the daemon's own `agent-stdio` channel: the
 * `session/prompt` reply is `{"stopReason":"end_turn"}` with no `usage` field,
 * no `usage_update` notification is ever sent, and `usage_update` appears in
 * that CLI's bundle only inside the ACP schema union, with no emitter. Nor is
 * the figure recoverable from disk: its per-session `store.db` records context
 * COMPOSITION and no billing, and nothing under `~/.cursor` records a charge.
 * Nor is it derivable — a real event carries an `enterpriseUsageDiscountPercent`
 * and a separate `cursorTokenFee` on top of the token subtotal, so it is not
 * tokens times a published rate. It is computed on Cursor's side, which is why
 * Cursor's own UI fetches it too.
 *
 * **What makes the read attributable.** Each event carries a `conversationId`,
 * and that id IS the ACP session id geniro already records on `node_state`
 * (verified end to end: a captured turn's `sessionId` came back verbatim as the
 * `conversationId` of its own usage event). So this is exact per-thread cost
 * rather than a correlation by timestamp — which would have been a guess, and a
 * wrong one on this app's normal pattern of several threads at once.
 *
 * **One call covers every thread.** The endpoint answers for the ACCOUNT over a
 * date range, so a single poll updates every cursor conversation geniro holds.
 * Nothing here is ever asked per message or per thread — see the service's
 * cadence rules.
 */

/** The Connect-RPC host the CLI itself talks to (`api3` does not route). */
export const CURSOR_API_HOST = 'https://api2.cursor.sh';

/** The one method this module calls. Connect accepts JSON over a plain POST. */
export const CURSOR_USAGE_METHOD =
  '/aiserver.v1.DashboardService/GetFilteredUsageEvents';

/**
 * How many events one page asks for.
 *
 * Large on purpose: the whole point of this design is few, fat requests rather
 * than many small ones, and a page is a plain JSON array of small objects.
 */
export const CURSOR_USAGE_PAGE_SIZE = 250;

/**
 * How many pages one poll will walk before giving up.
 *
 * A bound rather than a target — a poll covers hours, not months, so reaching
 * this means something is wrong with the window and the right answer is to stop
 * asking rather than to page through an account's whole history.
 */
export const CURSOR_USAGE_MAX_PAGES = 8;

/** One conversation's spend, as this module reports it. */
export interface CursorConversationSpend {
  conversationId: string;
  /** Summed `chargedCents` — what the account was actually charged. */
  costCents: number;
  /** How many billable events made it up, so a total can say what it counted. */
  events: number;
  /** The newest event's epoch millis, for the incremental window. */
  latestAtMs: number;
}

/**
 * The request body for one page.
 *
 * `teamId` and `userId` ride it because a team account's events are scoped that
 * way; both come from the CLI's own `cli-config.json` identity block, never from
 * anything geniro invents. The dates are epoch-millis STRINGS, which is what the
 * generated client sends for an `int64`.
 */
export function cursorUsageRequestBody(input: {
  teamId: number;
  userId: number;
  startMs: number;
  endMs: number;
  page: number;
}): string {
  return JSON.stringify({
    teamId: input.teamId,
    userId: input.userId,
    startDate: String(input.startMs),
    endDate: String(input.endMs),
    page: input.page,
    pageSize: CURSOR_USAGE_PAGE_SIZE,
  });
}

/**
 * One page of events, folded per conversation.
 *
 * Only CHARGEABLE events count. An event the account was not billed for is
 * genuinely free rather than unmeasured, and adding its zero would leave the
 * turn count honest while the money stayed right — but including a
 * non-chargeable event in `events` would make "3 turns cost $0.11" describe a
 * different set of turns than the money did.
 *
 * An event with no readable `conversationId` is DROPPED rather than pooled under
 * a placeholder: it belongs to some conversation, and attributing it to the
 * wrong thread is the one failure this whole approach exists to avoid. The cost
 * of dropping is a thread reporting slightly less than it spent, which is the
 * safe direction for a figure a user checks against their own bill.
 */
export function foldCursorUsagePage(
  payload: unknown,
  since?: ReadonlyMap<string, number>,
): Map<string, CursorConversationSpend> {
  const out = new Map<string, CursorConversationSpend>();
  const body = asRecord(payload);
  const events = body?.['usageEventsDisplay'];
  if (!Array.isArray(events)) {
    return out;
  }
  for (const entry of events) {
    const event = asRecord(entry);
    if (event === null) {
      continue;
    }
    const conversationId = asString(event['conversationId']);
    if (conversationId === null || conversationId === '') {
      continue;
    }
    if (event['isChargeable'] === false) {
      continue;
    }
    const cents = asNumber(event['chargedCents']);
    if (cents === null) {
      continue;
    }
    // The timestamp is an epoch-millis STRING on this wire, like the bounds.
    //
    // Parsed in two steps rather than as `Number(asString(x) ?? '')`, because
    // `Number('')` is 0 and not NaN — written that way `Number.isFinite` can
    // never reject an absent timestamp, so the guard reads as one thing and
    // tests another. Both spellings happen to fold identically (a 0 loses
    // `atMs > watermark` to any real watermark, and `latestAtMs` maxes to 0
    // either way); what the honest form buys is that `readableAt` means what it
    // says at the ONE place it is load-bearing — the caller's decision about
    // whether this fold produced a watermark at all.
    const rawAtMs = asString(event['timestamp']);
    const atMs = rawAtMs === null ? Number.NaN : Number(rawAtMs);
    const readableAt = Number.isFinite(atMs) && atMs > 0;
    const watermark = since?.get(conversationId) ?? 0;
    // Already counted into this conversation's running total on an earlier
    // poll. The window deliberately overlaps the last one so a late-billed
    // event is not missed, and this is what stops that overlap being counted
    // twice now that the write ACCUMULATES instead of replacing.
    //
    // An event whose timestamp does not read cannot be placed against the
    // watermark at all, so it counts only while there is no watermark to place
    // it against — on the conversation's first pricing. Counting it every poll
    // would inflate the total for good, and this module's stated bias is that a
    // thread under-reporting is the safe direction for a figure a user checks
    // against their own bill. The caller closes the other half of that: a
    // conversation whose counted events yielded no readable timestamp is
    // watermarked at the poll's own end rather than left unmarked.
    if (watermark > 0 && !(readableAt && atMs > watermark)) {
      continue;
    }
    const known = out.get(conversationId);
    out.set(conversationId, {
      conversationId,
      costCents: (known?.costCents ?? 0) + cents,
      events: (known?.events ?? 0) + 1,
      latestAtMs: Math.max(known?.latestAtMs ?? 0, readableAt ? atMs : 0),
    });
  }
  return out;
}

/**
 * How many events one page carried, before any of them were folded.
 *
 * The paging loop counts with this rather than with the fold's event totals:
 * the fold drops what an earlier poll already counted, so on an overlapping
 * window its totals no longer sum towards {@link cursorUsageTotalCount} and the
 * loop would walk every page it is allowed before giving up.
 */
export function cursorUsagePageLength(payload: unknown): number {
  const events = asRecord(payload)?.['usageEventsDisplay'];
  return Array.isArray(events) ? events.length : 0;
}

/** How many events the account holds in the window, for the paging loop. */
export function cursorUsageTotalCount(payload: unknown): number | null {
  const body = asRecord(payload);
  const total = body?.['totalUsageEventsCount'];
  const asNum = typeof total === 'string' ? Number(total) : asNumber(total);
  return typeof asNum === 'number' && Number.isFinite(asNum) ? asNum : null;
}

/**
 * Put a cursor conversation's fetched cost onto this thread's totals.
 *
 * It REPLACES rather than adds, and that is not a shortcut: a cursor turn
 * reports no cost of its own, so `sumUsagePayloads` over its `turn_complete`
 * rows always answers null here and there is nothing to add to. Adding would
 * also double-count the moment that CLI starts reporting, whereas replacing
 * simply stops applying once a real figure exists.
 *
 * A run with no fetched events is left ALONE — untouched null, which the header
 * already draws as "no cost reported". A zero would claim the thread was free.
 */
export function applyCursorSpend<
  T extends { costUsd: number | null; costedTurns: number },
>(
  totals: T,
  run: { cursorCostCents: number | null; cursorCostEvents: number | null },
): T {
  if (run.cursorCostCents === null || (run.cursorCostEvents ?? 0) === 0) {
    return totals;
  }
  return {
    ...totals,
    costUsd: run.cursorCostCents / 100,
    costedTurns: run.cursorCostEvents ?? 0,
  };
}

/** Merge one page's fold into the running one. */
export function mergeCursorSpend(
  into: Map<string, CursorConversationSpend>,
  page: ReadonlyMap<string, CursorConversationSpend>,
): void {
  for (const [id, spend] of page) {
    const known = into.get(id);
    into.set(id, {
      conversationId: id,
      costCents: (known?.costCents ?? 0) + spend.costCents,
      events: (known?.events ?? 0) + spend.events,
      latestAtMs: Math.max(known?.latestAtMs ?? 0, spend.latestAtMs),
    });
  }
}
