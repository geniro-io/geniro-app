/**
 * WHO is making an agent-to-agent call: one member, in one of its CONVERSATIONS.
 *
 * A member runs its OWN conversation — its own turns, the follow-ups and wakes
 * that continue it — and, as a callee, one conversation per call lineage it
 * serves (`ThreadRecord.conversationId`, the first call of a `thread:` chain),
 * each in a kept process of its own. Every one of them can call its own
 * callees, and they are DIFFERENT callers: an Engineer answering the Manager's
 * feature-A call and the same Engineer answering its feature-B call must not
 * collect, answer or cancel each other's calls. Keyed by member alone they
 * would: conversation A's `await_agent()` would return feature B's result,
 * and B would then be told UNKNOWN_CALL for its own call.
 *
 * So the broker keys every piece of caller state by this key, and the MCP
 * endpoint names the conversation (`/v1/mcp/<run>/<member>/<conversation>`), so
 * the key reaches it from the one place that knows which process is asking.
 *
 * A member's OWN conversation keys as the bare member id, so a member that is
 * never a callee is keyed exactly as it would be by member alone.
 */

/**
 * Between the member id and the conversation id. A NUL, because that is the one
 * character the member schema refuses in an id (`argvSafe`) and a conversation id
 * is a broker call id — so no key can be read two ways. Any other control
 * character is a legal id character: the schema also reads stored teams,
 * so it refuses as little as it can.
 */
const SEPARATOR = '\u0000';

/** The key of `memberId` speaking in `conversationId` — or in its own, when null. */
export function callerKey(
  memberId: string,
  conversationId: string | null,
): string {
  return conversationId === null
    ? memberId
    : `${memberId}${SEPARATOR}${conversationId}`;
}

/** The member a caller key belongs to. */
export function callerNodeOf(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}

/** The callee conversation a caller key speaks in, or null for the member's own. */
export function callerConversationOf(key: string): string | null {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? null : key.slice(at + SEPARATOR.length);
}
