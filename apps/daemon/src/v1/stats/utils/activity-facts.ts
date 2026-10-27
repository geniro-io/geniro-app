import { pullRequestOutcomeKey } from '../../agents/utils/pull-request-capture';
import type { ActivityFact, PullRequestActivityInput } from '../stats.types';

/** That a run was created. One per run. */
export function threadFact(runId: string, occurredAt: Date): ActivityFact {
  return { kind: 'thread', dedupKey: `thread:${runId}`, runId, occurredAt };
}

/** A pull request one run opened. One per run and pull request. */
export function pullRequestFact(input: PullRequestActivityInput): ActivityFact {
  return {
    kind: 'pull_request',
    dedupKey: `pr:${input.runId}:${input.owner}/${input.repo}#${input.number}`,
    runId: input.runId,
    occurredAt: input.occurredAt,
    prOwner: input.owner,
    prRepo: input.repo,
    prNumber: input.number,
    prUrl: input.url,
  };
}

/**
 * The ledger key of one pull request's outcome on one run — updated in place, never
 * duplicated. Owner and repo are case-folded, as GitHub resolves them, so two calls
 * writing one pull request's URL in different cases still land on one row.
 */
export function runOutcomeKey(row: {
  runId: string;
  prOwner: string;
  prRepo: string;
  prNumber: number;
}): string {
  return `outcome:${row.runId}:${pullRequestOutcomeKey({
    owner: row.prOwner,
    repo: row.prRepo,
    number: row.prNumber,
  })}`;
}
