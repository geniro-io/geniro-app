import type { UsageEvent } from '../entity/usage-event.entity';

/**
 * Whether a recorded turn has the shape of a resumed process's opening line:
 * no turns, no tokens, under a second, and a cost anyway — the ledger-row
 * reading of the claude adapter's own quiet-result test. Only the shape —
 * {@link restoredTotalMatch} is what ties the cost to an earlier total, and an
 * adapter that records no process-end totals never matches.
 */
export function looksLikeResumePhantom(row: UsageEvent): boolean {
  return (
    row.numTurns === 0 &&
    row.costUsd !== null &&
    row.costUsd > 0 &&
    row.durationMs !== null &&
    row.durationMs < RESUME_PHANTOM_MAX_MS &&
    [
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheCreationTokens,
    ].every((tokens) => !tokens)
  );
}

/** @see looksLikeResumePhantom */
export const RESUME_PHANTOM_MAX_MS = 1_000;

/**
 * How `costUsd` relates to a session's recorded process-end totals (oldest
 * first): exactly one of them (`total`), exactly a later one less an earlier
 * one (`gap`), or neither.
 *
 * Neither proves a second bill alone: a `total` can hold spend the replaced
 * process made after its last result ({@link correctedTotalCost}), and a `gap`
 * is also what a process killed mid-turn spent without a result, legitimately
 * billed to the next line ({@link billedJustBefore}).
 */
export function restoredTotalMatch(
  costUsd: number,
  totals: readonly number[],
): 'total' | 'gap' | null {
  if (totals.includes(costUsd)) {
    return 'total';
  }
  return totals.some((earlier, index) =>
    totals.slice(index + 1).some((later) => later - earlier === costUsd),
  )
    ? 'gap'
    : null;
}

/**
 * Whether the turns billed just before a row — `costs`, newest first — add up
 * to `amount`: a gap someone already paid for, so a row billing it is a
 * second bill. Summed in that order, as the turns a resumed process followed.
 */
export function billedJustBefore(
  amount: number,
  costs: readonly number[],
): boolean {
  let sum = 0;
  for (const cost of costs) {
    sum += cost;
    if (Math.abs(sum - amount) <= BILLED_SUM_TOLERANCE_USD) {
      return true;
    }
    if (sum > amount + BILLED_SUM_TOLERANCE_USD) {
      return false;
    }
  }
  return false;
}

/**
 * What a row that billed its session's whole recorded total should have cost:
 * that total less what the turns just before it already billed, never below
 * zero. The rest is what the replaced process spent after its last result,
 * which no other row holds. Null when no turn before the row fits inside its
 * total — nothing in its own conversation was billed before it, so its total
 * may be the only bill that spend ever got, and it stands.
 *
 * `costs` are the node's turns before the row, newest first, and they are
 * summed only while they fit inside the total: the ledger names no session,
 * and a node holds one per call, so a turn that would overshoot belongs to an
 * earlier conversation, and so does every turn before it.
 */
export function correctedTotalCost(
  totalUsd: number,
  costs: readonly number[],
): number | null {
  let billed = 0;
  for (const cost of costs) {
    if (billed + cost > totalUsd + BILLED_SUM_TOLERANCE_USD) {
      break;
    }
    billed += cost;
  }
  if (billed <= BILLED_SUM_TOLERANCE_USD) {
    return null;
  }
  const rest = totalUsd - billed;
  return rest <= BILLED_SUM_TOLERANCE_USD ? 0 : rest;
}

/** Float slack for the sums above — far below a cent. */
const BILLED_SUM_TOLERANCE_USD = 1e-9;
