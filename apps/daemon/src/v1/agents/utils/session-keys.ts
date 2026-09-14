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
