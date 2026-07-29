/**
 * The live (not-yet-durable) assistant text one agent is writing right now.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/chat.types.ts` `RunDeltaEvent` is the
 * producing shape, published on the `agent_delta` Socket.IO event. No route
 * carries it — it is deliberately outside the generated HTTP contract, since
 * nothing about it is persisted — so the two sides are independent
 * implementations and a shape change on either MUST be mirrored on the other.
 *
 * The wire carries the WHOLE tail rather than an increment, which is what makes
 * a dropped event harmless: the next one is authoritative, and an empty string
 * means "those words are durable now, stop showing this". Everything here is
 * throwaway state — a reload or a reconnect simply shows the persisted
 * transcript, which is never missing anything a delta was carrying.
 */

/** The agent key used for a 1:1 chat, whose items carry no node id. */
export const CHAT_LIVE_KEY = 'agent';

/** One `agent_delta` payload, as read defensively off an untyped WS event. */
export interface LiveTextEvent {
  runId: string;
  nodeId: string | null;
  text: string;
  /** Reasoning tokens so far, or null when the agent is not thinking. */
  thinkingTokens: number | null;
}

/** What one agent is doing right now, as the transcript renders it. */
export interface LiveState {
  text: string;
  thinkingTokens: number | null;
}

/**
 * Read an `agent_delta` payload, or null when it is not one. Defensive because
 * this shape has no generated type to guarantee it: a daemon/renderer version
 * skew must degrade to "no live text", never to a crashed transcript.
 */
export function parseLiveText(data: unknown): LiveTextEvent | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const { runId, nodeId, text } = data as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof text !== 'string') {
    return null;
  }
  const thinkingTokens = (data as Record<string, unknown>).thinkingTokens;
  return {
    runId,
    nodeId: typeof nodeId === 'string' ? nodeId : null,
    text,
    thinkingTokens:
      typeof thinkingTokens === 'number' && thinkingTokens > 0
        ? thinkingTokens
        : null,
  };
}

/** Which agent's bubble a delta belongs to. */
export function liveTextKey(nodeId: string | null): string {
  return nodeId ?? CHAT_LIVE_KEY;
}

/**
 * Apply one event to the per-agent live map. An agent with neither words nor a
 * reasoning total is REMOVED rather than stored empty, so callers can treat
 * "has a key" as "is doing something right now".
 */
export function applyLiveText(
  current: ReadonlyMap<string, LiveState>,
  event: LiveTextEvent,
): Map<string, LiveState> {
  const next = new Map(current);
  const key = liveTextKey(event.nodeId);
  if (event.text === '' && event.thinkingTokens === null) {
    next.delete(key);
  } else {
    next.set(key, {
      text: event.text,
      thinkingTokens: event.thinkingTokens,
    });
  }
  return next;
}
