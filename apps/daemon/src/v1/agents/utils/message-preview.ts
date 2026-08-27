import { asRecord, asString } from './json-util';

/**
 * The `text` of a persisted `message` item's payload (stored as a JSON string
 * by persist-then-emit) — the chat list's preview line. Returns null instead
 * of throwing on a malformed or non-text payload: a preview is decoration, a
 * bad row must not break the run list.
 */
export function messageText(payload: string): string | null {
  try {
    return messageTextOf(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * The same reading, for a payload that is already an object.
 *
 * The status announce holds the item it just persisted, whose payload has not
 * been through the JSON round trip, and re-stringifying it only to parse it
 * back would be two conversions to answer a question about one field. Both
 * readers go through this so the rule for "what a preview line is" lives once.
 */
export function messageTextOf(payload: unknown): string | null {
  return asString(asRecord(payload)?.text);
}
