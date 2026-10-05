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

/**
 * The sidebar preview line a just-persisted row carries, or null when the row
 * must not move it.
 *
 * TWIN PARSER: `ItemDao`'s `NOT_A_DELEGATE` + `NOT_IN_A_CALL` decide the same
 * thing off the database for the run LIST, and the renderer's `previewsThread`
 * (`apps/ui/src/renderer/chats/chat-preview.ts`) for the open thread's live
 * items and, through `previewMessageOf`, for a replayed window. The
 * three take turns writing one line, so a rule held on only one side is a
 * preview whose owner depends on which source spoke last.
 *
 * A delegate's message and one written inside an agent-to-agent call are other
 * conversations the row cannot open; a row with no readable text says nothing
 * rather than blanking the line.
 *
 * Two known edges where the twins disagree until the next message: the list's
 * exclusions are substring matches over the stored JSON, so a message whose
 * TEXT names `parentToolUseId` is skipped there and shown here; and both the
 * list and the renderer keep a blank text (an image-only message) that this
 * skips.
 */
export function threadPreviewOf(item: {
  kind: string;
  payload: unknown;
}): string | null {
  if (item.kind !== 'message') {
    return null;
  }
  const payload = asRecord(item.payload);
  if (
    payload?.['parentToolUseId'] !== undefined ||
    payload?.['callId'] !== undefined
  ) {
    return null;
  }
  const text = messageTextOf(item.payload);
  return text === null || text.trim() === '' ? null : text;
}
