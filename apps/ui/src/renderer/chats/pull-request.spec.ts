import { describe, expect, it } from 'vitest';

import type { PullRequestInfo, PullRequestState } from '../../shared/contracts';
import { splitPullRequests, threadPullRequests } from './pull-request';

function pr(
  number: number,
  headRefName: string,
  state: PullRequestState = 'open',
  isDraft = false,
  updatedAt = '2026-08-01T00:00:00Z',
  isCrossRepository = false,
  headRepositoryOwner: string | null = 'someone',
): PullRequestInfo {
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft,
    headRefName,
    isCrossRepository,
    headRepositoryOwner,
    author: 'someone',
    url: `https://github.com/o/r/pull/${number}`,
    updatedAt,
  };
}

const numbers = (pullRequests: readonly PullRequestInfo[]): number[] =>
  pullRequests.map((entry) => entry.number);

describe('threadPullRequests', () => {
  it('keeps only the pull requests whose head branch is the checked-out one', () => {
    // The scope of every surface. `gh` is asked with `--head`, so a row on
    // another branch should not arrive at all — this is the second wall, and
    // the one that holds when the list is served from an earlier read taken on
    // a branch the folder has since left.
    expect(
      numbers(
        threadPullRequests({
          branch: 'feat/show-prs',
          originOwner: null,
          pullRequests: [pr(1, 'feat/other'), pr(2, 'feat/show-prs')],
        }),
      ),
    ).toEqual([2]);
  });

  it('keeps a branch’s whole history, not just its open pull request', () => {
    // What the panel lists under a thread: reusing a branch after its pull
    // request merged is routine, and the merged one is the history OF this
    // thread's work rather than someone else's — it belongs in the fold below
    // the open one, which is the ticket's own "merged PRs should be collapsed".
    expect(
      numbers(
        threadPullRequests({
          branch: 'feat/reused',
          originOwner: null,
          pullRequests: [
            pr(10, 'feat/reused'),
            pr(9, 'feat/reused', 'merged'),
            pr(8, 'feat/elsewhere', 'merged'),
          ],
        }),
      ),
    ).toEqual([10, 9]);
  });

  it('lists none on a detached HEAD', () => {
    // No branch, so nothing identifies any of these as this thread's — even
    // though the list itself is perfectly good.
    expect(
      threadPullRequests({
        branch: null,
        originOwner: null,
        pullRequests: [pr(1, 'main')],
      }),
    ).toEqual([]);
  });

  it('never claims a STRANGER’s fork pull request, however well the branch matches', () => {
    // A fork's `headRefName` names a branch in someone else's repository, and
    // those are routinely ordinary names — so matching on the name alone would
    // put a stranger's pull request under this thread and offer to open it.
    // `--head` does not filter it out either: gh matches the branch NAME.
    expect(
      numbers(
        threadPullRequests({
          branch: 'main',
          originOwner: 'me',
          pullRequests: [
            pr(
              50,
              'main',
              'open',
              false,
              '2026-08-25T00:00:00Z',
              true,
              'stranger',
            ),
            pr(51, 'main', 'open', false, '2026-08-01T00:00:00Z', false, 'me'),
          ],
        }),
      ),
    ).toEqual([51]);
  });

  it('DOES claim the user’s own fork pull request', () => {
    // The fork-clone case, and the reason the match is on head OWNER rather
    // than on the cross-repository flag alone: with an `upstream` remote `gh`
    // resolves the base repo to upstream, so the user's own pull request comes
    // back cross-repository. Excluding it would leave a fork contributor with
    // an empty panel.
    expect(
      numbers(
        threadPullRequests({
          branch: 'feat/mine',
          originOwner: 'me',
          pullRequests: [
            pr(50, 'feat/mine', 'open', false, undefined, true, 'me'),
          ],
        }),
      ),
    ).toEqual([50]);
  });

  it('matches the user’s own fork whatever case the remote was cloned with', () => {
    // GitHub logins are case-insensitive and it hands back the canonical
    // spelling, while the origin owner is whatever the user typed when cloning.
    // Compared raw, `Me` against `me` leaves a fork contributor with nothing —
    // the one case the owner match exists to serve.
    expect(
      numbers(
        threadPullRequests({
          branch: 'feat/mine',
          originOwner: 'Me',
          pullRequests: [
            pr(50, 'feat/mine', 'open', false, undefined, true, 'me'),
          ],
        }),
      ),
    ).toEqual([50]);
  });

  it('claims no fork whose head repository has been deleted', () => {
    // Nothing is left to compare against, so it cannot be shown as this
    // thread's. A deleted fork is GitHub's own routine null here, which is why
    // the field is parsed as optional rather than dropping the row.
    expect(
      threadPullRequests({
        branch: 'feat/mine',
        originOwner: 'me',
        pullRequests: [
          pr(50, 'feat/mine', 'open', false, undefined, true, null),
        ],
      }),
    ).toEqual([]);
  });

  it('claims no fork when the origin owner is unknown', () => {
    // Without an origin to compare against there is no way to tell the user's
    // own fork pull request from a stranger's, and showing the wrong one is
    // worse than showing none.
    expect(
      threadPullRequests({
        branch: 'main',
        originOwner: null,
        pullRequests: [pr(50, 'main', 'open', false, undefined, true, 'me')],
      }),
    ).toEqual([]);
  });

  it('lists none when no pull request is on this branch', () => {
    expect(
      threadPullRequests({
        branch: 'feat/untouched',
        originOwner: null,
        pullRequests: [pr(1, 'main')],
      }),
    ).toEqual([]);
  });
});

describe('splitPullRequests', () => {
  it('folds merged AND closed-unmerged into one settled group', () => {
    const { open, settled } = splitPullRequests([
      pr(1, 'a'),
      pr(2, 'b', 'merged'),
      pr(3, 'c', 'closed'),
      pr(4, 'd', 'open', true),
    ]);

    // A draft is still open work — it belongs above the fold with the rest.
    expect(numbers(open)).toEqual([1, 4]);
    expect(numbers(settled)).toEqual([2, 3]);
  });

  it('keeps the order it was given inside each group', () => {
    const { settled } = splitPullRequests([
      pr(5, 'a', 'merged'),
      pr(4, 'b', 'closed'),
      pr(3, 'c', 'merged'),
    ]);

    expect(numbers(settled)).toEqual([5, 4, 3]);
  });
});
