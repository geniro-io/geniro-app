import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { PullRequestsCapturedEvent } from '../chat.types';
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
  /** When the row was written. One that names none reads as written at {@link WRITTEN_AT}. */
  createdAt?: Date;
}

/**
 * When a row that names no time of its own was written: a fixed past instant,
 * so a time read off a row can never be mistaken for the clock a case freezes.
 */
const WRITTEN_AT = new Date('2026-02-01T08:00:00.000Z');

/** The `createdAt` a builder was asked for, or none — the row then reads as {@link WRITTEN_AT}. */
function writtenAt(iso: string | undefined): Pick<Row, 'createdAt'> {
  return iso === undefined ? {} : { createdAt: new Date(iso) };
}

function call(
  seq: number,
  id: string,
  command: string,
  createdAt?: string,
): Row {
  return {
    seq,
    kind: 'tool_call',
    payload: JSON.stringify({ id, name: 'Bash', input: { command } }),
    ...writtenAt(createdAt),
  };
}

function result(
  seq: number,
  id: string,
  text: string,
  createdAt?: string,
): Row {
  return {
    seq,
    kind: 'tool_result',
    payload: JSON.stringify({ id, name: null, result: text }),
    ...writtenAt(createdAt),
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
    // The read that dates a captured pull request: each named seq's earliest tool
    // result, as the real DAO answers it. The ordering is pinned against the real DAO
    // in item.dao.spec.ts; this double answers the same question.
    earliestToolResultTimes: async (_runId: string, seqs: readonly number[]) =>
      new Map(
        seqs.flatMap((seq) => {
          const row = rows.find(
            (candidate) =>
              candidate.seq === seq && candidate.kind === 'tool_result',
          );
          return row === undefined
            ? []
            : [[seq, row.createdAt ?? WRITTEN_AT] as const];
        }),
      ),
  } as unknown as ItemDao;
  return { itemDao, counts };
}

