import { describe, expect, it } from 'vitest';

import type { PullRequestInfo, PullRequestState } from '../../shared/contracts';
import { currentPullRequest, splitPullRequests } from './pull-request';

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

describe('currentPullRequest', () => {
  it('matches the pull request whose head branch is the checked-out one', () => {
    expect(
      currentPullRequest({
        branch: 'feat/show-prs',
        originOwner: null,
        pullRequests: [pr(1, 'feat/other'), pr(2, 'feat/show-prs')],
      })?.number,
    ).toBe(2);
  });

  it('prefers an OPEN pull request over a merged one from the same branch', () => {
    // Reusing a branch after its pull request merged is routine; naming the
    // merged one as this thread's would describe work that is already over.
    expect(
      currentPullRequest({
        branch: 'feat/reused',
        originOwner: null,
        pullRequests: [pr(9, 'feat/reused', 'merged'), pr(10, 'feat/reused')],
      })?.number,
    ).toBe(10);
  });

  it('falls back to the newest when none on the branch is open', () => {
    // The list arrives newest-first, so the first match is the newest one. The
    // fixtures carry DISTINCT stamps and the assertion reads the chosen one's,
    // so taking the last instead of the first fails here rather than passing on
    // two rows that happen to look alike.
    const chosen = currentPullRequest({
      branch: 'feat/reused',
      originOwner: null,
      pullRequests: [
        pr(10, 'feat/reused', 'closed', false, '2026-08-25T00:00:00Z'),
        pr(9, 'feat/reused', 'merged', false, '2026-07-01T00:00:00Z'),
      ],
    });

    expect(chosen?.number).toBe(10);
    expect(chosen?.updatedAt).toBe('2026-08-25T00:00:00Z');
  });

  it('names none on a detached HEAD', () => {
    // No branch, so nothing identifies one of these as this thread's — even
    // though the list itself is perfectly good.
    expect(
      currentPullRequest({
        branch: null,
        originOwner: null,
        pullRequests: [pr(1, 'main')],
      }),
    ).toBeNull();
  });

  it('never claims a STRANGER’s fork pull request, however well the branch matches', () => {
    // A fork's `headRefName` names a branch in someone else's repository, and
    // those are routinely ordinary names — so matching on the name alone would
    // let a thread on `main` name a stranger's pull request and open it.
    const chosen = currentPullRequest({
      branch: 'main',
      originOwner: 'me',
      pullRequests: [
        pr(50, 'main', 'open', false, '2026-08-25T00:00:00Z', true, 'stranger'),
        pr(51, 'main', 'open', false, '2026-08-01T00:00:00Z', false, 'me'),
      ],
    });

    // The stranger's is newer AND open, so it wins every other tie-break here.
    expect(chosen?.number).toBe(51);
  });

  it('DOES claim the user’s own fork pull request', () => {
    // The fork-clone case, and the reason the match is on head OWNER rather
    // than on the cross-repository flag alone: with an `upstream` remote `gh`
    // resolves the base repo to upstream, so the user's own pull request comes
    // back cross-repository. Excluding it would leave a fork contributor with
    // no current-PR line at all.
    expect(
      currentPullRequest({
        branch: 'feat/mine',
        originOwner: 'me',
        pullRequests: [
          pr(50, 'feat/mine', 'open', false, undefined, true, 'me'),
        ],
      })?.number,
    ).toBe(50);
  });

  it('matches the user’s own fork whatever case the remote was cloned with', () => {
    // GitHub logins are case-insensitive and it hands back the canonical
    // spelling, while the origin owner is whatever the user typed when cloning.
    // Compared raw, `Me` against `me` leaves a fork contributor with no line at
    // all — the one case the owner match exists to serve.
    expect(
      currentPullRequest({
        branch: 'feat/mine',
        originOwner: 'Me',
        pullRequests: [
          pr(50, 'feat/mine', 'open', false, undefined, true, 'me'),
        ],
      })?.number,
    ).toBe(50);
  });

  it('claims no fork whose head repository has been deleted', () => {
    // A deleted fork still belongs in the panel's list, but there is nothing
    // left to compare against, so it cannot be named as this thread's.
    expect(
      currentPullRequest({
        branch: 'feat/mine',
        originOwner: 'me',
        pullRequests: [
          pr(50, 'feat/mine', 'open', false, undefined, true, null),
        ],
      }),
    ).toBeNull();
  });

  it('names none when the only match is a fork and the origin owner is unknown', () => {
    // Without an origin to compare against there is no way to tell the user's
    // own fork pull request from a stranger's, and claiming the wrong one is
    // worse than naming none.
    expect(
      currentPullRequest({
        branch: 'main',
        originOwner: null,
        pullRequests: [pr(50, 'main', 'open', false, undefined, true, 'me')],
      }),
    ).toBeNull();
  });

  it('names none when no pull request is on this branch', () => {
    expect(
      currentPullRequest({
        branch: 'feat/untouched',
        originOwner: null,
        pullRequests: [pr(1, 'main')],
      }),
    ).toBeNull();
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
    expect(open.map((entry) => entry.number)).toEqual([1, 4]);
    expect(settled.map((entry) => entry.number)).toEqual([2, 3]);
  });

  it('keeps the order it was given inside each group', () => {
    const { settled } = splitPullRequests([
      pr(5, 'a', 'merged'),
      pr(4, 'b', 'closed'),
      pr(3, 'c', 'merged'),
    ]);

    expect(settled.map((entry) => entry.number)).toEqual([5, 4, 3]);
  });
});
