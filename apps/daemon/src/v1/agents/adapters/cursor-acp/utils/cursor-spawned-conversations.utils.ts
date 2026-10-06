import { CURSOR_SPAWNED_AGENT_ID_MARKER } from '../cursor-acp.const';

/** A conversation id as cursor mints them — a lowercase UUID. */
const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ID_LENGTH = 36;

/**
 * Every delegate conversation one conversation's store names, in the order
 * found — read off the CLI's own `task` result sentence
 * ({@link CURSOR_SPAWNED_AGENT_ID_MARKER}) wherever it sits in the raw bytes.
 *
 * Raw bytes rather than a parse of the store's blobs: the sentence is stored as
 * plain text inside JSON the CLI owns, and its WAL holds what the database file
 * does not yet. A scan cannot misread a structure it never interprets; what it
 * requires is the exact UUID shape after the marker, so prose that merely
 * mentions an agent id is not taken for one.
 */
export function readSpawnedConversationIds(
  bytes: Buffer,
  self: string,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>([self]);
  let at = bytes.indexOf(CURSOR_SPAWNED_AGENT_ID_MARKER);
  while (at !== -1) {
    const start = at + CURSOR_SPAWNED_AGENT_ID_MARKER.length;
    const id = bytes.toString('latin1', start, start + ID_LENGTH);
    if (CONVERSATION_ID.test(id) && !seen.has(id)) {
      seen.add(id);
      found.push(id);
    }
    at = bytes.indexOf(CURSOR_SPAWNED_AGENT_ID_MARKER, start);
  }
  return found;
}
