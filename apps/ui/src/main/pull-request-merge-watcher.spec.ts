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

/** When GitHub says a pull request merged, unless a test names another time. */
const MERGED_AT = '2026-09-07T11:00:00Z';

interface AwaitingRow {
  taskId: string;
  title?: string;
  numbers: number[];
  /** When the card last entered Done; null (the default) for never. */
  lastDoneAt?: string | null;
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
    lastDoneAt: row.lastDoneAt ?? null,
  };
}

/**
 * A stand-in daemon answering the two routes a sweep uses.
 *
 * It records every report so a test can assert on WHICH card was ended and
 * with which pull request — the whole of what a tick actually decides.
 */
function daemon(listing: unknown) {
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
      return { ok: true, status: 200, json: async () => listing } as Response;
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

/**
 * What GitHub says about each ref: merged for the numbers named, else open.
 *
 * A merged one carries {@link MERGED_AT} unless `mergedAt` names another time
 * for it — or null, for a merge gh gave no time for.
 */
function github(
  merged: number[],
  mergedAt: Partial<Record<number, string | null>> = {},
) {
  const read = vi.fn(
    async (refs: readonly PullRequestRef[]): Promise<PullRequestRefResult[]> =>
      refs.map((ref) => {
        const isMerged = merged.includes(ref.number);
        const at = ref.number in mergedAt ? mergedAt[ref.number] : MERGED_AT;
        return {
          ref,
          pullRequest: {
            number: ref.number,
            title: `pr ${ref.number}`,
            state: (isMerged
              ? 'merged'
              : 'open') satisfies PullRequestState as PullRequestState,
            isDraft: false,
            headRefName: 'feat/x',
            isCrossRepository: false,
            headRepositoryOwner: 'geniro-io',
            author: 'someone',
            url: ref.url,
            updatedAt: '2026-09-07T12:00:00.000Z',
            ...(isMerged && typeof at === 'string' ? { mergedAt: at } : {}),
          } as PullRequestInfo,
        };
      }),
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
        body: { url: urlOf(7), mergedAt: MERGED_AT },
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

    expect(server.reports[0]?.body).toEqual({
      url: urlOf(9),
      mergedAt: MERGED_AT,
    });
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

  /**
   * A card re-opened after Done continues the same thread, so the pull request
   * that ended it the first time is listed and merged still. Only a merge that
   * HAPPENED after the card last reached Done may end it — and the watcher is
   * the one process that can say when a merge happened.
   */
  describe('a card that has been Done before', () => {
    const DONE_AT = '2026-09-07T12:00:00.000Z';
    const HOUR_BEFORE = '2026-09-07T11:00:00Z';
    const HOUR_AFTER = '2026-09-07T13:00:00Z';

    it('skips the previous round’s merge and reports this round’s', async () => {
      // Taking the FIRST merged one, the watcher reported #7 — refused by the
      // daemon every sweep — and never reached #8, the merge that ends it.
      const server = daemon([
        awaiting({ taskId: 'task-1', numbers: [7, 8], lastDoneAt: DONE_AT }),
      ]);
      vi.stubGlobal('fetch', server.fetchMock);
      const watcher = new PullRequestMergeWatcher(
        deps({
          readPullRequests: github([7, 8], { 7: HOUR_BEFORE, 8: HOUR_AFTER }),
        }),
      );

      await watcher.tick();

      expect(server.reports).toEqual([
        {
          path: '/v1/tasks/task-1/pull-request-merged',
          body: { url: urlOf(8), mergedAt: HOUR_AFTER },
        },
      ]);
    });

    it('reports nothing when the only merge happened before the card last reached Done', async () => {
      const server = daemon([
        awaiting({ taskId: 'task-1', numbers: [7], lastDoneAt: DONE_AT }),
      ]);
      vi.stubGlobal('fetch', server.fetchMock);
      const watcher = new PullRequestMergeWatcher(
        deps({ readPullRequests: github([7], { 7: HOUR_BEFORE }) }),
      );

      await watcher.tick();

      expect(server.reports).toEqual([]);
    });

    it('treats a merge at the very instant the card reached Done as the previous round’s', async () => {
      const server = daemon([
        awaiting({ taskId: 'task-1', numbers: [7], lastDoneAt: DONE_AT }),
      ]);
      vi.stubGlobal('fetch', server.fetchMock);
      const watcher = new PullRequestMergeWatcher(
        deps({ readPullRequests: github([7], { 7: DONE_AT }) }),
      );

      await watcher.tick();

      expect(server.reports).toEqual([]);
    });

    it('ends a card dragged to Done and back when its pull request merges afterwards', async () => {
      // #7 was still open when the card went to Done and back. Judged by when
      // #7 was opened, the card could never be ended by it again.
      const server = daemon([
        awaiting({ taskId: 'task-1', numbers: [7], lastDoneAt: DONE_AT }),
      ]);
      vi.stubGlobal('fetch', server.fetchMock);
      const watcher = new PullRequestMergeWatcher(
        deps({ readPullRequests: github([7], { 7: HOUR_AFTER }) }),
      );

      await watcher.tick();

      expect(server.reports).toEqual([
        {
          path: '/v1/tasks/task-1/pull-request-merged',
          body: { url: urlOf(7), mergedAt: HOUR_AFTER },
        },
      ]);
    });

    it('leaves alone a merge GitHub gave no time for', async () => {
      // It may be the finished round's — the daemon would refuse it anyway.
      const server = daemon([
        awaiting({ taskId: 'task-1', numbers: [7], lastDoneAt: DONE_AT }),
      ]);
      vi.stubGlobal('fetch', server.fetchMock);
      const watcher = new PullRequestMergeWatcher(
        deps({ readPullRequests: github([7], { 7: null }) }),
      );

      await watcher.tick();

      expect(server.reports).toEqual([]);
    });
  });

  it('reports a merge with no known time on a card never Done, and says the time is unknown', async () => {
    // Before its first Done every merge is this round's; the daemon still
    // wants to be TOLD the time is unknown rather than find it missing.
    const server = daemon([awaiting({ taskId: 'task-1', numbers: [7] })]);
    vi.stubGlobal('fetch', server.fetchMock);
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: github([7], { 7: null }) }),
    );

    await watcher.tick();

    expect(server.reports[0]?.body).toEqual({ url: urlOf(7), mergedAt: null });
  });

  it('drops a card it cannot read, and still acts on the rest', async () => {
    // The listing is untrusted JSON. A boundary that is neither null nor a
    // time must not read as "never Done" — that is how a finished round's
    // merge would end the card.
    const good = awaiting({ taskId: 'task-good', numbers: [7] });
    const server = daemon([
      awaiting({
        taskId: 'task-bad-boundary',
        numbers: [7],
        lastDoneAt: 'lately',
      }),
      {
        ...awaiting({ taskId: 'task-no-boundary', numbers: [7] }),
        lastDoneAt: undefined,
      },
      { ...awaiting({ taskId: 'ignored', numbers: [7] }), taskId: 42 },
      {
        ...good,
        // A pull request naming no url cannot be asked about, or reported.
        pullRequests: [
          { owner: 'geniro-io', repo: 'geniro-app', number: 9 },
          ...(good.pullRequests as unknown[]),
        ],
      },
    ]);
    vi.stubGlobal('fetch', server.fetchMock);
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: github([7, 9]) }),
    );

    await watcher.tick();

    expect(server.reports).toEqual([
      {
        path: '/v1/tasks/task-good/pull-request-merged',
        body: { url: urlOf(7), mergedAt: MERGED_AT },
      },
    ]);
  });

  it('asks GitHub nothing when the listing is not a list', async () => {
    const server = daemon({ tasks: [] });
    vi.stubGlobal('fetch', server.fetchMock);
    const read = github([7]);
    const logs: string[] = [];
    const watcher = new PullRequestMergeWatcher(
      deps({ readPullRequests: read, log: (m) => logs.push(m) }),
    );

    await watcher.tick();

    expect(read).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(
      'the awaiting-merge listing is not a list',
    );
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
