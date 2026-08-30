import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { readRunPullRequests } from '../utils/pull-request-capture';
import type { AgentEventBus } from './agent-events.bus';
import { PullRequestCaptureService } from './pull-request-capture.service';

// `fork` because the SETTLE path takes its own context — the listing runs
// inside the request's, this one has no request to borrow. The daos are
// doubles and ignore it either way.
const em = { fork: () => em } as unknown as EntityManager;

interface Row {
  seq: number;
  kind: 'tool_call' | 'tool_result';
  payload: string;
}

function call(seq: number, id: string, command: string): Row {
  return {
    seq,
    kind: 'tool_call',
    payload: JSON.stringify({ id, name: 'Bash', input: { command } }),
  };
}

function result(seq: number, id: string, text: string): Row {
  return {
    seq,
    kind: 'tool_result',
    payload: JSON.stringify({ id, name: null, result: text }),
  };
}

/**
 * The two DAOs the pass reads, over an in-memory transcript.
 *
 * Counters rather than spies on both reads: what this spec pins about the
 * incremental half is that a settled run costs NO payload read, and a call
 * count is the only way to say that.
 */
function daos(rows: Row[]) {
  const counts = { max: 0, candidates: 0 };
  const itemDao = {
    maxSeq: async () => {
      counts.max += 1;
      return rows.reduce((top, row) => Math.max(top, row.seq), -1);
    },
    pullRequestCandidates: async (_runId: string, afterSeq: number) => {
      counts.candidates += 1;
      return rows.filter(
        (row) =>
          row.kind === 'tool_result' &&
          row.seq > afterSeq &&
          row.payload.includes('/pull/'),
      ) as unknown as Pick<Item, 'seq' | 'payload'>[];
    },
    findToolCallPair: async (_runId: string, callId: string) => ({
      call:
        (rows.find(
          (row) => row.kind === 'tool_call' && row.payload.includes(callId),
        ) as unknown as Item) ?? null,
      result: null,
    }),
  } as unknown as ItemDao;
  return { itemDao, counts };
}

function runDao(): { dao: RunDao; writes: Partial<Run>[] } {
  const writes: Partial<Run>[] = [];
  const dao = {
    updateById: async (_id: string, data: Partial<Run>) => {
      writes.push(data);
      return 1;
    },
  } as unknown as RunDao;
  return { dao, writes };
}

function chatRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    pullRequests: null,
    pullRequestsScannedSeq: null,
    ...overrides,
  } as Run;
}

const CREATED = 'https://github.com/acme/platform/pull/87';

/**
 * The two collaborators the SETTLE path needs, inert for the tests that only
 * drive `sync`.
 *
 * A factory rather than a shared object: `published` is asserted on, and one
 * array across tests would carry a previous test's announcements into the next.
 */
function settleDeps(): {
  em: EntityManager;
  bus: AgentEventBus;
  published: unknown[];
  listeners: ((event: {
    runId: string;
    item: { nodeId: string | null; kind: string };
  }) => void)[];
} {
  const published: unknown[] = [];
  const listeners: ((event: {
    runId: string;
    item: { nodeId: string | null; kind: string };
  }) => void)[] = [];
  const bus = {
    all: () => ({
      subscribe: (fn: (event: never) => void) => {
        listeners.push(fn as never);
        return { unsubscribe: () => undefined };
      },
    }),
    publishRunStatus: (status: unknown) => published.push(status),
  } as unknown as AgentEventBus;
  return { em: em, bus, published, listeners };
}

