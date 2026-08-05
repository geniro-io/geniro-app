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

/**
 * The map key used for a 1:1 chat's agent, whose items carry no node id.
 *
 * NUL-prefixed so it cannot collide with a real one. A workflow node id is any
 * non-empty string, so `agent` is a legal — and obvious — node name; while the
 * sentinel was that same word, `liveTextKey` and its inverse stopped being
 * inverses for such a node, and its streamed words were torn out of its own
 * block and rendered in a phantom one at the bottom of the transcript.
 */
export const CHAT_LIVE_KEY = '\u0000chat';

/** One `agent_delta` payload, as read defensively off an untyped WS event. */
export interface LiveTextEvent {
  runId: string;
  nodeId: string | null;
  text: string;
  /**
   * Reasoning tokens spent in the CURRENT stretch, or null when not thinking.
   * Per stretch, not cumulative over the turn.
   */
  thinkingTokens: number | null;
  /** Epoch ms the CURRENT stretch began, or null when not thinking. */
  thinkingSince: number | null;
  /**
   * Which reasoning stretch of this turn the two fields above describe
   * (counting from 1), or null when not thinking. Only its CHANGE matters: a
   * new number means a new wait, which gets its own row and its own clock.
   */
  thinkingStretch: number | null;
  /** Prompt-side tokens as of the turn's latest request, or null. */
  contextTokens: number | null;
  /** The window those tokens are measured against, or null if unreported. */
  contextWindowTokens: number | null;
}

/** What one agent is doing right now, as the transcript renders it. */
export interface LiveState {
  text: string;
  thinkingTokens: number | null;
  thinkingSince: number | null;
  thinkingStretch: number | null;
  contextTokens: number | null;
  contextWindowTokens: number | null;
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
  const record = data as Record<string, unknown>;
  return {
    runId,
    nodeId: typeof nodeId === 'string' ? nodeId : null,
    text,
    // Zero is a real answer here and nowhere else on this event: a stretch's
    // very first delta can legitimately report no tokens yet, and reading that
    // as "not thinking" would hide the row for exactly as long as the agent
    // had nothing to show for the wait. Whether the agent IS thinking is
    // `thinkingStretch`'s job, not this field's.
    thinkingTokens: nonNegativeNumber(record.thinkingTokens),
    thinkingSince: positiveNumber(record.thinkingSince),
    thinkingStretch: positiveNumber(record.thinkingStretch),
    contextTokens: positiveNumber(record.contextTokens),
    contextWindowTokens: positiveNumber(record.contextWindowTokens),
  };
}

/** A positive number off an untyped field, else null — the defensive default. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

/** Same, for a count whose zero is meaningful rather than absent. */
function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 ? value : null;
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
  // A context figure alone is NOT "doing something" — it keeps arriving after
  // a block goes durable — so the entry is KEPT (the meter still needs the
  // number) while `withLiveText` declines to draw a bubble for it. Only an
  // entry with nothing at all to say is dropped.
  if (
    event.text === '' &&
    event.thinkingStretch === null &&
    event.contextTokens === null
  ) {
    next.delete(key);
  } else {
    next.set(key, {
      text: event.text,
      thinkingTokens: event.thinkingTokens,
      thinkingSince: event.thinkingSince,
      thinkingStretch: event.thinkingStretch,
      contextTokens: event.contextTokens,
      contextWindowTokens: event.contextWindowTokens,
    });
  }
  return next;
}
