import { formatTokens } from './agent-activity';

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
  /**
   * Which CONVERSATION of that node this is — see {@link liveTextKey}. Null
   * from a daemon predating the per-call key, where the node WAS the key.
   */
  ownerKey: string | null;
  text: string;
  /**
   * Reasoning tokens spent in the CURRENT stretch, or null when not thinking.
   * Per stretch, not cumulative over the turn.
   */
  thinkingTokens: number | null;
  /**
   * What the agent is thinking, as it thinks it — the WHOLE tail of the current
   * stretch — or null when there is nothing to show.
   *
   * The alternative to {@link LiveTextEvent.thinkingTokens} rather than its
   * companion, and which one arrives is a property of the CLI: claude redacts
   * its thinking and sends a token count, cursor streams the words. So null
   * here means "no text", never "not thinking".
   */
  thinkingText: string | null;
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
  /**
   * What THIS TURN has spent so far, summed over its requests as they land.
   *
   * A RUNNING TOTAL where `contextTokens` above is a level — the two move
   * independently, and a compaction sends them opposite ways. Cache reads stay
   * their own figure because they are priced apart and dominate the input side
   * of any resumed conversation.
   *
   * CLAUDE ONLY, and null for cursor — which exposes no token accounting a
   * client can reach at all (see the daemon's `RunDeltaEvent` for the four
   * channels that were measured and found empty). Null is "not measured", so
   * the row simply does not draw the figure rather than showing a zero.
   */
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
}

/** What one agent is doing right now, as the transcript renders it. */
export interface LiveState {
  text: string;
  thinkingTokens: number | null;
  thinkingText: string | null;
  thinkingSince: number | null;
  thinkingStretch: number | null;
  contextTokens: number | null;
  contextWindowTokens: number | null;
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
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
  const { runId, nodeId, ownerKey, text } = data as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof text !== 'string') {
    return null;
  }
  const record = data as Record<string, unknown>;
  return {
    runId,
    nodeId: typeof nodeId === 'string' ? nodeId : null,
    // Absent on an event from a daemon older than the per-call key, where the
    // node WAS the key — so falling back to it is the honest reading of that
    // wire rather than a guess.
    ownerKey: typeof ownerKey === 'string' ? ownerKey : null,
    text,
    // Zero is a real answer here and nowhere else on this event: a stretch's
    // very first delta can legitimately report no tokens yet, and reading that
    // as "not thinking" would hide the row for exactly as long as the agent
    // had nothing to show for the wait. Whether the agent IS thinking is
    // `thinkingStretch`'s job, not this field's.
    thinkingTokens: nonNegativeNumber(record.thinkingTokens),
    // An EMPTY string reads as null on purpose: it is what a stretch with
    // nothing said yet and a CLI that redacts its thinking both amount to, and
    // treating it as text would draw an empty reasoning bubble for both.
    thinkingText:
      typeof record.thinkingText === 'string' && record.thinkingText !== ''
        ? record.thinkingText
        : null,
    thinkingSince: positiveNumber(record.thinkingSince),
    thinkingStretch: positiveNumber(record.thinkingStretch),
    contextTokens: positiveNumber(record.contextTokens),
    contextWindowTokens: positiveNumber(record.contextWindowTokens),
    // NON-NEGATIVE, unlike the two above: a turn whose first request produced
    // nothing yet has genuinely spent 0 output tokens, and reading that as
    // "unmeasured" would hide the whole figure for as long as the agent was
    // still thinking — which is precisely the stretch this exists to fill.
    spentInputTokens: nonNegativeNumber(record.spentInputTokens),
    spentOutputTokens: nonNegativeNumber(record.spentOutputTokens),
    spentCacheReadTokens: nonNegativeNumber(record.spentCacheReadTokens),
  };
}

/**
 * This turn's running token bill as one short phrase, or null when nothing has
 * reported it.
 *
 * `↑` is what the turn PUT IN and `↓` what it got back — arrows rather than
 * words because the row carrying this already has an activity phrase and a
 * clock and one line to fit them in. Cache reads are folded into the input side
 * here, unlike on the wire: the split decides a bill and not a glance, and a
 * third figure is what pushes the phrase off the row.
 *
 * Null when NEITHER half was measured, which is every cursor turn — see
 * {@link LiveState.spentInputTokens}. A measured ZERO still draws: "this turn
 * has produced nothing yet" is true, useful, and exactly what the reader of a
 * long-running turn is asking.
 *
 * Here rather than in the component: the fold is where the live state is in
 * hand, and the row's own renderer holds a payload with no plane behind it.
 */
export function formatLiveSpend(state: {
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
}): string | null {
  const input =
    state.spentInputTokens === null && state.spentCacheReadTokens === null
      ? null
      : (state.spentInputTokens ?? 0) + (state.spentCacheReadTokens ?? 0);
  const output = state.spentOutputTokens;
  if (input === null && output === null) {
    return null;
  }
  const parts: string[] = [];
  if (input !== null) {
    parts.push(`↑${formatTokens(input)}`);
  }
  if (output !== null) {
    parts.push(`↓${formatTokens(output)}`);
  }
  return parts.join(' ');
}

