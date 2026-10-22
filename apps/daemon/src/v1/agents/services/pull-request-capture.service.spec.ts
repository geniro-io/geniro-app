import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type {
  SessionPullRequest,
  SessionPullRequestsInput,
} from '../adapters/adapter.types';
import type {
  PullRequestsCapturedEvent,
  SessionTranscriptTarget,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import {
  PULL_REQUEST_SCAN_VERSION,
  readRunPullRequests,
} from '../utils/pull-request-capture';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import type { ItemSeqAllocator } from './item-seq.allocator';
import { PullRequestCaptureService } from './pull-request-capture.service';
import type { SessionTranscriptsService } from './session-transcripts.service';

// The boot sweep's pause between batches, held until a case releases it — a
// real 50 ms timer would race the assertion on a loaded machine.
const pauses = vi.hoisted(() => ({
  held: false,
  release: [] as (() => void)[],
}));
vi.mock('node:timers/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...real,
    setTimeout: (ms?: number) =>
      pauses.held
        ? new Promise<void>((resolve) => pauses.release.push(resolve))
        : real.setTimeout(ms),
  };
});

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
  const counts = {
    max: 0,
    candidates: 0,
    placed: 0,
    /** Each `(afterSeq, throughSeq]` the thread was read over for a pull request. */
    named: [] as [number, number][],
  };
  const itemDao = {
    maxSeq: async () => {
      counts.max += 1;
      return rows.reduce((top, row) => Math.max(top, row.seq), -1);
    },
    pullRequestCandidates: async (
      _runId: string,
      afterSeq: number,
      _em?: unknown,
      throughSeq = Number.POSITIVE_INFINITY,
    ) => {
      counts.candidates += 1;
      return rows.filter(
        (row) =>
          row.kind === 'tool_result' &&
          row.seq > afterSeq &&
          row.seq <= throughSeq &&
          row.payload.includes('/pull/'),
      ) as unknown as Pick<Item, 'seq' | 'payload'>[];
    },
    // Exact id, seq order and the optional range, as the real DAO answers —
    // pinned against it in item.dao.spec.ts.
    rowsByPayloadId: async (
      _runId: string,
      kinds: readonly string[],
      ids: readonly string[],
      range?: { before: number } | { after: number },
    ) =>
      rows.filter((row) => {
        if (
          range !== undefined &&
          ('before' in range ? row.seq >= range.before : row.seq <= range.after)
        ) {
          return false;
        }
        try {
          return (
            kinds.includes(row.kind) &&
            ids.includes((JSON.parse(row.payload) as { id: string }).id)
          );
        } catch {
          return false;
        }
      }) as unknown as Item[],
    // Where a CLI's own record lands: the newest tool result written at or
    // before its time, else the oldest after — the real DAO's answer, pinned in
    // item.dao.spec.ts.
    toolResultSeqAt: async (_runId: string, at: Date) => {
      counts.placed += 1;
      const results = rows.filter((row) => row.kind === 'tool_result');
      const before = results
        .filter((row) => (row.createdAt ?? WRITTEN_AT) <= at)
        .at(-1);
      return (
        before?.seq ??
        results.find((row) => (row.createdAt ?? WRITTEN_AT) > at)?.seq ??
        null
      );
    },
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
    // Every row in `(afterSeq, throughSeq]` as a candidate: the real DAO only
    // narrows them (pinned in item.dao.spec.ts), and the service's own
    // `textNamesPullRequest` decides, so it runs here as in production.
    pullRequestNamingCandidates: async (
      _runId: string,
      _pullRequest: unknown,
      afterSeq: number,
      throughSeq: number,
    ) => {
      counts.named.push([afterSeq, throughSeq]);
      return rows
        .filter((row) => row.seq > afterSeq && row.seq <= throughSeq)
        .map((row) => row.payload);
    },
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
    pullRequestsScanVersion: PULL_REQUEST_SCAN_VERSION,
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
  deleted: ((runId: string) => void)[];
} {
  const published: unknown[] = [];
  const captured: PullRequestsCapturedEvent[] = [];
  const listeners: ((event: {
    runId: string;
    item: { nodeId: string | null; kind: string };
  }) => void)[] = [];
  const deleted: ((runId: string) => void)[] = [];
  const bus = {
    all: () => ({
      subscribe: (fn: (event: never) => void) => {
        listeners.push(fn as never);
        return { unsubscribe: () => undefined };
      },
    }),
    allDeleted: () => ({
      subscribe: (fn: (runId: string) => void) => {
        deleted.push(fn);
        return { unsubscribe: () => undefined };
      },
    }),
    publishRunStatus: (status: unknown) => published.push(status),
    publishPullRequestsCaptured: (event: PullRequestsCapturedEvent) =>
      captured.push(event),
  } as unknown as AgentEventBus;
  return { em: em, bus, published, captured, listeners, deleted };
}

