import type {
  PullRequestInfo,
  PullRequestsResult,
} from '../../shared/contracts';

/**
 * THIS thread's pull request: the one whose head branch is the branch its
 * folder currently has checked out.
 *
 * The match is a live read rather than anything stored — no branch is kept on a
 * run — which is also what keeps it correct after a branch switch inside an
 * open thread.
 */
export function currentPullRequest(
  result: PullRequestsResult,
): PullRequestInfo | null {
  const { branch, originOwner } = result;
  if (branch === null) {
    return null;
  }
  const onThisBranch = result.pullRequests.filter(
    (pullRequest) =>
      pullRequest.headRefName === branch && isOurHead(pullRequest, originOwner),
  );
  // An OPEN one outranks a settled one from the same branch. Reusing a branch
  // after its pull request merged is routine, and naming the merged one as this
  // thread's PR would describe work that is already over. Otherwise the newest,
  // which is the order the list arrives in.
  return (
    onThisBranch.find((pullRequest) => pullRequest.state === 'open') ??
    onThisBranch[0] ??
    null
  );
}

/**
 * Whether this pull request's head branch is the one THIS checkout has.
 *
 * A same-repo pull request always is. A cross-repository one is only when its
 * head lives in this folder's own `origin`: that is the fork-clone case, where
 * `gh` resolves the base repo to `upstream` and reports the user's own pull
 * request as cross-repository. A stranger's fails here, which is the point —
 * fork branch names are routinely ordinary ones (`main`, `patch-1`), so
 * matching on the name alone would let a thread claim someone else's work.
 */
function isOurHead(
  pullRequest: PullRequestInfo,
  originOwner: string | null,
): boolean {
  if (!pullRequest.isCrossRepository) {
    return true;
  }
  // Case-FOLDED, because the two sides are not the same kind of string: GitHub
  // logins are case-insensitive and it hands back the canonical spelling, while
  // the origin owner is whatever the user typed when they cloned. `Acme` against
  // `acme` would otherwise leave a fork contributor with no line at all — the
  // one case this comparison exists to serve.
  return (
    originOwner !== null &&
    pullRequest.headRepositoryOwner !== null &&
    pullRequest.headRepositoryOwner.toLowerCase() === originOwner.toLowerCase()
  );
}

/**
 * Open pull requests, and the finished ones folded together.
 *
 * Merged and closed-unmerged share ONE group rather than two: both are over,
 * each row's own status pill already tells them apart, and a separate heading
 * would give abandoned work its own block on a panel whose subject is what is
 * still in flight.
 */
export function splitPullRequests(pullRequests: readonly PullRequestInfo[]): {
  open: PullRequestInfo[];
  settled: PullRequestInfo[];
} {
  const open: PullRequestInfo[] = [];
  const settled: PullRequestInfo[] = [];
  for (const pullRequest of pullRequests) {
    (pullRequest.state === 'open' ? open : settled).push(pullRequest);
  }
  return { open, settled };
}