function runDao(): { dao: RunDao; writes: Partial<Run>[] } {
  const writes: Partial<Run>[] = [];
  const dao = {
    updateWithoutActivity: async (_id: string, data: Partial<Run>) => {
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
 * `acme/platform#87` as the activity ledger is told of it: its identity, its
 * URL and when it was opened — never the `seq` it was captured at.
 */
function platform87(occurredAt: string) {
  return {
    owner: 'acme',
    repo: 'platform',
    number: 87,
    url: CREATED,
    occurredAt,
  };
}

/**
 * The two collaborators the SETTLE path needs, inert for the tests that only
 * drive `sync`.
 *
 * A factory rather than a shared object: `published` and `captured` are
 * asserted on, and one array across tests would carry a previous test's
 * announcements into the next.
 */
function settleDeps(): {
  em: EntityManager;
  bus: AgentEventBus;
  published: unknown[];
  captured: PullRequestsCapturedEvent[];
  listeners: ((event: {
    runId: string;
    item: { nodeId: string | null; kind: string };
  }) => void)[];
} {
  const published: unknown[] = [];
  const captured: PullRequestsCapturedEvent[] = [];
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
    publishPullRequestsCaptured: (event: PullRequestsCapturedEvent) =>
      captured.push(event),
  } as unknown as AgentEventBus;
  return { em: em, bus, published, captured, listeners };
}

/**
 * A service over `rows` with an inert settle path, and what its bus was handed.
 *
 * `itemDao` is replaceable for the cases that break one read; `writes` is what
 * reached the run row.
 */
function announcing(rows: Row[], itemDao: ItemDao = daos(rows).itemDao) {
  const { dao, writes } = runDao();
  const deps = settleDeps();
  return {
    service: new PullRequestCaptureService(itemDao, dao, deps.em, deps.bus),
    captured: deps.captured,
    writes,
  };
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

  it('captures a pull request CURSOR opened — its result is an object, not a string', async () => {
    // cursor's ACP `execute` answers `{exitCode, stdout, stderr}`, and reading
    // only a string result captured no pull request cursor ever opened.
    const { itemDao } = daos([
      {
        seq: 1,
        kind: 'tool_call',
        payload: JSON.stringify({
          id: 'Shell_0_abc',
          name: '`gh pr create --fill`',
          input: { command: 'gh pr create --fill' },
          toolKind: 'execute',
        }),
      },
      {
        seq: 2,
        kind: 'tool_result',
        payload: JSON.stringify({
          id: 'Shell_0_abc',
          name: null,
          result: { exitCode: 0, stdout: `${CREATED}\n`, stderr: '' },
        }),
      },
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
        (row) => row.number,
      ),
    ).toEqual([87]);
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

describe('PullRequestCaptureService — telling the activity ledger which pull requests a thread opened', () => {
  /** The capture's own clock, frozen: a date that is not the row's can only have come from here. */
  const CAPTURED_AT = '2026-10-09T12:00:00.000Z';
  /** When the result that reported `CREATED` was written. */
  const OPENED_AT = '2026-03-04T05:06:07.000Z';

  beforeEach(() => {
    // The clock alone: the timers the cases below wait on stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(CAPTURED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('announces a pull request the thread opened, at the time of the result that reported it', async () => {
    const { service, captured } = announcing([
      // Dated differently on purpose: the one other row a lookup could land on.
      call(
        1,
        'toolu_1',
        'gh pr create --base main',
        '2026-03-04T05:06:00.000Z',
      ),
      result(2, 'toolu_1', CREATED, OPENED_AT),
    ]);

    await service.sync([chatRun()], em);

    expect(captured).toEqual([
      { runId: 'run-1', pullRequests: [platform87(OPENED_AT)] },
    ]);
  });

  it('dates it by the result row when an older transcript put another row at the same seq', async () => {
    const { service, captured } = announcing([
      // Listed first: the row a lookup by seq alone would return.
      call(2, 'toolu_other', 'pnpm build', '2026-03-04T05:00:00.000Z'),
      call(1, 'toolu_1', 'gh pr create --base main'),
      result(2, 'toolu_1', CREATED, OPENED_AT),
    ]);

    await service.sync([chatRun()], em);

    expect(captured).toEqual([
      { runId: 'run-1', pullRequests: [platform87(OPENED_AT)] },
    ]);
  });

  it('announces each recovered pull request at the time of its own result, oldest first, in one event', async () => {
    const { service, captured } = announcing([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED, '2026-01-10T09:00:00.000Z'),
      call(3, 'toolu_2', 'gh pr create'),
      result(
        4,
        'toolu_2',
        'https://github.com/acme/mobile-app/pull/10',
        '2026-02-11T10:30:00.000Z',
      ),
    ]);

    await service.sync([chatRun()], em);

    expect(captured).toEqual([
      {
        runId: 'run-1',
        pullRequests: [
          platform87('2026-01-10T09:00:00.000Z'),
          {
            owner: 'acme',
            repo: 'mobile-app',
            number: 10,
            url: 'https://github.com/acme/mobile-app/pull/10',
            occurredAt: '2026-02-11T10:30:00.000Z',
          },
        ],
      },
    ]);
  });

  it('announces a pull request once, at its first sighting, when one scan meets it twice', async () => {
    // `gh pr create` on a branch that already has its pull request prints that
    // pull request's URL again.
    const { service, captured } = announcing([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED, OPENED_AT),
      call(3, 'toolu_2', 'gh pr create'),
      result(4, 'toolu_2', CREATED, '2026-03-09T10:00:00.000Z'),
    ]);

    await service.sync([chatRun()], em);

    expect(captured).toEqual([
      { runId: 'run-1', pullRequests: [platform87(OPENED_AT)] },
    ]);
  });

  it('announces nothing when a later capture meets a pull request the run already carries', async () => {
    const rows = [
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED, OPENED_AT),
    ];
    const { service, captured, writes } = announcing(rows);
    const run = chatRun();
    const announced = [
      { runId: 'run-1', pullRequests: [platform87(OPENED_AT)] },
    ];
    await service.sync([run], em);
    expect(captured).toEqual(announced);

    // The branch's pull request is printed again by a later `gh pr create`.
    rows.push(
      call(3, 'toolu_2', 'gh pr create'),
      result(4, 'toolu_2', CREATED, '2026-03-09T10:00:00.000Z'),
    );
    await service.sync([run], em);

    // The second pass did read the new rows ...
    expect(writes[1]?.pullRequestsScannedSeq).toBe(4);
    // ... and had nothing new to say about them.
    expect(captured).toEqual(announced);
  });

  it('announces only the pull request the run did not already carry, whatever seq it was first seen at', async () => {
    const { service, captured } = announcing([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED),
      call(3, 'toolu_2', 'gh pr create'),
      result(
        4,
        'toolu_2',
        'https://github.com/acme/mobile-app/pull/10',
        '2026-02-11T10:30:00.000Z',
      ),
    ]);
    // Carried at a seq this scan will not reproduce, so only the pull
    // request's identity — owner, repo, number — can say it is the same one.
    const carried = JSON.stringify([
      { owner: 'acme', repo: 'platform', number: 87, url: CREATED, seq: 999 },
    ]);

    await service.sync([chatRun({ pullRequests: carried })], em);

    expect(captured).toEqual([
      {
        runId: 'run-1',
        pullRequests: [
          {
            owner: 'acme',
            repo: 'mobile-app',
            number: 10,
            url: 'https://github.com/acme/mobile-app/pull/10',
            occurredAt: '2026-02-11T10:30:00.000Z',
          },
        ],
      },
    ]);
  });

  it.each<[string, Row[]]>([
    [
      'the transcript holds no pull request URL',
      [call(1, 'toolu_1', 'ls'), result(2, 'toolu_1', 'a')],
    ],
    [
      'the thread only read a pull request',
      [
        call(1, 'toolu_1', 'gh pr view 87 --json url'),
        result(2, 'toolu_1', CREATED),
      ],
    ],
  ])('announces nothing when %s', async (_why, rows) => {
    const { service, captured, writes } = announcing(rows);

    await service.sync([chatRun()], em);

    // The capture did read the transcript: its marker moved past both rows.
    expect(writes[0]?.pullRequestsScannedSeq).toBe(2);
    expect(captured).toEqual([]);
  });

  const unreadable: [
    string,
    (runId: string, seqs: readonly number[]) => Promise<Map<number, Date>>,
  ][] = [
    ['the row is gone', async () => new Map<number, Date>()],
    [
      'its time is not a date',
      async (_runId, seqs) =>
        new Map(seqs.map((seq) => [seq, 'not a date' as unknown as Date])),
    ],
    [
      'the read fails',
      async () => {
        throw new Error('disk went away');
      },
    ],
  ];

  it.each(unreadable)(
    'announces it at the time of capture, and warns, when the time of its row cannot be read: %s',
    async (_why, earliestToolResultTimes) => {
      const rows = [
        call(1, 'toolu_1', 'gh pr create'),
        result(2, 'toolu_1', CREATED, OPENED_AT),
      ];
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const { service, captured } = announcing(rows, {
        ...daos(rows).itemDao,
        earliestToolResultTimes,
      } as unknown as ItemDao);
      const run = chatRun();

      await service.sync([run], em);

      expect(captured).toEqual([
        { runId: 'run-1', pullRequests: [platform87(CAPTURED_AT)] },
      ]);
      // An unreadable date costs the event its date, never the run its pull
      // request.
      expect(
        readRunPullRequests(run.pullRequests).map((row) => row.number),
      ).toEqual([87]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('acme/platform#87');
    },
  );

  it('announces only once the run row holds the pull requests', async () => {
    const order: string[] = [];
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED),
    ]);
    const dao = {
      updateWithoutActivity: async () => {
        // A write takes longer than a tick, so an announce that did not wait
        // for it would land first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        order.push('row written');
        return 1;
      },
    } as unknown as RunDao;
    const bus = {
      publishRunStatus: () => undefined,
      publishPullRequestsCaptured: () => {
        order.push('pull requests announced');
      },
    } as unknown as AgentEventBus;

    await new PullRequestCaptureService(itemDao, dao, em, bus).sync(
      [chatRun()],
      em,
    );

    expect(order).toEqual(['row written', 'pull requests announced']);
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
      updateWithoutActivity: async (_id: string, data: Partial<Run>) => {
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

  it('ANNOUNCES a pull request the LISTING captured before the turn ended', async () => {
    // THE REPORTED DEFECT, second form. Run `4f7ae5fa`: the Engineer's `gh pr
    // create` landed at 14:02:32Z, a `GET /v1/workflows/runs` at 14:14:38Z
    // captured it, and its turn ended at 14:24:16Z. Only the turn-end pass
    // announced, and by then the marker had moved, so it found nothing new —
    // no window was ever told, and the shelf showed no chip under a manager
    // reading "It's on draft PR #6490".
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --draft'),
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

    await service.sync([run], em);
    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: 'engineer', kind: 'turn_complete' },
    });
    await settled();

    // Once, from the listing — the turn end that follows has nothing new.
    expect(deps.published).toEqual([
      {
        runId: 'run-1',
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

  it('captures a WORKFLOW node’s turn, exactly as a chat’s', async () => {
    // REPORTED as a shelf with no chip over a transcript reading "Draft PR
    // #5303 is open". Every row of a workflow run carries a node id, and this
    // subscriber required `nodeId === null` — so it never fired for one, while
    // the other trigger (the chat listing) filters `workflowId: null`. Two
    // gates, and a workflow's pull requests were captured on no path at all.
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
      item: { nodeId: 'engineer', kind: 'turn_complete' },
    });
    await settled();

    expect(counts.max).toBe(1);
    expect(readRunPullRequests(run.pullRequests)).toHaveLength(1);
    expect(deps.published).toEqual([
      {
        runId: 'run-1',
        status: null,
        pullRequests: [
          { owner: 'acme', repo: 'platform', number: 87, url: CREATED, seq: 2 },
        ],
      },
    ]);
  });

  it('still ignores a mid-turn row, whoever wrote it', async () => {
    // The bound that survives: one pass per TURN, never one per tool call.
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
      item: { nodeId: null, kind: 'tool_call' },
    });
    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: 'engineer', kind: 'tool_result' },
    });
    await settled();

    expect(deps.published).toEqual([]);
    expect(counts.max).toBe(0);
  });

  it('tells the activity ledger about a pull request the turn ending found', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --base main'),
      result(2, 'toolu_1', CREATED, '2026-03-04T05:06:07.000Z'),
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

    expect(deps.captured).toEqual([
      {
        runId: 'run-1',
        pullRequests: [platform87('2026-03-04T05:06:07.000Z')],
      },
    ]);
  });
});
