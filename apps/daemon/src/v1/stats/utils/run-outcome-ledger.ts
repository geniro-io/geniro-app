import type { RunPullRequestOutcomes } from '../../agents/chat.types';
import { pullRequestOutcomeKey } from '../../agents/utils/pull-request-capture';
import { parseRunOutcomePayload } from '../../agents/utils/run-outcome-payload';
import type { RunOutcomeLedgerRow } from '../stats.types';
import { runOutcomeKey } from './activity-facts';

/**
 * The ledger row one `run_outcome` item says, or null for a payload that does not
 * read as one — a row the stats module cannot read is left out rather than written
 * with guessed figures. The history figures are not the item's to say: they wait for
 * {@link withHistory}.
 */
export function ledgerRowOf(item: {
  runId: string;
  seq: number;
  payload: unknown;
  createdAt: Date;
}): RunOutcomeLedgerRow | null {
  const parsed = parseRunOutcomePayload(item.payload);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  return {
    runId: item.runId,
    sourceSeq: item.seq,
    occurredAt: item.createdAt,
    teamSlug: payload.teamSlug,
    prOwner: payload.prOwner,
    prRepo: payload.prRepo,
    prNumber: payload.prNumber,
    prUrl: payload.prUrl,
    draft: payload.draft,
    reviewRounds: payload.reviewRounds,
    acceptance: payload.acceptance,
    questionsAsked: payload.questionsAsked,
    changesRequestedRounds: null,
    msToAccepted: null,
  };
}

/**
 * The row with what the run's whole outcome history says about its pull request: the
 * questions asked before it, counted afresh, and the history figures. Unchanged when
 * the history no longer holds the row (its run was deleted meanwhile).
 */
export function withHistory(
  row: RunOutcomeLedgerRow,
  history: readonly RunPullRequestOutcomes[],
): RunOutcomeLedgerRow {
  const key = pullRequestOutcomeKey({
    owner: row.prOwner,
    repo: row.prRepo,
    number: row.prNumber,
  });
  const pullRequest = history.find(
    (entry) => pullRequestOutcomeKey(entry) === key,
  );
  const outcome = pullRequest?.outcomes.find(
    (entry) => entry.seq === row.sourceSeq,
  );
  if (pullRequest === undefined || outcome === undefined) {
    return row;
  }
  return {
    ...row,
    questionsAsked: outcome.questionsAsked,
    changesRequestedRounds: pullRequest.changesRequestedRounds,
    msToAccepted: pullRequest.msToAccepted,
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
