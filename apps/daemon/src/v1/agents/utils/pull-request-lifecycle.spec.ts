import { describe, expect, it } from 'vitest';

import {
  countsAfter,
  lifecycleEvents,
  parsePullRequestLifecycle,
} from './pull-request-lifecycle';

const suite = (
  createdAt: string,
  options: {
    app?: string;
    workflow?: string;
    conclusion?: string | null;
    runs?: { name: string; conclusion: string }[];
  } = {},
) => ({
  createdAt,
  conclusion: options.conclusion ?? 'SUCCESS',
  app: { slug: options.app ?? 'github-actions' },
  workflowRun:
    options.workflow === undefined
      ? null
      : { workflow: { name: options.workflow } },
  checkRuns: { nodes: options.runs ?? [] },
});

const commit = (oid: string, suites: ReturnType<typeof suite>[] = []) => ({
  oid,
  checkSuites: { nodes: suites },
});

const thread = (
  createdAt: string,
  login: string,
  typename: 'Bot' | 'User',
  extra: { isResolved?: boolean; isOutdated?: boolean } = {},
) => ({
  isResolved: extra.isResolved ?? false,
  isOutdated: extra.isOutdated ?? false,
  comments: {
    nodes: [{ createdAt, author: { __typename: typename, login } }],
  },
});

function answer(
  pullRequest: Record<string, unknown>,
  timeline: unknown[] = [],
  threads: unknown[] = [],
  reviews: unknown[] = [],
) {
  return {
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          isDraft: false,
          createdAt: '2026-11-19T10:00:00Z',
          mergedAt: null,
          closedAt: null,
          headRefOid: 'head000',
          headRefName: 'feature/x',
          mergeable: 'MERGEABLE',
          timelineItems: { filteredCount: timeline.length, nodes: timeline },
          reviewThreads: { totalCount: threads.length, nodes: threads },
          reviews: { totalCount: reviews.length, nodes: reviews },
          ...pullRequest,
        },
      },
    },
  };
}

const run = (
  createdAt: string,
  headSha: string,
  options: {
    conclusion?: string | null;
    name?: string;
    event?: string;
    pullRequests?: number[];
  } = {},
) => ({
  created_at: createdAt,
  head_sha: headSha,
  event: options.event ?? 'pull_request',
  conclusion: options.conclusion ?? 'success',
  name: options.name ?? 'PR Checks — #7 fix(api): something',
  pull_requests: (options.pullRequests ?? [7]).map((number) => ({ number })),
});

const runsPage = (runs: unknown[], total = runs.length) => ({
  total_count: total,
  workflow_runs: runs,
});