/**
 * The conversations a run held and what each one's CLI record names, as the
 * two collaborators the service reads them through; `asked` is every
 * conversation the adapter was asked about.
 */
function sessionRecords(
  records: SessionPullRequest[],
  {
    collect = async () => [
      { agentKind: AgentKind.Claude, sessionId: 'session-1', configDir: '/p' },
    ],
    failing,
  }: {
    collect?: () => Promise<SessionTranscriptTarget[]>;
    failing?: string;
  } = {},
) {
  const asked: SessionPullRequestsInput[] = [];
  const sessionTranscripts = {
    collect,
  } as unknown as SessionTranscriptsService;
  // Only claude keeps such a record; every other CLI answers the base's empty.
  const adapters = {
    for: (kind: AgentKind) => ({
      readSessionPullRequests: async (input: SessionPullRequestsInput) => {
        if (kind !== AgentKind.Claude) {
          return [];
        }
        asked.push(input);
        if (input.sessionId === failing) {
          throw new Error('record unreadable');
        }
        return records;
      },
    }),
  } as unknown as AgentAdapterRegistry;
  return { deps: [sessionTranscripts, adapters, allWritten] as const, asked };
}

/** A seq allocator with nothing reserved and unwritten. */
const allWritten = {
  writtenThrough: (_runId: string, maxSeq: number) => maxSeq,
} as unknown as ItemSeqAllocator;

/** `acme/platform#<number>` as a conversation's record names it. */
function touchedRecord(number: number, at: string | null): SessionPullRequest {
  return {
    owner: 'acme',
    repo: 'platform',
    number,
    url: `https://github.com/acme/platform/pull/${number}`,
    at: at === null ? null : new Date(at),
  };
}

