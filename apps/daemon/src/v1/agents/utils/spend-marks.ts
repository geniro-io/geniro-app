import { parseJsonColumn } from './json-util';
import { positive } from './positive-figure';

/**
 * The per-conversation watermarks behind a POLLED spend accumulator, as
 * `NodeState.polledSpendThrough` stores them: JSON text mapping a conversation
 * id to the newest usage event already priced, in epoch millis.
 *
 * Unreadable text, or an entry that is not a positive number, reads as NEVER
 * PRICED — the poll then re-baselines that run once rather than trusting a
 * mark nothing can vouch for.
 */
export function readSpendMarks(raw: string | null): Map<string, number> {
  const marks = new Map<string, number>();
  const value = parseJsonColumn(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return marks;
  }
  for (const [conversationId, throughMs] of Object.entries(value)) {
    if (typeof throughMs === 'number' && positive(throughMs)) {
      marks.set(conversationId, throughMs);
    }
  }
  return marks;
}

/**
 * The stored text with one conversation's mark advanced — or null when nothing
 * changes. A mark only ever moves FORWARD: one that went backwards would count
 * a stretch of events twice.
 */
export function withSpendMark(
  raw: string | null,
  conversationId: string,
  throughMs: number,
): string | null {
  if (!positive(throughMs)) {
    return null;
  }
  const marks = readSpendMarks(raw);
  const current = marks.get(conversationId);
  if (current !== undefined && current >= throughMs) {
    return null;
  }
  marks.set(conversationId, throughMs);
  return JSON.stringify(Object.fromEntries(marks));
}
