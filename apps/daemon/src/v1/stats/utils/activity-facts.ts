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
