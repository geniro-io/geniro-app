/**
 * Who wrote a `system` row's message.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/event-to-item.ts` stamps the
 * `origin` key this reads, from the `notice` event's own `origin` field. An item
 * payload is `z.unknown()` on the wire BY DESIGN — every item kind carries a
 * different shape — so no generated type reaches the renderer and the two sides
 * are independent readings of one shape. Rename the key there and this file must
 * change with it.
 *
 * A plain `.ts` module rather than a helper inside the row component: a pure
 * payload reader parked in a `.tsx` is what previously closed a real value-import
 * cycle in this directory (transcript-groups → transcript-item → live-row →
 * agent-activity), and the row components are not the only readers.
 */

/**
 * True when the CLI wrote the message and geniro is only relaying it.
 *
 * Absent means the DAEMON wrote it, which is every historical notice — a
 * withheld capability, a degrade — and those are correctly surfaced like errors.
 * Text the agent produced is not an advisory and must not be dressed as one;
 * it is also untrusted (a compaction summary describes a conversation that can
 * contain file contents, command output and web pages), so it must never be
 * able to impersonate an application-level warning.
 */
export function isCliAuthored(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  return (payload as { origin?: unknown }).origin === 'cli';
}

/**
 * True when the daemon wrote this row and said it is INFORMATION, not an
 * advisory about something going wrong.
 *
 * Absent means `warning`, which is every historical notice — a withheld
 * capability, a degrade — and those keep the failure chrome. The case this
 * exists for is the between-turn hand-over: a request the CLI raised while no
 * turn was open, kept for the user rather than answered for them. That is the
 * machinery working as designed, and dressing it in red got it reported as an
 * error the user "still sees sometimes".
 *
 * Read from the same key `event-to-item.ts` stamps (see the TWIN PARSER note
 * above), which the daemon omits for CLI-authored text — so relayed agent prose
 * can never reach this branch and pick its own chrome.
 */
export function isInfoNotice(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  const row = payload as { severity?: unknown; origin?: unknown };
  return row.severity === 'info' && row.origin !== 'cli';
}

/**
 * True when the daemon wrote this row and said it is a DEGRADE — something the
 * user asked for did not apply, and the turn ran anyway.
 *
 * The middle the two readers above leave open, and the one the report asked
 * for: an `effort=max` the model does not offer is not information (the run is
 * not doing what was chosen, and only the user can fix that) and it is not a
 * failure either (the turn ran, and went on running) — so it can be neither
 * folded into the quiet note nor left in the red panel that got it reported as
 * "a strange error … and then it carried on working".
 *
 * Same `origin` guard as `isInfoNotice`, and for the same reason: relayed agent
 * prose must not be able to pick its own chrome.
 */
export function isWarningNotice(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  const row = payload as { severity?: unknown; origin?: unknown };
  return row.severity === 'warning' && row.origin !== 'cli';
}

/**
 * What the daemon called this row, in its own two or three words — the caption,
 * where the reader learns what they are looking at before reading the sentence.
 *
 * `null` where the producer named none, which is every historical notice and
 * leaves each severity's own default standing. It exists because that default
 * is a sentence about ONE case: `not applied` describes the degrade the warning
 * level was added for and says nothing true about a request that failed and was
 * retried, which is the other thing that is loud without being fatal.
 *
 * Same `origin` guard as its two neighbours, and for the same reason: relayed
 * agent prose must not be able to caption itself as an application advisory.
 */
export function noticeCaption(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const row = payload as { caption?: unknown; origin?: unknown };
  return typeof row.caption === 'string' &&
    row.caption !== '' &&
    row.origin !== 'cli'
    ? row.caption
    : null;
}

/**
 * The delivery ids a "not sent" row names — the user messages a turn accepted
 * and then dropped because the turn ended before its agent took them. Empty
 * for every other row.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/event-to-item.ts` writes the
 * `unsentMessages` key from the `follow_up_dropped` event; each id is the
 * `deliveryId` the daemon stamped on that user message's own row. Same
 * `origin` guard as above: relayed CLI text cannot mark a message unsent.
 */
export function unsentMessageIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') {
    return [];
  }
  const row = payload as { unsentMessages?: unknown; origin?: unknown };
  if (!Array.isArray(row.unsentMessages) || row.origin === 'cli') {
    return [];
  }
  return row.unsentMessages.filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
}

/**
 * What the agent's CLI said refusing the messages a "not sent" row names, or
 * null when the turn simply ended before taking them.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/event-to-item.ts` writes the
 * `unsentReason` key from the `follow_up_dropped` event's `reason`. Same
 * `origin` guard as `unsentMessageIds`.
 */
export function unsentReason(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const row = payload as { unsentReason?: unknown; origin?: unknown };
  return typeof row.unsentReason === 'string' &&
    row.unsentReason !== '' &&
    row.origin !== 'cli'
    ? row.unsentReason
    : null;
}
