import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GhCommandRunner } from '../chat.types';
import type { ManagedCommandResult } from '../utils/managed-command';
import {
  LIFECYCLE_READ_CONCURRENCY,
  OPEN_LIFECYCLE_TTL_MS,
  PullRequestLifecycleService,
} from './pull-request-lifecycle.service';

const ok = (stdout: unknown): ManagedCommandResult => ({
  code: 0,
  stdout: JSON.stringify(stdout),
  stderr: '',
  timedOut: false,
});

const pullRequest = (state: 'OPEN' | 'MERGED', isDraft = false) => ({
  data: {
    repository: {
      pullRequest: {
        state,
        isDraft,
        createdAt: '2026-11-19T10:00:00Z',
        mergedAt: state === 'MERGED' ? '2026-11-20T10:00:00Z' : null,
        closedAt: state === 'MERGED' ? '2026-11-20T10:00:00Z' : null,
        headRefOid: 'head',
        headRefName: 'feature/x',
        mergeable: 'MERGEABLE',
        timelineItems: { totalCount: 0, nodes: [] },
        reviewThreads: { totalCount: 0, nodes: [] },
        reviews: { totalCount: 0, nodes: [] },
      },
    },
  },
});

const ref = { owner: 'acme', repo: 'app', number: 7 };

function serviceAnswering(answer: (args: string[]) => ManagedCommandResult): {
  service: PullRequestLifecycleService;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: GhCommandRunner = (command) => {
    calls.push(command.args);
    return Promise.resolve(answer(command.args));
  };
  return { service: new PullRequestLifecycleService(run), calls };
}

const isGraphql = (args: string[]): boolean => args[1] === 'graphql';

afterEach(() => {
  vi.useRealTimers();
});

