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
  return `${runId}::node:${nodeId}`;
}

/**
 * A callee's process, keyed by its CONVERSATION — the first call of it, which
 * every `thread:` continuation shares — so a continuation reaches the process
 * already holding that conversation.
 */
export function callSessionKey(runId: string, conversationId: string): string {
  return `${runId}::call:${conversationId}`;
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
  const at = key.indexOf('::');
  if (at === -1) {
    return { runId: key, nodeId: null };
  }
  const rest = key.slice(at + 2);
  return rest.startsWith('node:')
    ? { runId: key.slice(0, at), nodeId: rest.slice('node:'.length) }
    : null;
}
