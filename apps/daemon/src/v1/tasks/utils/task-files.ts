import { TaskFileSchema, type TaskFileWire } from '../tasks.types';

/**
 * The stored attachments column, tolerating anything an older build or a hand
 * wrote.
 *
 * ONE reader for three callers — the card's own wire projection, the files
 * service, and the prompt a run is opened with — because the TOLERANCE is the
 * rule worth stating once: a row that does not parse degrades to NO attachment
 * rather than to a half-read one. The agent opens what this returns, so a
 * path-shaped fragment recovered from a malformed row is a file it would then
 * try to read. Three copies of that rule is how a later fix to one leaves the
 * prompt path or the wire path behind.
 */
export function parseTaskFiles(raw: string): TaskFileWire[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((row) => {
      const result = TaskFileSchema.safeParse(row);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
