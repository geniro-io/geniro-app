import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DaemonHandle,
  PullRequestInfo,
  PullRequestRef,
  PullRequestRefResult,
  PullRequestState,
} from '../shared/contracts';
import {
  type MergeWatcherDeps,
  PullRequestMergeWatcher,
} from './pull-request-merge-watcher';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok',
  version: '0.1.0',
  startedAt: '2026-09-07T12:00:00.000Z',
};

const urlOf = (number: number): string =>
  `https://github.com/geniro-io/geniro-app/pull/${number}`;

interface AwaitingRow {
  taskId: string;
  title?: string;
  numbers: number[];
}

/** One card in review, as the daemon's `awaiting-merge` route gives it. */
function awaiting(row: AwaitingRow): Record<string, unknown> {
  return {
    taskId: row.taskId,
    projectId: 'project-1',
    title: row.title ?? row.taskId,
    pullRequests: row.numbers.map((number) => ({
      owner: 'geniro-io',
      repo: 'geniro-app',
      number,
      url: urlOf(number),
      seq: 0,
    })),
  };
}

/**
 * A stand-in daemon answering the two routes a sweep uses.
 *
 * It records every report so a test can assert on WHICH card was ended and
 * with which pull request — the whole of what a tick actually decides.
 */
function daemon(rows: Record<string, unknown>[]) {
  const reports: { path: string; body: Record<string, unknown> }[] = [];
  const refuse = new Set<string>();
  let listFails = false;
  const fetchMock = vi.fn(
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST') {
        if (refuse.has(path)) {
          return {
            ok: false,
            status: 400,
            text: async () => '{"description":"it moved"}',
          } as Response;
        }
        reports.push({
          path,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return { ok: true, status: 200 } as Response;
      }
      if (listFails) {
        return { ok: false, status: 500, text: async () => '' } as Response;
      }
      return { ok: true, status: 200, json: async () => rows } as Response;
    },
  );
  return {
    fetchMock,
    reports,
    refuse,
    failList: () => {
      listFails = true;
    },
  };
}

/** What GitHub says about each ref: merged for the numbers named, else open. */
function github(merged: number[]) {
  const read = vi.fn(
    async (refs: readonly PullRequestRef[]): Promise<PullRequestRefResult[]> =>
      refs.map((ref) => ({
        ref,
        pullRequest: {
          number: ref.number,
          title: `pr ${ref.number}`,
          state: (merged.includes(ref.number)
            ? 'merged'
            : 'open') satisfies PullRequestState as PullRequestState,
          isDraft: false,
          headRefName: 'feat/x',
          isCrossRepository: false,
          headRepositoryOwner: 'geniro-io',
          author: 'someone',
          url: ref.url,
          updatedAt: '2026-09-07T12:00:00.000Z',
        } as PullRequestInfo,
      })),
  );
  return read;
}

function deps(over: Partial<MergeWatcherDeps> = {}): MergeWatcherDeps {
  return {
    handle: () => handle,
    readPullRequests: github([]),
    log: () => {},
    intervalMs: 1000,
    ...over,
  };
}

