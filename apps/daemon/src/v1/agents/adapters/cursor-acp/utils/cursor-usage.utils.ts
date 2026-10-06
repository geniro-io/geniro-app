import { asNumber, asRecord, asString } from '../../../utils/json-util';
import type { AccountSpendEvent } from '../../adapter.types';
import { CURSOR_USAGE_PAGE_SIZE } from '../cursor-acp.const';

/**
 * What one cursor CONVERSATION has cost, read from the only place that knows.
 *
 * This module is the pure half: the request body, the reply reader, and the
 * event reader. `CursorAcpAdapter.fetchAccountSpend` owns the credential and the
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
 * One page's events for the asked-about conversations, each as the account
 * reports it NOW.
 *
 * Nothing here decides what is new: a charge Cursor lists early grows as its
 * request runs, so the caller replaces each event's figure by its `key` rather
 * than this reader filtering it against an earlier poll — which is exactly what
 * froze a conversation whose ten events summed to $134.86 at $8.44.
 *
 * An event with no readable `conversationId` is DROPPED rather than pooled under
 * a placeholder: it belongs to some conversation, and attributing it to the
 * wrong thread is the one failure this whole approach exists to avoid. So is an
 * event with no readable timestamp, which can neither be keyed across polls nor
 * placed in a window — all 1,860 events a real account returned over thirty
 * days carried one. A non-chargeable event is kept at 0 cents, so a charge the
 * vendor later waives replaces the figure it had.
 */
export function readCursorUsageEvents(
  payload: unknown,
  conversations: ReadonlySet<string>,
): AccountSpendEvent[] {
  const out: AccountSpendEvent[] = [];
  const events = asRecord(payload)?.['usageEventsDisplay'];
  if (!Array.isArray(events)) {
    return out;
  }
  for (const entry of events) {
    const event = asRecord(entry);
    const conversationId =
      event === null ? null : asString(event['conversationId']);
    if (
      event === null ||
      conversationId === null ||
      conversationId === '' ||
      !conversations.has(conversationId)
    ) {
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
    if (!Number.isFinite(atMs) || atMs <= 0) {
      continue;
    }
    const charged = asNumber(event['chargedCents']);
    const cents =
      event['isChargeable'] === false || charged === null ? 0 : charged;
    out.push({
      conversationId,
      // The vendor's own fields: when it dates the request and which model
      // served it. A position in a page would move as new events arrive.
      key: `${rawAtMs}|${asString(event['model']) ?? ''}`,
      atMs,
      model: asString(event['model']),
      cents,
    });
  }
  return out;
}

/**
 * How many events one page carried, before any of them were read.
 *
 * The paging loop counts with this rather than with what the reader kept: the
 * reader drops every other conversation's events, so its count never sums
 * towards {@link cursorUsageTotalCount} and the loop would walk every page it
 * is allowed before giving up.
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
