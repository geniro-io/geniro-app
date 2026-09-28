import { positive } from './positive-figure';

/**
 * How many sessions one node's history keeps — newest kept. A node gains one
 * per call to it and per compaction, so this is a ceiling on a pathological
 * run rather than a limit an ordinary one reaches.
 */
export const MAX_NODE_SESSION_HISTORY = 500;

function parseJson(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The per-conversation watermarks behind the cursor spend accumulator, as
 * `NodeState.cursorSpendThrough` stores them: JSON text mapping a conversation
 * id to the newest usage event already priced, in epoch millis.
 *
 * Unreadable text, or an entry that is not a positive number, reads as NEVER
 * PRICED — the poll then re-baselines that run once rather than trusting a
 * mark nothing can vouch for.
 */
export function readSpendMarks(raw: string | null): Map<string, number> {
  const marks = new Map<string, number>();
  const value = parseJson(raw);
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

/** Every session a node has held, as `NodeState.sessionIds` stores them. */
export function readSessionHistory(raw: string | null): string[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
}

/**
 * The stored history with one session appended — or null when it is already
 * there. Capped at {@link MAX_NODE_SESSION_HISTORY}, oldest dropped first.
 */
export function withSession(
  raw: string | null,
  sessionId: string,
): string | null {
  const history = readSessionHistory(raw);
  if (sessionId === '' || history.includes(sessionId)) {
    return null;
  }
  history.push(sessionId);
  return JSON.stringify(history.slice(-MAX_NODE_SESSION_HISTORY));
}
