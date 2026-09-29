import { asNumber, asRecord, asString } from '../../../utils/json-util';
import type { AccountSpendConversation } from '../../adapter.types';
import { CURSOR_USAGE_PAGE_SIZE } from '../cursor-acp.const';

/**
 * What one cursor CONVERSATION has cost, read from the only place that knows.
 *
 * This module is the pure half: the request body, the reply reader, and the
 * fold. `CursorAcpAdapter.fetchAccountSpend` owns the credential and the
 * requests; `PolledSpendService` owns the cadence and the writes.
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
 */

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
 * genuinely free rather than unmeasured, and including it in `events` would make
 * "3 turns cost $0.11" describe a different set of turns than the money did.
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
): Map<string, AccountSpendConversation> {
  const out = new Map<string, AccountSpendConversation>();
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
    // `Number('')` is 0 and not NaN — written that way `Number.isFinite` could
    // never reject an absent timestamp, so the guard would read as one thing
    // and test another.
    const rawAtMs = asString(event['timestamp']);
    const atMs = rawAtMs === null ? Number.NaN : Number(rawAtMs);
    const readableAt = Number.isFinite(atMs) && atMs > 0;
    const watermark = since?.get(conversationId) ?? 0;
    // Already counted into this conversation's running total on an earlier
    // poll. The window deliberately overlaps the last one so a late-billed
    // event is not missed, and this is what stops that overlap being counted
    // twice.
    //
    // An event whose timestamp does not read cannot be placed against the
    // watermark at all, so it counts only while there is no watermark to place
    // it against — on the conversation's first pricing. Counting it every poll
    // would inflate the total for good; the caller closes the other half by
    // watermarking such a conversation at the poll's own end.
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

/** Merge one page's fold into the running one. */
export function mergeCursorSpend(
  into: Map<string, AccountSpendConversation>,
  page: ReadonlyMap<string, AccountSpendConversation>,
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
