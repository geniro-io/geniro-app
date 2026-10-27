import { RunOutcomePayloadSchema } from '../../agents/chat.types';
import type { RunOutcomeLedgerRow } from '../stats.types';
import { runOutcomeKey } from './activity-facts';

/**
 * The ledger row one `run_outcome` item says, or null for a payload that does not
 * read as one — a row the stats module cannot read is left out rather than written
 * with guessed figures.
 */
export function ledgerRowOf(item: {
  runId: string;
  seq: number;
  payload: unknown;
  createdAt: Date;
}): RunOutcomeLedgerRow | null {
  const parsed = RunOutcomePayloadSchema.safeParse(item.payload);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  return {
    runId: item.runId,
    sourceSeq: item.seq,
    occurredAt: item.createdAt,
    workflowSlug: payload.workflowSlug,
    prOwner: payload.prOwner,
    prRepo: payload.prRepo,
    prNumber: payload.prNumber,
    prUrl: payload.prUrl,
    draft: payload.draft,
    reviewRounds: payload.reviewRounds,
    acceptance: payload.acceptance,
    questionsAsked: payload.questionsAsked,
  };
}

/** Each run's newest outcome per pull request, keyed like the ledger. */
export function newestOutcomes(
  rows: readonly RunOutcomeLedgerRow[],
): Map<string, RunOutcomeLedgerRow> {
  const newest = new Map<string, RunOutcomeLedgerRow>();
  for (const row of rows) {
    const key = runOutcomeKey(row);
    const seen = newest.get(key);
    if (seen === undefined || seen.sourceSeq < row.sourceSeq) {
      newest.set(key, row);
    }
  }
  return newest;
}