describe('parsePullRequestLifecycle', () => {
  it('counts a rebase as one force push, dated by its event, never by commit dates', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}, [
        {
          __typename: 'HeadRefForcePushedEvent',
          createdAt: '2026-11-19T12:00:05Z',
          beforeCommit: commit('old1', [suite('2026-11-19T11:00:00Z')]),
          afterCommit: commit('new1', [suite('2026-11-19T12:00:04Z')]),
        },
        { __typename: 'PullRequestCommit', commit: commit('new1') },
      ]),
      null,
      7,
    );

    expect(lifecycle?.pushes).toEqual([
      { sha: 'old1', at: '2026-11-19T11:00:00.000Z', force: false },
      { sha: 'new1', at: '2026-11-19T12:00:05.000Z', force: true },
    ]);
  });

  it('keeps a plain push made seconds after a force push as a push of its own', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}, [
        {
          __typename: 'HeadRefForcePushedEvent',
          createdAt: '2026-11-19T12:00:00Z',
          beforeCommit: null,
          afterCommit: commit('rebased'),
        },
      ]),
      [runsPage([run('2026-11-19T12:00:30Z', 'fixup')])],
      7,
    );

    expect(lifecycle?.pushes).toEqual([
      { sha: 'rebased', at: '2026-11-19T12:00:00.000Z', force: true },
      { sha: 'fixup', at: '2026-11-19T12:00:30.000Z', force: false },
    ]);
  });

  it('dates plain pushes from the Actions runs of commits a later rebase rewrote away', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}),
      [
        runsPage([
          run('2026-11-19T09:59:50Z', 'first'),
          run('2026-11-19T11:00:00Z', 'gone1'),
          run('2026-11-19T11:00:00Z', 'gone1', { name: 'Security Scan' }),
          run('2026-11-19T13:00:00Z', 'gone2'),
        ]),
      ],
      7,
    );

    expect(lifecycle?.pushes.map((push) => push.sha)).toEqual([
      'gone1',
      'gone2',
    ]);
  });

  it('leaves out runs of another pull request on a reused branch name, and runs started by hand', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}),
      [
        runsPage([
          run('2026-11-19T11:00:00Z', 'mine'),
          run('2026-11-19T11:30:00Z', 'theirs', { pullRequests: [3] }),
          run('2026-11-18T11:30:00Z', 'before', { pullRequests: [] }),
          run('2026-11-19T12:00:00Z', 'manual', {
            event: 'workflow_dispatch',
            conclusion: 'failure',
          }),
        ]),
      ],
      7,
    );

    expect(lifecycle?.pushes.map((push) => push.sha)).toEqual(['mine']);
    expect(lifecycle?.failedChecks).toEqual([]);
  });

  it('tells bot threads from human ones, a [bot] login included', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer(
        {},
        [],
        [
          thread('2026-11-19T11:00:00Z', 'coderabbitai', 'Bot', {
            isResolved: true,
          }),
          thread('2026-11-19T11:05:00Z', 'renovate[bot]', 'User'),
          thread('2026-11-19T11:10:00Z', 'sergey', 'User', {
            isOutdated: true,
          }),
        ],
      ),
      null,
      7,
    );

    expect(lifecycle?.reviewThreads).toEqual([
      {
        openedAt: '2026-11-19T11:00:00Z',
        author: 'coderabbitai',
        bot: true,
        resolved: true,
        outdated: false,
      },
      {
        openedAt: '2026-11-19T11:05:00Z',
        author: 'renovate[bot]',
        bot: true,
        resolved: false,
        outdated: false,
      },
      {
        openedAt: '2026-11-19T11:10:00Z',
        author: 'sergey',
        bot: false,
        resolved: false,
        outdated: true,
      },
    ]);
  });

  it('names what CI skipped while the pull request was a draft, and only then', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}, [
        {
          __typename: 'ReadyForReviewEvent',
          createdAt: '2026-11-19T12:00:00Z',
        },
        {
          __typename: 'PullRequestCommit',
          commit: commit('a', [
            suite('2026-11-19T11:00:00Z', {
              workflow: 'PR Checks',
              runs: [{ name: 'typecheck', conclusion: 'SKIPPED' }],
            }),
            suite('2026-11-19T13:00:00Z', {
              workflow: 'PR Checks',
              runs: [{ name: 'notify-failure', conclusion: 'SKIPPED' }],
            }),
          ]),
        },
      ]),
      [
        runsPage([
          run('2026-11-19T11:00:00Z', 'a', { conclusion: 'skipped' }),
          run('2026-11-19T13:00:00Z', 'a', {
            conclusion: 'skipped',
            name: 'E2E Tests — PR #7',
          }),
        ]),
      ],
      7,
    );

    expect(lifecycle?.readyAt).toBe('2026-11-19T12:00:00Z');
    expect(lifecycle?.skippedWhileDraft).toEqual([
      'PR Checks',
      'PR Checks: typecheck',
    ]);
  });

  it('reads failed Actions runs from the listing and other apps from their check suites', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}, [
        {
          __typename: 'PullRequestCommit',
          commit: commit('a', [
            suite('2026-11-19T11:00:00Z', {
              app: 'github-actions',
              workflow: 'PR Checks',
              conclusion: 'FAILURE',
            }),
            suite('2026-11-19T11:00:01Z', {
              app: 'circleci',
              conclusion: 'FAILURE',
            }),
          ]),
        },
      ]),
      [
        runsPage([
          run('2026-11-19T11:00:00Z', 'a', { conclusion: 'failure' }),
          run('2026-11-19T11:30:00Z', 'a', { conclusion: 'cancelled' }),
        ]),
      ],
      7,
    );

    expect(lifecycle?.failedChecks).toEqual([
      {
        sha: 'a',
        at: '2026-11-19T11:00:00Z',
        workflow: 'PR Checks',
        conclusion: 'failure',
      },
      {
        sha: 'a',
        at: '2026-11-19T11:00:01Z',
        workflow: 'circleci',
        conclusion: 'failure',
      },
    ]);
  });

  it('falls back to check suites for Actions when the runs could not be listed', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({}, [
        {
          __typename: 'PullRequestCommit',
          commit: commit('a', [
            suite('2026-11-19T11:00:00Z', {
              workflow: 'PR Checks',
              conclusion: 'FAILURE',
            }),
          ]),
        },
      ]),
      null,
      7,
    );

    expect(lifecycle?.actionsRunsRead).toBe(false);
    expect(lifecycle?.failedChecks.map((check) => check.workflow)).toEqual([
      'PR Checks',
    ]);
  });

  it('says which lists GitHub answered only in part', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer({
        reviewThreads: { totalCount: 140, nodes: [] },
      }),
      [runsPage([], 400)],
      7,
    );

    expect(lifecycle?.truncated).toEqual(['actionsRuns', 'reviewThreads']);
  });

  it('is null for an answer that holds no pull request', () => {
    expect(
      parsePullRequestLifecycle({ data: { repository: null } }, null, 7),
    ).toBeNull();
    expect(parsePullRequestLifecycle('not json', null, 7)).toBeNull();
  });
});

