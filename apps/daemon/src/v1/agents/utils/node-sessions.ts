import { parseJsonColumn } from './json-util';

/**
 * How many sessions one node's history keeps — newest kept. A node gains one
 * per call to it and per compaction, so this is a ceiling on a pathological
 * run rather than a limit an ordinary one reaches.
 */
export const MAX_NODE_SESSION_HISTORY = 500;

/**
 * Every session a node has held, as `NodeState.sessionIds` stores them —
 * whatever CLI it runs. Unreadable text reads as none.
 */
export function readNodeSessions(raw: string | null): string[] {
  const value = parseJsonColumn(raw);
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
export function withNodeSession(
  raw: string | null,
  sessionId: string,
): string | null {
  const history = readNodeSessions(raw);
  if (sessionId === '' || history.includes(sessionId)) {
    return null;
  }
  history.push(sessionId);
  return JSON.stringify(history.slice(-MAX_NODE_SESSION_HISTORY));
}