describe('PullRequestLifecycleService', () => {
  it('reads the timeline by GraphQL and the branch Actions runs by REST', async () => {
    const { service, calls } = serviceAnswering((args) =>
      isGraphql(args)
        ? ok(pullRequest('OPEN'))
        : ok({
            total_count: 1,
            workflow_runs: [
              {
                created_at: '2026-11-19T11:00:00Z',
                head_sha: 'second',
                event: 'pull_request',
                conclusion: 'failure',
                name: 'PR Checks',
                pull_requests: [{ number: 7 }],
              },
            ],
          }),
    );

    const read = await service.read(ref);

    expect(read).toMatchObject({
      lifecycle: {
        actionsRunsRead: true,
        failedChecks: [{ sha: 'second', workflow: 'PR Checks' }],
      },
    });
    expect(calls[0]).toContain('owner=acme');
    expect(calls[0]).toContain('number=7');
    expect(calls[1]![1]).toBe(
      'repos/acme/app/actions/runs?branch=feature%2Fx&per_page=100&page=1',
    );
  });

  it('keeps the lifecycle when the Actions runs cannot be listed', async () => {
    const { service } = serviceAnswering((args) =>
      isGraphql(args)
        ? ok(pullRequest('OPEN'))
        : { code: 1, stdout: '', stderr: 'HTTP 403', timedOut: false },
    );

    expect(await service.read(ref)).toMatchObject({
      lifecycle: { actionsRunsRead: false },
    });
  });

  it.each([
    [{ spawnError: 'ENOENT' }, 'gh-missing'],
    [{ timedOut: true }, 'timed-out'],
    [
      { stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
      'gh-signed-out',
    ],
    [
      {
        stderr:
          "GraphQL: Could not resolve to a Repository with the name 'acme/app'.",
      },
      'not-found',
    ],
    [{ stderr: 'something else' }, 'unreadable'],
  ] as const)(
    'answers %o as unavailable %s, never throwing',
    async (failure, reason) => {
      const { service } = serviceAnswering(() => ({
        code: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...failure,
      }));

      expect(await service.read(ref)).toEqual({ unavailable: reason });
    },
  );

  it('serves a merged pull request from memory and asks again for an open one after its TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
    let state: 'OPEN' | 'MERGED' = 'OPEN';
    const { service, calls } = serviceAnswering((args) =>
      isGraphql(args)
        ? ok(pullRequest(state))
        : ok({ total_count: 0, workflow_runs: [] }),
    );
    const graphqlCalls = (): number => calls.filter(isGraphql).length;

    await service.read(ref);
    await service.read(ref);
    expect(graphqlCalls()).toBe(1);

    vi.setSystemTime(Date.now() + OPEN_LIFECYCLE_TTL_MS + 1);
    state = 'MERGED';
    await service.read(ref);
    expect(graphqlCalls()).toBe(2);

    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await service.read({ ...ref, owner: 'ACME' });
    expect(graphqlCalls()).toBe(2);
  });

  it('does not keep a failure that may pass on the next ask', async () => {
    let fail = true;
    const { service } = serviceAnswering((args) =>
      fail
        ? { code: null, stdout: '', stderr: '', timedOut: true }
        : isGraphql(args)
          ? ok(pullRequest('MERGED'))
          : ok({ total_count: 0, workflow_runs: [] }),
    );

    expect(await service.read(ref)).toEqual({ unavailable: 'timed-out' });
    fail = false;
    expect(await service.read(ref)).toHaveProperty('lifecycle');
  });

  it('asks GitHub once for two reads of the same pull request at once', async () => {
    const { service, calls } = serviceAnswering((args) =>
      isGraphql(args)
        ? ok(pullRequest('MERGED'))
        : ok({ total_count: 0, workflow_runs: [] }),
    );

    const [first, second] = await Promise.all([
      service.read(ref),
      service.read(ref),
    ]);

    expect(first).toBe(second);
    expect(calls.filter(isGraphql)).toHaveLength(1);
  });

  it('serves a cached reading even once the budget is spent', async () => {
    const { service, calls } = serviceAnswering((args) =>
      isGraphql(args)
        ? ok(pullRequest('MERGED'))
        : ok({ total_count: 0, workflow_runs: [] }),
    );
    await service.read(ref);

    const reads = await service.readMany([ref], 0);

    expect([...reads.values()][0]).toHaveProperty('lifecycle');
    expect(calls.filter(isGraphql)).toHaveLength(1);
  });

  it('cuts each gh call to what is left of the read budget', async () => {
    const timeouts: number[] = [];
    const run: GhCommandRunner = (command) => {
      timeouts.push(command.timeoutMs);
      return Promise.resolve(
        command.args[1] === 'graphql'
          ? ok(pullRequest('MERGED'))
          : ok({ total_count: 0, workflow_runs: [] }),
      );
    };

    await new PullRequestLifecycleService(run).readMany([ref], 12_000);

    expect(timeouts).toHaveLength(2);
    for (const timeout of timeouts) {
      expect(timeout).toBeLessThanOrEqual(12_000);
      expect(timeout).toBeGreaterThan(10_000);
    }
  });

  it('answers read-budget-spent for what it could not start in time', async () => {
    const { service, calls } = serviceAnswering((args) =>
      isGraphql(args)
        ? ok(pullRequest('MERGED'))
        : ok({ total_count: 0, workflow_runs: [] }),
    );

    const reads = await service.readMany([ref, { ...ref, number: 8 }], 0);

    expect([...reads.values()]).toEqual([
      { unavailable: 'read-budget-spent' },
      { unavailable: 'read-budget-spent' },
    ]);
    expect(calls).toEqual([]);
  });

  it('reads up to eight pull requests at once and never more', async () => {
    let inFlight = 0;
    let most = 0;
    const run: GhCommandRunner = async (command) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return command.args[1] === 'graphql'
        ? ok(pullRequest('MERGED'))
        : ok({ total_count: 0, workflow_runs: [] });
    };

    const reads = await new PullRequestLifecycleService(run).readMany(
      Array.from({ length: 20 }, (_, index) => ({ ...ref, number: index + 1 })),
    );

    expect(LIFECYCLE_READ_CONCURRENCY).toBe(8);
    expect(most).toBe(LIFECYCLE_READ_CONCURRENCY);
    expect([...reads.values()].every((read) => 'lifecycle' in read)).toBe(true);
  });
});