/** A run whose conversations' records name no pull request. */
function noSessionRecords() {
  return sessionRecords([]).deps;
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
    service: new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    ),
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
      ...noSessionRecords(),
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
      ...noSessionRecords(),
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
      ...noSessionRecords(),
    ).sync([chatRun()], em);

    expect(writes[0]?.pullRequests).toBeNull();
  });

  it('captures a pull request whose URL the command captured and printed after a label', async () => {
    // `gh pr create`'s stdout kept in a variable and echoed after a label.
    const { itemDao } = daos([
      call(
        1,
        'toolu_1',
        'cd "$W"; URL=$(gh pr create --draft --base main --body-file "$S/pr-body.md"); echo "create rc=$? url=$URL"; gh pr view "$URL" --json number,url',
      ),
      result(
        2,
        'toolu_1',
        `create rc=0 url=${CREATED}\n{\n "number": 87,\n "url": "${CREATED}"\n}`,
      ),
      call(3, 'toolu_2', 'echo "PR: $(gh pr create --fill --repo acme/api)"'),
      result(4, 'toolu_2', 'PR: https://github.com/acme/api/pull/12'),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    ).sync([chatRun()], em);

    expect(
      readRunPullRequests(writes[0]?.pullRequests ?? null).map((row) => ({
        repo: row.repo,
        number: row.number,
        url: row.url,
      })),
    ).toEqual([
      { repo: 'platform', number: 87, url: CREATED },
      { repo: 'api', number: 12, url: 'https://github.com/acme/api/pull/12' },
    ]);
  });

  it('keeps a pull request a conversation only touched apart from the opened ones, at the tool result its time falls on', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr checkout 6841', '2026-10-13T20:36:00.000Z'),
      result(2, 'toolu_1', 'Switched to branch', '2026-10-13T20:36:40.000Z'),
      call(3, 'toolu_2', 'ls', '2026-10-13T20:38:00.000Z'),
      result(4, 'toolu_2', 'a', '2026-10-13T20:38:01.000Z'),
    ]);
    const { dao, writes } = runDao();
    const records = sessionRecords([
      touchedRecord(6841, '2026-10-13T20:36:47.487Z'),
    ]);

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...records.deps,
    ).sync([chatRun()], em);

    expect(records.asked).toEqual([
      { sessionId: 'session-1', configDir: '/p' },
    ]);
    expect(writes[0]?.pullRequests).toBeNull();
    expect(readRunPullRequests(writes[0]?.touchedPullRequests ?? null)).toEqual(
      [
        {
          owner: 'acme',
          repo: 'platform',
          number: 6841,
          url: 'https://github.com/acme/platform/pull/6841',
          seq: 2,
        },
      ],
    );
  });

  it('places a pull request the records name twice at its EARLIEST record, in either order', async () => {
    const early = touchedRecord(87, '2026-10-13T20:36:41.000Z');
    const late = touchedRecord(87, '2026-10-13T20:50:02.000Z');
    // Oldest first as one CLI record holds them; newest first across sessions.
    for (const records of [
      [early, late],
      [late, early],
    ]) {
      const { itemDao } = daos([
        call(1, 'toolu_1', 'gh pr checkout 87', '2026-10-13T20:36:00.000Z'),
        result(2, 'toolu_1', 'Switched to branch', '2026-10-13T20:36:40.000Z'),
        call(3, 'toolu_2', 'gh pr comment 87', '2026-10-13T20:50:00.000Z'),
        result(4, 'toolu_2', 'ok', '2026-10-13T20:50:01.000Z'),
      ]);
      const { dao, writes } = runDao();

      await new PullRequestCaptureService(
        itemDao,
        dao,
        settleDeps().em,
        settleDeps().bus,
        ...sessionRecords(records).deps,
      ).sync([chatRun()], em);

      expect(
        readRunPullRequests(writes[0]?.touchedPullRequests ?? null).map(
          (row) => row.seq,
        ),
      ).toEqual([2]);
    }
  });

  it('places a record with no time at the newest tool result, and a timed record of the same pull request wins over it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T21:00:00.000Z'));
    try {
      const { itemDao } = daos([
        call(1, 'toolu_1', 'gh pr checkout 7', '2026-10-13T20:36:00.000Z'),
        result(2, 'toolu_1', 'ok', '2026-10-13T20:36:40.000Z'),
        call(3, 'toolu_2', 'gh pr checkout 8', '2026-10-13T20:38:00.000Z'),
        result(4, 'toolu_2', 'a', '2026-10-13T20:38:01.000Z'),
      ]);
      const { dao, writes } = runDao();

      await new PullRequestCaptureService(
        itemDao,
        dao,
        settleDeps().em,
        settleDeps().bus,
        ...sessionRecords([
          touchedRecord(7, '2026-10-13T20:36:41.000Z'),
          touchedRecord(7, null),
          touchedRecord(8, null),
        ]).deps,
      ).sync([chatRun()], em);
      const untimedFirst = runDao();
      await new PullRequestCaptureService(
        itemDao,
        untimedFirst.dao,
        settleDeps().em,
        settleDeps().bus,
        ...sessionRecords([
          touchedRecord(7, null),
          touchedRecord(7, '2026-10-13T20:36:41.000Z'),
        ]).deps,
      ).sync([chatRun()], em);

      expect(
        readRunPullRequests(writes[0]?.touchedPullRequests ?? null).map(
          (row) => `#${row.number}@${row.seq}`,
        ),
      ).toEqual(['#7@2', '#8@4']);
      expect(
        readRunPullRequests(
          untimedFirst.writes[0]?.touchedPullRequests ?? null,
        ).map((row) => `#${row.number}@${row.seq}`),
      ).toEqual(['#7@2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a record of a run that has no tool result to place it at', async () => {
    const { itemDao } = daos([call(1, 'toolu_1', 'gh pr checkout 7')]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...sessionRecords([touchedRecord(7, '2026-10-13T20:36:41.000Z')]).deps,
    ).sync([chatRun()], em);

    expect(writes[0]?.pullRequestsScannedSeq).toBe(1);
    expect(writes[0]?.touchedPullRequests).toBeNull();
  });

  it('asks each conversation through its own CLI and keeps the others when one cannot be read', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr checkout 7', '2026-10-13T20:36:00.000Z'),
      result(2, 'toolu_1', 'ok', '2026-10-13T20:36:40.000Z'),
    ]);
    const { dao, writes } = runDao();
    const records = sessionRecords(
      [touchedRecord(7, '2026-10-13T20:36:41.000Z')],
      {
        collect: async () => [
          { agentKind: AgentKind.Claude, sessionId: 'broken', configDir: null },
          { agentKind: AgentKind.Codex, sessionId: 'codex-1', configDir: null },
          {
            agentKind: AgentKind.Claude,
            sessionId: 'session-1',
            configDir: '/p',
          },
        ],
        failing: 'broken',
      },
    );

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...records.deps,
    ).sync([chatRun()], em);

    expect(records.asked.map((input) => input.sessionId)).toEqual([
      'broken',
      'session-1',
    ]);
    expect(
      readRunPullRequests(writes[0]?.touchedPullRequests ?? null).map(
        (row) => row.number,
      ),
    ).toEqual([7]);
  });

  it('shows touched pull requests beside the opened ones, and tells the ledger only about the opened', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --fill', '2026-10-13T20:36:00.000Z'),
      result(2, 'toolu_1', CREATED, '2026-10-13T20:36:40.000Z'),
      call(3, 'toolu_2', 'gh pr checkout 6841', '2026-10-13T20:38:00.000Z'),
      result(4, 'toolu_2', 'ok', '2026-10-13T20:38:01.000Z'),
    ]);
    const { dao } = runDao();
    const deps = settleDeps();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...sessionRecords([touchedRecord(6841, '2026-10-13T20:38:02.000Z')]).deps,
    ).sync([chatRun()], em);

    expect(deps.published).toEqual([
      {
        runId: 'run-1',
        status: null,
        pullRequests: [
          {
            owner: 'acme',
            repo: 'platform',
            number: 87,
            url: CREATED,
            seq: 2,
            opened: true,
          },
          {
            owner: 'acme',
            repo: 'platform',
            number: 6841,
            url: 'https://github.com/acme/platform/pull/6841',
            seq: 4,
            opened: false,
          },
        ],
      },
    ]);
    expect(
      deps.captured.flatMap((event) =>
        event.pullRequests.map((row) => row.number),
      ),
    ).toEqual([87]);
  });

  it('announces a run whose only pull request is one it touched', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr checkout 6841', '2026-10-13T20:36:00.000Z'),
      result(2, 'toolu_1', 'ok', '2026-10-13T20:36:40.000Z'),
    ]);
    const { dao } = runDao();
    const deps = settleDeps();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...sessionRecords([touchedRecord(6841, '2026-10-13T20:36:47.000Z')]).deps,
    ).sync([chatRun()], em);

    expect(deps.published).toEqual([
      {
        runId: 'run-1',
        status: null,
        pullRequests: [
          {
            owner: 'acme',
            repo: 'platform',
            number: 6841,
            url: 'https://github.com/acme/platform/pull/6841',
            seq: 2,
            opened: false,
          },
        ],
      },
    ]);
    expect(deps.captured).toEqual([]);
  });

  it('announces a newly touched pull request beside the opened one the run already carries', async () => {
    const { itemDao } = daos([
      call(3, 'toolu_2', 'gh pr checkout 6841', '2026-10-13T20:38:00.000Z'),
      result(4, 'toolu_2', 'ok', '2026-10-13T20:38:01.000Z'),
    ]);
    const { dao } = runDao();
    const deps = settleDeps();
    const opened = {
      owner: 'acme',
      repo: 'platform',
      number: 87,
      url: CREATED,
      seq: 2,
    };

    await new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...sessionRecords([touchedRecord(6841, '2026-10-13T20:38:02.000Z')]).deps,
    ).sync(
      [
        chatRun({
          pullRequests: JSON.stringify([opened]),
          pullRequestsScannedSeq: 2,
        }),
      ],
      em,
    );

    expect(
      deps.published
        .flatMap(
          (event) =>
            (event as { pullRequests: { number: number }[] }).pullRequests,
        )
        .map((row) => row.number),
    ).toEqual([87, 6841]);
  });

  it('does not place again a touched pull request the run already carries', async () => {
    const { itemDao, counts } = daos([
      call(3, 'toolu_2', 'ls', '2026-10-13T20:38:00.000Z'),
      result(4, 'toolu_2', 'a', '2026-10-13T20:38:01.000Z'),
    ]);
    const { dao, writes } = runDao();
    const carried = {
      owner: 'acme',
      repo: 'platform',
      number: 6841,
      url: 'https://github.com/acme/platform/pull/6841',
      seq: 2,
    };

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...sessionRecords([touchedRecord(6841, '2026-10-13T20:38:02.000Z')]).deps,
    ).sync(
      [
        chatRun({
          touchedPullRequests: JSON.stringify([carried]),
          pullRequestsScannedSeq: 2,
        }),
      ],
      em,
    );

    expect(counts.placed).toBe(0);
    expect(readRunPullRequests(writes[0]?.touchedPullRequests ?? null)).toEqual(
      [carried],
    );
  });

  it('keeps only the touched pull requests the thread itself names, never one claude read off the branch its folder had checked out', async () => {
    // A workflow node pushes a worktree's branch with `git -C`, from a shared
    // checkout that sits on ANOTHER pull request's head branch. claude 2.1.295
    // answers every push with `gh pr view --json url` in its own folder, so its
    // record names that other pull request (#7207) — which nothing in this
    // thread mentions. The pull request the thread was sent to review (#6502)
    // is named in its transcript and stays.
    const { itemDao } = daos([
      result(
        1,
        'toolu_0',
        'Review PR https://github.com/acme/platform/pull/6502 and give me visuals',
        '2026-10-22T09:50:00.000Z',
      ),
      call(
        2,
        'toolu_1',
        'git -C "$WT" push origin "$REFSPEC"',
        '2026-10-22T09:54:00.000Z',
      ),
      result(
        3,
        'toolu_1',
        'To github.com:acme/platform.git\n * [new branch]  assets/pr-6502',
        '2026-10-22T09:54:05.000Z',
      ),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...sessionRecords([
        touchedRecord(6502, '2026-10-22T09:51:00.000Z'),
        touchedRecord(7207, '2026-10-22T09:54:06.358Z'),
      ]).deps,
    ).sync([chatRun()], em);

    expect(
      readRunPullRequests(writes[0]?.touchedPullRequests ?? null).map(
        (row) => row.number,
      ),
    ).toEqual([6502]);
  });

  it('reads the thread again for a record it left unnamed only over the rows written since, and keeps it once they name it', async () => {
    const rows = [
      call(1, 'toolu_1', 'git -C "$WT" push', '2026-10-22T09:54:00.000Z'),
      result(2, 'toolu_1', 'Everything up-to-date', '2026-10-22T09:54:05.000Z'),
    ];
    const { itemDao, counts } = daos(rows);
    const { dao, writes } = runDao();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...sessionRecords([touchedRecord(7207, '2026-10-22T09:54:06.000Z')]).deps,
    );
    const run = chatRun();

    await service.sync([run], em);
    rows.push(
      call(
        3,
        'toolu_2',
        'gh pr view 7207 --json url',
        '2026-10-22T10:00:00.000Z',
      ),
      result(4, 'toolu_2', 'ok', '2026-10-22T10:00:01.000Z'),
    );
    await service.sync([run], em);

    expect(writes[0]?.touchedPullRequests).toBeNull();
    expect(counts.named).toEqual([
      [-1, 2],
      [2, 4],
    ]);
    expect(
      readRunPullRequests(writes[1]?.touchedPullRequests ?? null).map(
        (row) => row.number,
      ),
    ).toEqual([7207]);
  });

  it('keeps a touched pull request it carried from an older rule when the thread names it', async () => {
    const { itemDao } = daos([
      call(
        1,
        'toolu_1',
        'gh pr view 7207 --json url',
        '2026-10-22T09:54:00.000Z',
      ),
      result(2, 'toolu_1', 'ok', '2026-10-22T09:54:05.000Z'),
    ]);
    const { dao, writes } = runDao();
    const carried = {
      owner: 'acme',
      repo: 'platform',
      number: 7207,
      url: 'https://github.com/acme/platform/pull/7207',
      seq: 2,
    };
    const run = chatRun({
      pullRequestsScannedSeq: 2,
      pullRequestsScanVersion: PULL_REQUEST_SCAN_VERSION - 1,
      touchedPullRequests: JSON.stringify([carried]),
    });
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () =>
          run.pullRequestsScanVersion === PULL_REQUEST_SCAN_VERSION
            ? []
            : [run],
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );

    await service.rescanOutdatedQuietly();

    expect(readRunPullRequests(writes[0]?.touchedPullRequests ?? null)).toEqual(
      [carried],
    );
  });

  it('announces the emptied list when a rescan drops the only pull request a run showed', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'git -C "$WT" push', '2026-10-22T09:54:00.000Z'),
      result(2, 'toolu_1', 'Everything up-to-date', '2026-10-22T09:54:05.000Z'),
    ]);
    const { dao } = runDao();
    const deps = settleDeps();
    const run = chatRun({
      pullRequestsScannedSeq: 2,
      pullRequestsScanVersion: PULL_REQUEST_SCAN_VERSION - 1,
      touchedPullRequests: JSON.stringify([
        {
          owner: 'acme',
          repo: 'platform',
          number: 7207,
          url: 'https://github.com/acme/platform/pull/7207',
          seq: 2,
        },
      ]),
    });
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () =>
          run.pullRequestsScanVersion === PULL_REQUEST_SCAN_VERSION
            ? []
            : [run],
      }),
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    );

    await service.rescanOutdatedQuietly();

    expect(deps.published).toEqual([
      { runId: 'run-1', status: null, pullRequests: [] },
    ]);
  });

  it('drops a touched pull request it carried from an older rule when the thread never names it', async () => {
    // The rows a rescan finds already stored: records taken before the thread
    // was checked for naming them must not outlive the rule that rejects them.
    const { itemDao } = daos([
      call(1, 'toolu_1', 'git -C "$WT" push', '2026-10-22T09:54:00.000Z'),
      result(2, 'toolu_1', 'Everything up-to-date', '2026-10-22T09:54:05.000Z'),
    ]);
    const { dao, writes } = runDao();
    const carried = {
      owner: 'acme',
      repo: 'platform',
      number: 7207,
      url: 'https://github.com/acme/platform/pull/7207',
      seq: 2,
    };
    const run = chatRun({
      pullRequestsScannedSeq: 2,
      pullRequestsScanVersion: PULL_REQUEST_SCAN_VERSION - 1,
      touchedPullRequests: JSON.stringify([carried]),
    });
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () =>
          run.pullRequestsScanVersion === PULL_REQUEST_SCAN_VERSION
            ? []
            : [run],
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );

    await service.rescanOutdatedQuietly();

    expect(writes[0]?.touchedPullRequests).toBeNull();
  });

  it('still captures the transcript when the conversations cannot be listed', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...sessionRecords([], {
        collect: async () => {
          throw new Error('node_state unreadable');
        },
      }).deps,
    ).sync([chatRun()], em);

    expect(
      readRunPullRequests(writes[0]?.pullRequests ?? null).map(
        (row) => row.number,
      ),
    ).toEqual([87]);
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
      ...noSessionRecords(),
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
      ...noSessionRecords(),
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
      ...noSessionRecords(),
    ).sync([chatRun({ pullRequestsScannedSeq: 2 })], em);

    expect(counts.max).toBe(1);
    expect(counts.candidates).toBe(0);
    expect(writes).toEqual([]);
  });

  it('re-reads a run scanned under an older capture rule from the start on the boot sweep, once', async () => {
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'URL=$(gh pr create --fill); echo "url=$URL"'),
      result(2, 'toolu_1', `url=${CREATED}`),
    ]);
    const { dao, writes } = runDao();
    const carried = {
      owner: 'acme',
      repo: 'api',
      number: 5,
      url: 'https://github.com/acme/api/pull/5',
      seq: 1,
    };
    const run = chatRun({
      pullRequestsScannedSeq: 2,
      pullRequestsScanVersion: null,
      pullRequests: JSON.stringify([carried]),
    });
    const outdated = vi.fn(async () =>
      run.pullRequestsScanVersion === PULL_REQUEST_SCAN_VERSION ? [] : [run],
    );
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, { listOutdatedPullRequestScans: outdated }),
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    );

    await service.rescanOutdatedQuietly();
    await service.rescanOutdatedQuietly();

    expect(outdated).toHaveBeenCalledWith(PULL_REQUEST_SCAN_VERSION, em);
    expect(counts.candidates).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.pullRequestsScanVersion).toBe(PULL_REQUEST_SCAN_VERSION);
    expect(
      readRunPullRequests(writes[0]?.pullRequests ?? null).map(
        (row) => `${row.repo}#${row.number}`,
      ),
    ).toEqual(['api#5', 'platform#87']);
    expect(deps.published).toHaveLength(1);
  });

  it('never re-reads an outdated run from the start on a listing', async () => {
    // A re-read announces what it finds; only the boot sweep and a turn's end
    // may re-read, never a listing.
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();
    const deps = settleDeps();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    ).sync(
      [chatRun({ pullRequestsScannedSeq: 2, pullRequestsScanVersion: 1 })],
      em,
    );

    expect(counts.candidates).toBe(0);
    expect(writes).toEqual([]);
    expect(deps.published).toEqual([]);
  });

  it('carries an outdated run on from its marker on a listing, keeping its old rule', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'ls'),
      result(2, 'toolu_1', 'a'),
      call(3, 'toolu_2', 'gh pr create --fill'),
      result(4, 'toolu_2', CREATED),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    ).sync(
      [chatRun({ pullRequestsScannedSeq: 2, pullRequestsScanVersion: 1 })],
      em,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.pullRequestsScannedSeq).toBe(4);
    expect(writes[0]?.pullRequestsScanVersion).toBe(1);
    expect(readRunPullRequests(writes[0]?.pullRequests ?? null)).toHaveLength(
      1,
    );
  });

  it('announces a run once when listings holding the same stale row reach it together or later', async () => {
    // Each request reads its rows when it starts, so an overlapping listing
    // holds a copy another pass has already moved on.
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    );
    await Promise.all([
      service.sync([chatRun()], em),
      service.sync([chatRun()], em),
    ]);
    const later = chatRun();
    await service.sync([later], em);

    expect(deps.published).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(counts.candidates).toBe(1);
    // A later listing's stale copy projects what the first one captured.
    expect(readRunPullRequests(later.pullRequests)).toHaveLength(1);
  });

  it('remembers nothing for a run deleted while its pass was writing', async () => {
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    let landWrite: () => void = () => undefined;
    const dao = {
      updateWithoutActivity: () =>
        new Promise<number>((resolve) => {
          landWrite = () => resolve(1);
        }),
    } as unknown as RunDao;
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    );
    service.onModuleInit();

    const pass = service.sync([chatRun()], em);
    await new Promise((resolve) => setImmediate(resolve));
    deps.deleted[0]?.('run-1');
    landWrite();
    await pass;
    const later = service.sync([chatRun()], em);
    await new Promise((resolve) => setImmediate(resolve));
    landWrite();
    await later;

    expect(counts.candidates).toBe(2);
  });

  it('forgets what it wrote for a run once the run is deleted', async () => {
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao } = runDao();
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    );
    service.onModuleInit();
    await service.sync([chatRun()], em);

    deps.deleted[0]?.('run-1');
    // A stale copy is read on its own terms again: nothing remembered stands in.
    await service.sync([chatRun()], em);

    expect(counts.candidates).toBe(2);
  });

  it('pauses between batches of the boot sweep', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () =>
          Array.from({ length: 6 }, (_, i) =>
            chatRun({ id: `run-${i}`, pullRequestsScanVersion: null }),
          ),
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );
    pauses.held = true;
    try {
      const done = service.rescanOutdatedQuietly();
      await new Promise((resolve) => setImmediate(resolve));
      expect(writes).toHaveLength(5);
      expect(pauses.release).toHaveLength(1);

      pauses.release[0]?.();
      await done;
      expect(writes).toHaveLength(6);
    } finally {
      pauses.held = false;
      pauses.release.length = 0;
    }
  });

  it('never moves its marker past a result whose row is reserved but not yet written', async () => {
    // The `gh pr create` result at seq 2 is reserved while a later row (3) is
    // already on disk; a marker at 3 would leave seq 2 unread for good.
    const rows = [
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(3, 'toolu_9', 'done'),
    ];
    const { itemDao } = daos(rows);
    const { dao, writes } = runDao();
    let reservedAt2 = true;
    const seqs = {
      writtenThrough: (_runId: string, maxSeq: number) =>
        reservedAt2 ? Math.min(maxSeq, 1) : maxSeq,
    } as unknown as ItemSeqAllocator;
    const [sessionTranscripts, adapters] = sessionRecords([]).deps;
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      sessionTranscripts,
      adapters,
      seqs,
    );
    const run = chatRun();

    await service.sync([run], em);
    rows.push(result(2, 'toolu_1', CREATED));
    reservedAt2 = false;
    await service.sync([run], em);

    expect(writes[0]?.pullRequestsScannedSeq).toBe(1);
    expect(readRunPullRequests(run.pullRequests)).toHaveLength(1);
  });

  it('pairs each result with its own call by exact id, never one whose id merely contains it', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr view 87 --web'),
      result(2, 'toolu_1', CREATED),
      call(3, 'toolu_10', 'gh pr create --fill'),
      result(4, 'toolu_10', 'https://github.com/acme/api/pull/9'),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    ).sync([chatRun()], em);

    expect(
      readRunPullRequests(writes[0]?.pullRequests ?? null).map(
        (row) => `${row.repo}#${row.number}`,
      ),
    ).toEqual(['api#9']);
  });

  it('captures a result whose call was written before the marker', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    ).sync([chatRun({ pullRequestsScannedSeq: 1 })], em);

    expect(readRunPullRequests(writes[0]?.pullRequests ?? null)).toHaveLength(
      1,
    );
  });

  it('reads a long history in windows, and misses nothing across their edges', async () => {
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      // The last seq of the first window, and the first of the second.
      result(1_999, 'toolu_1', CREATED),
      call(1_998, 'toolu_2', 'gh pr create --fill'),
      result(2_000, 'toolu_2', 'https://github.com/acme/api/pull/9'),
      call(4_500, 'toolu_3', 'gh pr create --fill'),
      result(4_501, 'toolu_3', 'https://github.com/acme/web/pull/3'),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(
      itemDao,
      dao,
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    ).sync([chatRun()], em);

    expect(counts.candidates).toBe(3);
    expect(
      readRunPullRequests(writes[0]?.pullRequests ?? null).map(
        (row) => `${row.repo}#${row.number}`,
      ),
    ).toEqual(['platform#87', 'api#9', 'web#3']);
  });

  it('marks a run with nothing to read as read under the current rule', async () => {
    const { itemDao } = daos([]);
    const { dao, writes } = runDao();
    const run = chatRun({
      pullRequestsScanVersion: null,
      touchedPullRequests: null,
    });
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () =>
          run.pullRequestsScanVersion === PULL_REQUEST_SCAN_VERSION
            ? []
            : [run],
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );

    await service.rescanOutdatedQuietly();
    await service.rescanOutdatedQuietly();

    expect(writes).toEqual([
      {
        pullRequests: null,
        touchedPullRequests: null,
        pullRequestsScannedSeq: -1,
        pullRequestsScanVersion: PULL_REQUEST_SCAN_VERSION,
      },
    ]);
  });

  it('never throws out of the boot sweep when the outdated runs cannot be listed', async () => {
    const { itemDao } = daos([]);
    const { dao } = runDao();
    const service = new PullRequestCaptureService(
      itemDao,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () => {
          throw new Error('database is locked');
        },
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );

    await expect(service.rescanOutdatedQuietly()).resolves.toBeUndefined();
  });

  it('lets a listing answer at once while a slow pass over the same run is in flight', async () => {
    const base = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]).itemDao;
    let release: () => void = () => undefined;
    const slow = {
      ...base,
      pullRequestCandidates: (
        ...args: Parameters<ItemDao['pullRequestCandidates']>
      ) =>
        new Promise((resolve) => {
          release = () => resolve(base.pullRequestCandidates(...args));
        }),
    } as unknown as ItemDao;
    const { dao } = runDao();
    const service = new PullRequestCaptureService(
      slow,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () => [
          chatRun({ pullRequestsScanVersion: null }),
        ],
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );

    const sweep = service.rescanOutdatedQuietly();
    await new Promise((resolve) => setImmediate(resolve));
    const first = await Promise.race([
      service.sync([chatRun()], em).then(() => 'listed'),
      new Promise((resolve) => setImmediate(() => resolve('waited'))),
    ]);

    expect(first).toBe('listed');
    release();
    await sweep;
  });

  it('keeps sweeping the other outdated runs when one cannot be re-read', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'gh pr create --fill'),
      result(2, 'toolu_1', CREATED),
    ]);
    const maxSeq = itemDao.maxSeq;
    const flaky = {
      ...itemDao,
      maxSeq: async (runId: string) => {
        if (runId === 'run-1') {
          throw new Error('disk went away');
        }
        return maxSeq(runId);
      },
    } as unknown as ItemDao;
    const { dao, writes } = runDao();
    const service = new PullRequestCaptureService(
      flaky,
      Object.assign(dao, {
        listOutdatedPullRequestScans: async () => [
          chatRun({ pullRequestsScanVersion: null }),
          chatRun({ id: 'run-2', pullRequestsScanVersion: null }),
        ],
      }),
      settleDeps().em,
      settleDeps().bus,
      ...noSessionRecords(),
    );

    await expect(service.rescanOutdatedQuietly()).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.pullRequestsScanVersion).toBe(PULL_REQUEST_SCAN_VERSION);
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
      ...noSessionRecords(),
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

    await new PullRequestCaptureService(
      itemDao,
      dao,
      em,
      bus,
      ...noSessionRecords(),
    ).sync([chatRun()], em);

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
      ...noSessionRecords(),
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
          {
            owner: 'acme',
            repo: 'platform',
            number: 87,
            url: CREATED,
            seq: 2,
            opened: true,
          },
        ],
      },
    ]);
  });

  it('re-reads its run from the start when the run was scanned under an older rule', async () => {
    // A listing never re-reads such runs; a turn's end is the run's own pass
    // and does, like the boot sweep.
    const { itemDao } = daos([
      call(1, 'toolu_1', 'URL=$(gh pr create --fill); echo "url=$URL"'),
      result(2, 'toolu_1', `url=${CREATED}`),
    ]);
    const run = chatRun({
      pullRequestsScannedSeq: 2,
      pullRequestsScanVersion: 1,
    });
    const { dao } = settleRunDao(run);
    const deps = settleDeps();
    const service = new PullRequestCaptureService(
      itemDao,
      dao,
      deps.em,
      deps.bus,
      ...noSessionRecords(),
    );
    service.onModuleInit();

    await deps.listeners[0]?.({
      runId: 'run-1',
      item: { nodeId: 'engineer', kind: 'turn_complete' },
    });
    await settled();

    expect(
      readRunPullRequests(run.pullRequests).map((row) => row.number),
    ).toEqual([87]);
    expect(run.pullRequestsScanVersion).toBe(PULL_REQUEST_SCAN_VERSION);
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
      ...noSessionRecords(),
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
          {
            owner: 'acme',
            repo: 'platform',
            number: 87,
            url: CREATED,
            seq: 2,
            opened: true,
          },
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
      ...noSessionRecords(),
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
      ...noSessionRecords(),
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
          {
            owner: 'acme',
            repo: 'platform',
            number: 87,
            url: CREATED,
            seq: 2,
            opened: true,
          },
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
      ...noSessionRecords(),
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
      ...noSessionRecords(),
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
