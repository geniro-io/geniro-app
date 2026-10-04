/** What separates a run id from the rest of a workflow key. */
const RUN_KEY_SEPARATOR = '::';

/** What opens a node's own key after its run's prefix. */
const NODE_KEY_PREFIX = 'node:';

/** What opens a callee conversation's key after its run's prefix. */
const CALL_KEY_PREFIX = 'call:';

/**
 * The keys a WORKFLOW run's agent processes are kept under in
 * `AgentSessionRegistry` — a chat's is its bare run id.
 *
 * Written once because two modules must agree on them: the graph executor
 * files a process under one of these, and the context readout finds that
 * process again by the same spelling. A second copy of the template is how the
 * readout would come to ask a key nothing is kept under, and answer "no live
 * process" about an agent that is working.
 *
 * The `node:` / `call:` prefixes keep a callable node's two kinds of turn from
 * colliding on its own id.
 */
export function nodeSessionKey(runId: string, nodeId: string): string {
  return `${runSessionKeyPrefix(runId)}${NODE_KEY_PREFIX}${nodeId}`;
}

/**
 * What EVERY key a workflow run opens starts with — its nodes' and its
 * conversations' alike — for a caller that has to reach all of one run's
 * processes, or all of its per-key facts, at once. A chat's key is the bare run
 * id and does not start with it.
 */
export function runSessionKeyPrefix(runId: string): string {
  return `${runId}${RUN_KEY_SEPARATOR}`;
}

/**
 * A callee's process, keyed by its CONVERSATION — the first call of it, which
 * every `thread:` continuation shares — so a continuation reaches the process
 * already holding that conversation.
 */
export function callSessionKey(runId: string, conversationId: string): string {
  return `${callSessionKeyPrefix(runId)}${conversationId}`;
}

/**
 * What every one of a run's CALL keys starts with — for a caller that has to
 * ask about a run's call processes without knowing which conversation it is.
 */
export function callSessionKeyPrefix(runId: string): string {
  return `${runSessionKeyPrefix(runId)}${CALL_KEY_PREFIX}`;
}

/**
 * Which run — and which workflow node — a registry key names: a bare run id is
 * a chat's (`nodeId` null), `<runId>::node:<id>` is a node's own process.
 *
 * A CALL's key answers null. Its process belongs to a conversation rather than
 * to a node's readout, and nothing is kept per conversation to file it under.
 */
export function parseSessionKey(
  key: string,
): { runId: string; nodeId: string | null } | null {
  const at = key.indexOf(RUN_KEY_SEPARATOR);
  if (at === -1) {
    return { runId: key, nodeId: null };
  }
  const rest = key.slice(at + RUN_KEY_SEPARATOR.length);
  return rest.startsWith(NODE_KEY_PREFIX)
    ? { runId: key.slice(0, at), nodeId: rest.slice(NODE_KEY_PREFIX.length) }
    : null;
}

/**
 * Which conversation a CALL key names — the `<conversationId>` of
 * {@link callSessionKey} — or null for any other key. The twin of
 * {@link parseSessionKey}'s node arm, for the reader that labels a process by
 * whose it is rather than filing a reading under a node.
 */
export function callConversationOf(key: string): string | null {
  const at = key.indexOf(RUN_KEY_SEPARATOR);
  if (at === -1) {
    return null;
  }
  const rest = key.slice(at + RUN_KEY_SEPARATOR.length);
  return rest.startsWith(CALL_KEY_PREFIX)
    ? rest.slice(CALL_KEY_PREFIX.length)
    : null;
}