/** A positive number off an untyped field, else null — the defensive default. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

/** Same, for a count whose zero is meaningful rather than absent. */
function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 ? value : null;
}

/**
 * Which CONVERSATION a delta belongs to — the map key.
 *
 * The daemon's own owner key when it sent one: a node can hold several threads
 * at once (its own turn, and one per call it is serving), and each has its own
 * context window. Keyed by node alone they shared one entry and the last
 * writer won, which is what put one flickering ring over a panel honestly
 * counting two threads.
 */
export function liveTextKey(
  nodeId: string | null,
  ownerKey: string | null = null,
): string {
  // NO NODE ID means the 1:1 chat, whatever owner key rides with it — and one
  // always does: the daemon publishes `SINGLE_AGENT_NODE` ('agent'), the
  // pseudo-node a chat's own rows are filed under, as the owner of its live
  // plane. Reading that owner key as the map key is how this twin drifted from
  // its producer: the sentinel here was renamed from that very word to a
  // NUL-prefixed one (see {@link CHAT_LIVE_KEY}), and nothing on the daemon
  // side changed, so a chat's deltas landed under `agent` while every reader
  // that has no event to derive a key from — `workingAgents`,
  // `awaitingAnswer`, the context meter's live source — went on asking for the
  // sentinel. Nothing failed to compile, which is what the TWIN PARSER block
  // above warns about.
  //
  // REPORTED as a chat showing `Thinking… · 2s` and `Working… · 15s` at the
  // same time, and reproduced in the running app: `withLiveText` suppresses the
  // working fallback for an agent that already has a live row, by KEY, and the
  // two keys could never match. The context ring's live source was the quieter
  // half of the same drift.
  //
  // The discriminator is exact rather than a guess: a workflow node's delta
  // always carries its node id (`GraphExecutorService` passes `node.id`), so a
  // node literally named `agent` — the collision the sentinel exists for —
  // still keys as itself.
  if (nodeId === null) {
    return CHAT_LIVE_KEY;
  }
  return ownerKey ?? nodeId;
}

/**
 * TWIN PARSER: `apps/daemon/src/v1/agents/services/partial-stream.service.ts`
 * `OWNER_KEY_SEPARATOR` / {@link partialOwnerKey} / {@link ownerOfKey}.
 *
 * The daemon OWNS this encoding — it is what `agent_delta` is published under —
 * and nothing generated spans the seam, since the event is deliberately outside
 * the HTTP contract. So the separator and both directions are spelled here as
 * an independent implementation, and a change to either side MUST be mirrored
 * on the other. Nothing fails to compile when they drift: the symptom is every
 * call thread's context ring going blank.
 */
export const OWNER_KEY_SEPARATOR = '::';

/** The live-plane owner key for one node's turn, or one of its CALL threads. */
export function partialOwnerKey(nodeId: string, callId: string | null): string {
  return callId === null ? nodeId : `${nodeId}${OWNER_KEY_SEPARATOR}${callId}`;
}

/**
 * The NODE an owner key belongs to — the key itself for a node's own turn, and
 * the part before the separator for a callee turn's per-call key.
 */
export function ownerOfKey(ownerKey: string): string {
  const split = ownerKey.indexOf(OWNER_KEY_SEPARATOR);
  return split === -1 ? ownerKey : ownerKey.slice(0, split);
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
  const key = liveTextKey(event.nodeId, event.ownerKey);
  // A context figure alone is NOT "doing something" — it keeps arriving after
  // a block goes durable — so the entry is KEPT (the meter still needs the
  // number) while `withLiveText` declines to draw a bubble for it. Only an
  // entry with nothing at all to say is dropped.
  if (
    event.text === '' &&
    event.thinkingStretch === null &&
    event.contextTokens === null &&
    // A SPEND figure keeps the entry too, on the same reasoning the context
    // figure is kept for: it is not "doing something", but the row that shows
    // what this turn has cost needs it, and dropping the entry would blank
    // that figure between two deltas.
    event.spentOutputTokens === null &&
    event.spentInputTokens === null
  ) {
    next.delete(key);
  } else {
    next.set(key, {
      text: event.text,
      thinkingTokens: event.thinkingTokens,
      thinkingText: event.thinkingText,
      thinkingSince: event.thinkingSince,
      thinkingStretch: event.thinkingStretch,
      contextTokens: event.contextTokens,
      contextWindowTokens: event.contextWindowTokens,
      spentInputTokens: event.spentInputTokens,
      spentOutputTokens: event.spentOutputTokens,
      spentCacheReadTokens: event.spentCacheReadTokens,
    });
  }
  return next;
}