describe('PullRequestCaptureService', () => {
  it('captures the pull request a gh pr create call opened', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'cd /repo && gh pr create --base main'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();
    const run = chatRun();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
    ).sync([run], em);

    expect(readRunPullRequests(writes[0]?.pullRequests ?? null)).toEqual([
      {
        owner: 'acme',
        repo: 'platform',
        number: 87,
        url: CREATED,
        seq: 2,
      },
    ]);
    // Written back onto the row too, so the projection in the same request
    // sees it rather than the previous pass's answer.
    expect(readRunPullRequests(run.pullRequests)).toHaveLength(1);
  });

  it('does NOT capture a pull request the thread only READ', async () => {
    // This is the branch query's mistake from the other side: the URL is in the
    // transcript, and the pull request is somebody else's.
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr view 87 --json url'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
    ).sync([chatRun()], em);

    expect(writes[0]?.pullRequests).toBeNull();
  });

  it('recovers pull requests opened BEFORE the run was ever scanned', async () => {
    // The backfill: a marker of null means the whole transcript is read once,
    // which is what makes history recoverable with no migration.
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED),
      call(3, 'toolu_2', 'gh pr create'),
      result(4, 'toolu_2', 'https://github.com/acme/mobile-app/pull/10'),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
    ).sync([chatRun()], em);

    expect(
      readRunPullRequests(writes[0]?.pullRequests ?? null).map(
        (row) => `${row.repo}#${row.number}`,
      ),
    ).toEqual(['platform#87', 'mobile-app#10']);
    expect(counts.candidates).toBe(1);
  });

  it('advances the marker even when the transcript held none', async () => {
    // Without this a conversation with no pull requests is re-read from the
    // beginning on every chat list for the rest of its life.
    const { itemDao } = daos([
      call(1, 'toolu_1', 'ls'),
      result(2, 'toolu_1', 'a'),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
    ).sync([chatRun()], em);

    expect(writes[0]?.pullRequestsScannedSeq).toBe(2);
    expect(writes[0]?.pullRequests).toBeNull();
  });

  it('reads no payloads at all when the run has not moved', async () => {
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
    ).sync([chatRun({ pullRequestsScannedSeq: 2 })], em);

    expect(counts.max).toBe(1);
    expect(counts.candidates).toBe(0);
    expect(writes).toEqual([]);
  });

  it('keeps listing the other runs when one transcript cannot be read', async () => {
    // It runs inside the chat list. One unreadable transcript must cost that
    // thread its pull-request row and nothing else.
    const failing = {
      maxSeq: async () => {
        throw new Error('disk went away');
      },
    } as unknown as ItemDao;
    const { dao, writes } = runDao();
    const service = new PullRequestCaptureService(
      failing,
      dao,
      settleDeps().em,
      settleDeps().bus,
    );

    await expect(
      service.sync([chatRun(), chatRun({ id: 'run-2' })], em),
    ).resolves.toBeUndefined();
    expect(writes).toEqual([]);
  });
});

/**
 * Let the subscriber's fire-and-forget work finish.
 *
 * `onModuleInit` deliberately does not await — an RxJS subscriber cannot — so
 * there is no promise for a test to hold, and the chain behind it is five
 * awaits deep (the row, `max(seq)`, the candidates, each pair, the write).
 * A macrotask turn clears all of them; counting microtasks would be a number
 * that quietly stops being right the moment a query is added.
 */
const settled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('PullRequestCaptureService — capturing when a TURN ends', () => {
  /** A run dao that also answers `getById`, which the settle path needs. */
  function settleRunDao(run: Run): { dao: RunDao; writes: Partial<Run>[] } {
    const writes: Partial<Run>[] = [];
    const dao = {
      getById: async () => run,
      updateById: async (_id: string, data: Partial<Run>) => {
        writes.push(data);
        Object.assign(run, data);
        return 1;
      },
    } as unknown as RunDao;
    return { dao, writes };
  }

  it('captures on a turn ending, and ANNOUNCES what it found', async () => {
    // THE REPORTED DEFECT. The capture ran on the chat LISTING alone, which is
    // one fetch per window — so a thread that opened a pull request during the
    // session it was opened in never showed a chip for it, however long the
    // window stayed open. Reconstructed from the reporter's own database: the
    // window listed the chats at seq 441, `gh pr create` landed at seq 1827,
    // and the marker was still 441 hours later.
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --base main'),
      result(2, 'toolu_1', CREATED),
    ]);
    const run = chatRun();
    const { dao } = settleRunDao(run);
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
    );
    service.onModuleInit();

    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: null, kind: 'turn_complete' },
    });
    await settled();

    expect(readRunPullRequests(run.pullRequests)).toHaveLength(1);
    expect(deps.published).toEqual([
      {
        runId: 'run-1',
        // NEVER a status: this says what the run HAS, and an event that did not
        // read the run must not assert whether it is still going.
        status: null,
        pullRequests: [
          { owner: 'acme', repo: 'platform', number: 87, url: CREATED, seq: 2 },
        ],
      },
    ]);
  });

  it('says NOTHING when a turn ended without changing the answer', async () => {
    // The common case by far — a chat with no pull requests in it — and it must
    // not broadcast an empty array to every window on every turn.
    const { itemDao } = daos([call(1, 'toolu_1', 'pnpm build')]);
    const run = chatRun();
    const { dao } = settleRunDao(run);
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
    );
    service.onModuleInit();

    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: null, kind: 'turn_complete' },
    });
    await settled();

    expect(deps.published).toEqual([]);
  });

  it('ignores a workflow NODE and a mid-turn row', async () => {
    // A node's transcript is not a chat's, and scanning on every tool call
    // would turn one indexed read per turn into one per row.
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create --base main'),
      result(2, 'toolu_1', CREATED),
    ]);
    const run = chatRun();
    const { dao } = settleRunDao(run);
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
    );
    service.onModuleInit();

    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: 'node-a', kind: 'turn_complete' },
    });
    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: null, kind: 'tool_call' },
    });
    await settled();

    expect(deps.published).toEqual([]);
    expect(counts.max).toBe(0);
  });
});
