import { asRecord, asString } from './json-util';

/**
 * The `text` of a persisted `message` item's payload (stored as a JSON string
 * by persist-then-emit) — the chat list's preview line. Returns null instead
 * of throwing on a malformed or non-text payload: a preview is decoration, a
 * bad row must not break the run list.
 */
export function messageText(payload: string): string | null {
  try {
    return asString(asRecord(JSON.parse(payload))?.text);
  } catch {
    return null;
  }
}