describe('PullRequestMergeWatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ends the card whose pull request has been merged, and only that one', async () => {
    const server = daemon([
      awaiting({ taskId: 'task-merged', numbers: [7] }),
      awaiting({ taskId: 'task-open', numbers: [8] }),
    ]);
    vi.stubGlobal('fetch', server.fetchMock);
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: github([7]) }),
    );

    await watcher.tick();

    expect(server.reports).toEqual([
      {
        path: '/v1/tasks/task-merged/pull-request-merged',
        body: { url: urlOf(7) },
      },
    ]);
  });

  it('reports the pull request that actually merged, not the first one listed', async () => {
    // A card whose agent opened several: naming the wrong one is refused by
    // the daemon, so the card would sit in review for good.
    const server = daemon([awaiting({ taskId: 'task-1', numbers: [7, 8, 9] })]);
    vi.stubGlobal('fetch', server.fetchMock);
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: github([9]) }),
    );

    await watcher.tick();

    expect(server.reports[0]?.body).toEqual({ url: urlOf(9) });
  });

  it('asks GitHub nothing when no card is awaiting a merge', async () => {
    const server = daemon([]);
    vi.stubGlobal('fetch', server.fetchMock);
    const read = github([7]);
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: read }),
    );

    await watcher.tick();

    // The cost is bounded by the work: an ordinary session, where nothing sits
    // in review, spends no `gh` lookups at all.
    expect(read).not.toHaveBeenCalled();
  });

  it('asks about each pull request once when two cards name the same one', async () => {
    const server = daemon([
      awaiting({ taskId: 'task-1', numbers: [7] }),
      awaiting({ taskId: 'task-2', numbers: [7] }),
    ]);
    vi.stubGlobal('fetch', server.fetchMock);
    const read = github([7]);
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: read }),
    );

    await watcher.tick();

    expect(read.mock.calls[0]?.[0]).toHaveLength(1);
    // Both cards still end: the dedupe is about the lookup, not the outcome.
    expect(server.reports.map((row) => row.path)).toEqual([
      '/v1/tasks/task-1/pull-request-merged',
      '/v1/tasks/task-2/pull-request-merged',
    ]);
  });

  it('carries on with the other cards when the daemon refuses one', async () => {
    const server = daemon([
      awaiting({ taskId: 'task-1', numbers: [7] }),
      awaiting({ taskId: 'task-2', numbers: [8] }),
    ]);
    server.refuse.add('/v1/tasks/task-1/pull-request-merged');
    vi.stubGlobal('fetch', server.fetchMock);
    const logs: string[] = [];
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: github([7, 8]), log: (m) => logs.push(m) }),
    );

    await watcher.tick();

    expect(server.reports.map((row) => row.path)).toEqual([
      '/v1/tasks/task-2/pull-request-merged',
    ]);
    expect(logs.join('\n')).toContain('it moved');
  });

  it('does not throw when the card listing fails', async () => {
    const server = daemon([]);
    server.failList();
    vi.stubGlobal('fetch', server.fetchMock);
    const logs: string[] = [];
    const watcher = new PullRequestMergeWatcher(
      deps({ log: (m) => logs.push(m) }),
    );

    await expect(watcher.tick()).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('could not read its cards');
  });

  it('does nothing at all while no daemon is running', async () => {
    const server = daemon([awaiting({ taskId: 'task-1', numbers: [7] })]);
    vi.stubGlobal('fetch', server.fetchMock);
    const watcher = new PullRequestMergeWatcher(
      deps({ handle: () => null, readPullRequests: github([7]) }),
    );

    await watcher.tick();

    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  describe('sweepIfStale', () => {
    it('sweeps when the last one is older than the interval', async () => {
      const server = daemon([awaiting({ taskId: 'task-1', numbers: [7] })]);
      vi.stubGlobal('fetch', server.fetchMock);
      let now = 10_000;
      const watcher = new PullRequestMergeWatcher(
        deps({
          readPullRequests: github([7]),
          intervalMs: 1000,
          now: () => now,
        }),
      );

      await watcher.tick();
      now += 1000;
      await watcher.sweepIfStale();

      expect(server.reports).toHaveLength(2);
    });

    it('holds off while the last sweep is still fresh', async () => {
      const server = daemon([awaiting({ taskId: 'task-1', numbers: [7] })]);
      vi.stubGlobal('fetch', server.fetchMock);
      let now = 10_000;
      const watcher = new PullRequestMergeWatcher(
        deps({
          readPullRequests: github([7]),
          intervalMs: 1000,
          now: () => now,
        }),
      );

      await watcher.tick();
      now += 999;
      // Focusing the window repeatedly must not become a `gh` lookup per visit.
      await watcher.sweepIfStale();

      expect(server.reports).toHaveLength(1);
    });
  });
});