describe('countsAfter', () => {
  it('counts only what happened strictly after the mark', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer(
        {},
        [
          {
            __typename: 'HeadRefForcePushedEvent',
            createdAt: '2026-11-19T13:00:00Z',
            beforeCommit: null,
            afterCommit: commit('b'),
          },
        ],
        [
          thread('2026-11-19T11:00:00Z', 'cursor', 'Bot'),
          thread('2026-11-19T12:30:00Z', 'cursor', 'Bot'),
          thread('2026-11-19T12:40:00Z', 'sergey', 'User'),
        ],
        [
          {
            submittedAt: '2026-11-19T12:50:00Z',
            author: { __typename: 'User', login: 'sergey' },
          },
        ],
      ),
      [runsPage([run('2026-11-19T13:00:02Z', 'b', { conclusion: 'failure' })])],
      7,
    )!;

    expect(countsAfter(lifecycle, '2026-11-19T12:00:00Z')).toEqual({
      pushes: 1,
      forcePushes: 1,
      botThreads: 1,
      humanThreads: 1,
      failedChecks: 1,
      changesRequested: 1,
    });
  });
});

describe('lifecycleEvents', () => {
  it('lists the life in time order, ending at the merge', () => {
    const lifecycle = parsePullRequestLifecycle(
      answer(
        { state: 'MERGED', mergedAt: '2026-11-20T09:00:00Z' },
        [
          {
            __typename: 'ReadyForReviewEvent',
            createdAt: '2026-11-19T12:00:00Z',
          },
        ],
        [thread('2026-11-19T12:30:00Z', 'cursor', 'Bot')],
      ),
      null,
      7,
    )!;

    expect(lifecycleEvents(lifecycle).map((event) => event.kind)).toEqual([
      'opened',
      'ready',
      'review-thread',
      'merged',
    ]);
  });
});
