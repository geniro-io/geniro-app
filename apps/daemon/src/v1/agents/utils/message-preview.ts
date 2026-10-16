import { asRecord, asString } from './json-util';

/**
 * The `text` of a persisted `message` item's payload (stored as a JSON string
 * by persist-then-emit). Returns null instead of throwing on a malformed or
 * non-text payload: a bad row must not break the reader that met it.
 */
export function messageText(payload: string): string | null {
  try {
    return messageTextOf(JSON.parse(payload));
  } catch {
    return null;
  }
}

/** The same reading, for a payload that is already an object. */
function messageTextOf(payload: unknown): string | null {
  return asString(asRecord(payload)?.text);
}

/**
 * The chat list's preview line for a stored `message` payload: its text, or —
 * for a message that says nothing in words, such as a screenshot sent alone —
 * a label naming its pictures. Null for neither, and for a malformed payload.
 */
export function messagePreview(payload: string): string | null {
  try {
    return messagePreviewOf(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * The same reading, for a payload that is already an object — the status
 * announce holds the item it just persisted, before any JSON round trip.
 *
 * TWIN PARSER: `previewTextOf` in `apps/ui/src/renderer/chats/chat-preview.ts`
 * writes the same line for the open thread. The two take turns on one row, so
 * the label must be spelled identically on both sides.
 */
export function messagePreviewOf(payload: unknown): string | null {
  const text = messageTextOf(payload);
  if (text !== null && text.trim() !== '') {
    return text;
  }
  const images = asRecord(payload)?.images;
  const count = Array.isArray(images) ? images.length : 0;
  if (count === 0) {
    return null;
  }
  return count === 1 ? '🖼 Image' : `🖼 ${count} images`;
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
 * conversations the row cannot open; a row with neither words nor pictures
 * says nothing rather than blanking the line.
 *
 * One known edge where the twins disagree until the next message: the list's
 * exclusions are substring matches over the stored JSON, so a message whose
 * TEXT names `parentToolUseId` is skipped there and shown here.
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
  return messagePreviewOf(item.payload);
}
