/**
 * The auto-compact thresholds the composer's model panel offers. The daemon
 * accepts any whole number from 10 to 95 (`AutoCompactPercentSchema`); these
 * are the steps worth a row.
 */
export const AUTO_COMPACT_PERCENTS: readonly number[] = [50, 60, 70, 80, 90];

/** The row label for one threshold. */
export function autoCompactLabel(percent: number): string {
  return `at ${percent}%`;
}

/** What an unset threshold reads as — the conversation is never compacted. */
export const AUTO_COMPACT_OFF_LABEL = 'off';
