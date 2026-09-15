/**
 * When a chat is due an automatic compaction, and the sentence that says so on
 * the transcript. Pure, so the rule is exercised without a turn.
 */

/**
 * How far past its post-compaction baseline a conversation must regrow, as a
 * share of the window, before it is compacted again. Without it a threshold
 * below what a fresh conversation already holds (the system prompt, the tool
 * listings, the summary itself) compacts after every single turn — a paid turn
 * that reclaims nothing.
 */
export const AUTO_COMPACT_REGROWTH_FRACTION = 0.1;

/**
 * What an automatic compaction sends — the same word a user types, resolved
 * through `AgentAdapter.geniroCommandFor` so each CLI gets its own compaction.
 */
export const AUTO_COMPACT_COMMAND = '/compact';

/** One conversation's context, as the CLI last reported it. */
export interface AutoCompactReading {
  tokens: number | null;
  window: number | null;
}

/**
 * How full the window is, as a percentage — or null when either figure is
 * missing or not a measurement. A zero window is not a measurement: dividing by
 * it would report every conversation as infinitely full.
 */
export function contextPercent(reading: AutoCompactReading): number | null {
  const { tokens, window } = reading;
  if (tokens === null || window === null || tokens <= 0 || window <= 0) {
    return null;
  }
  return (tokens / window) * 100;
}

/**
 * Whether the conversation has reached its auto-compact threshold. A null
 * threshold never fires, and neither does a reading nothing measured — a
 * compaction is a real turn with a real cost, and guessing one is owed would
 * spend it on a conversation that may be nearly empty.
 */
export function autoCompactDue(
  percent: number | null,
  reading: AutoCompactReading,
  /**
   * Tokens measured on the first settled turn after the last compaction, or
   * null when there has been none. A compaction is owed again only once the
   * conversation has regrown past it by {@link AUTO_COMPACT_REGROWTH_FRACTION}.
   */
  baselineTokens: number | null = null,
): boolean {
  if (percent === null) {
    return false;
  }
  const full = contextPercent(reading);
  if (full === null || full < percent) {
    return false;
  }
  if (baselineTokens === null || reading.tokens === null || reading.window === null) {
    return true;
  }
  return (
    reading.tokens >=
    baselineTokens + reading.window * AUTO_COMPACT_REGROWTH_FRACTION
  );
}

/** The transcript note written just before an automatic compaction runs. */
export function autoCompactNotice(
  percent: number,
  reading: AutoCompactReading,
): string {
  const full = contextPercent(reading);
  const figures =
    full === null || reading.tokens === null || reading.window === null
      ? ''
      : ` (${Math.round(full)}% — ${formatThousands(reading.tokens)} of ${formatThousands(reading.window)} tokens)`;
  return `Context reached the ${percent}% auto-compact threshold${figures} — compacting the conversation.`;
}

function formatThousands(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
