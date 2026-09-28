/**
 * WHO is making an agent-to-agent call: one node, in one of its CONVERSATIONS.
 *
 * A node runs its OWN conversation — its DAG turn, the follow-ups and wakes
 * that continue it — and, as a callee, one conversation per call lineage it
 * serves (`ThreadRecord.conversationId`, the first call of a `thread:` chain),
 * each in a kept process of its own. Every one of them can call its own
 * callees, and they are DIFFERENT callers: an Engineer answering the Manager's
 * feature-A call and the same Engineer answering its feature-B call must not
 * collect, answer or cancel each other's calls. Keyed by node alone they did —
 * PROBED: conversation A's `await_agent()` returned "RESULT FOR FEATURE B",
 * and B was then told UNKNOWN_CALL for its own call.
 *
 * So the broker keys every piece of caller state by this key, and the MCP
 * endpoint names the conversation (`/v1/mcp/<run>/<node>/<conversation>`), so
 * the key reaches it from the one place that knows which process is asking.
 *
 * A node's OWN conversation keys as the bare node id — which is exactly what
 * every caller was before conversations were told apart, so nothing about a
 * node that is never a callee changes.
 */

/**
 * Between the node id and the conversation id. A control character, because a
 * node id refuses every one (`argvSafe` on the node schema) and a conversation
 * id is a broker call id — so no key can be read two ways.
 */
const SEPARATOR = '\u001f';

/** The key of `nodeId` speaking in `conversationId` — or in its own, when null. */
export function callerKey(
  nodeId: string,
  conversationId: string | null,
): string {
  return conversationId === null
    ? nodeId
    : `${nodeId}${SEPARATOR}${conversationId}`;
}

/** The node a caller key belongs to. */
export function callerNodeOf(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}

/** The callee conversation a caller key speaks in, or null for the node's own. */
export function callerConversationOf(key: string): string | null {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? null : key.slice(at + SEPARATOR.length);
}
