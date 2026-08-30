import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { readRunPullRequests } from '../utils/pull-request-capture';
import { PullRequestCaptureService } from './pull-request-capture.service';

const em = {} as EntityManager;

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

describe('PullRequestCaptureService', () => {
  it('captures the pull request a gh pr create call opened', async () => {
    const { itemDao } = daos([
      call(1, 'toolu_1', 'cd /repo && gh pr create --base main'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();
    const run = chatRun();

    await new PullRequestCaptureService(itemDao, dao).sync([run], em);

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

    await new PullRequestCaptureService(itemDao, dao).sync([chatRun()], em);

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

    await new PullRequestCaptureService(itemDao, dao).sync([chatRun()], em);

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

    await new PullRequestCaptureService(itemDao, dao).sync([chatRun()], em);

    expect(writes[0]?.pullRequestsScannedSeq).toBe(2);
    expect(writes[0]?.pullRequests).toBeNull();
  });

  it('reads no payloads at all when the run has not moved', async () => {
    const { itemDao, counts } = daos([
      call(1, 'toolu_1', 'gh pr create'),
      result(2, 'toolu_1', CREATED),
    ]);
    const { dao, writes } = runDao();

    await new PullRequestCaptureService(itemDao, dao).sync(
      [chatRun({ pullRequestsScannedSeq: 2 })],
      em,
    );

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
    const service = new PullRequestCaptureService(failing, dao);

    await expect(
      service.sync([chatRun(), chatRun({ id: 'run-2' })], em),
    ).resolves.toBeUndefined();
    expect(writes).toEqual([]);
  });
});
