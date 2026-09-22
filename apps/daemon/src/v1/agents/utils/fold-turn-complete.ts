import type { AgentEvent, AgentUsage } from '../adapters/adapter.types';

type TurnComplete = Extract<AgentEvent, { type: 'turn_complete' }>;

/**
 * One `turn_complete` for a turn the CLI answered in TWO `result` lines.
 *
 * That happens when a follow-up written into the turn is taken only after its
 * first `result` (see `AgentEvent`'s `user_message_consumed`): geniro holds
 * the first line back and settles on the second, and both segments are the
 * same turn's work. Dropping the first would lose its bill — the adapter has
 * already turned each line into THAT segment's figures, so they add up.
 *
 * What the segments did is SUMMED (tokens, cost, time). What describes the
 * window NOW is the later reading, falling back to the earlier one only where
 * the later said nothing: a context measurement is a level, not a total. The
 * answer and the stop reason are the later segment's, since that is what the
 * turn ended on.
 */
export function foldTurnComplete(
  earlier: TurnComplete,
  later: TurnComplete,
): TurnComplete {
  return {
    ...later,
    usage: foldUsage(earlier.usage, later.usage),
    finalText: later.finalText ?? earlier.finalText,
  };
}

function foldUsage(
  earlier: AgentUsage | null,
  later: AgentUsage | null,
): AgentUsage | null {
  if (earlier === null || later === null) {
    return later ?? earlier;
  }
  // The window and the model it describes travel as a PAIR: a window read off
  // one segment under the other segment's model name would be filed under the
  // wrong model by the cross-run window cache.
  const windowReading = later.contextWindowTokens !== null ? later : earlier;
  return {
    inputTokens: sum(earlier.inputTokens, later.inputTokens),
    outputTokens: sum(earlier.outputTokens, later.outputTokens),
    cacheReadTokens: sum(earlier.cacheReadTokens, later.cacheReadTokens),
    cacheCreationTokens: sum(
      earlier.cacheCreationTokens,
      later.cacheCreationTokens,
    ),
    thinkingTokens: sum(earlier.thinkingTokens, later.thinkingTokens),
    contextTokens: later.contextTokens ?? earlier.contextTokens,
    contextWindowTokens: windowReading.contextWindowTokens,
    contextModel: windowReading.contextModel,
    costUsd: sum(earlier.costUsd, later.costUsd),
    durationMs: sum(earlier.durationMs, later.durationMs),
    apiMs: sum(earlier.apiMs, later.apiMs),
    // A COUNT of requests made, like the token fields above — sums.
    numTurns: sum(earlier.numTurns, later.numTurns),
    // Both describe the START of the turn (time to the first token, time
    // before the first request), which happened in the EARLIER segment —
    // never summed, and falling back to the later reading only when the
    // earlier one said nothing.
    ttftMs: earlier.ttftMs ?? later.ttftMs,
    timeToRequestMs: earlier.timeToRequestMs ?? later.timeToRequestMs,
  };
}

/** Null only when NEITHER segment measured it — null means "not measured". */
function sum(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}
