import type { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatSearchDb, said } from '../__tests__/chat-search-db';
import type {
  PullRequestLifecycleRead,
  RunPullRequestOutcomes,
} from '../chat.types';
import { PullRequestAfterDoneService } from './pull-request-after-done.service';
import type {
  PullRequestAddress,
  PullRequestLifecycleService,
} from './pull-request-lifecycle.service';

const recorded = (number: number, seq: number): RunPullRequestOutcomes => ({
  owner: 'Acme',
  repo: 'App',
  number,
  url: `https://github.com/Acme/App/pull/${number}`,
  changesRequestedRounds: 0,
  msToAccepted: null,
  outcomes: [
    {
      seq,
      at: '2026-11-20T10:00:00.000Z',
      draft: false,
      reviewRounds: 1,
      acceptance: 'not_yet',
      questionsAsked: 0,
      summary: null,
      nodeId: 'manager',
    },
  ],
});

const captured = (number: number, seq: number) => ({
  owner: 'acme',
  repo: 'app',
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  seq,
});

describe('PullRequestAfterDoneService', () => {
  let db: Awaited<ReturnType<typeof chatSearchDb>>;
  let orm: MikroORM;
  let asked: PullRequestAddress[];
  let service: PullRequestAfterDoneService;

  beforeEach(async () => {
    db = await chatSearchDb();
    orm = db.orm;
    asked = [];
    const lifecycles = {
      readMany: (refs: readonly PullRequestAddress[]) => {
        asked.push(...refs);
        return Promise.resolve(
          new Map<string, PullRequestLifecycleRead>(
            refs.map((ref) => [
              `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase(),
              { unavailable: 'gh-signed-out' },
            ]),
          ),
        );
      },
    } as unknown as PullRequestLifecycleService;
    service = new PullRequestAfterDoneService(db.dao(), lifecycles);
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('asks only about the pull requests the run named up to its snapshot, each once, with its done marks', async () => {
    await db.run('run-a');
    await db.item('report', {
      runId: 'run-a',
      seq: 4,
      memberId: 'senior',
      payload: said(
        'DONE CHECK\nPR: #7 https://github.com/acme/app/pull/7 · draft: yes',
      ),
    });
    await db.ensureIndex();

    const lives = await service.forRuns([
      {
        run: {
          id: 'run-a',
          pullRequests: JSON.stringify([captured(7, 2), captured(8, 50)]),
          touchedPullRequests: JSON.stringify([captured(9, 3)]),
        },
        snapshotSeq: 10,
        outcomes: [recorded(7, 6), recorded(11, 8)],
      },
    ]);

    expect(asked.map((ref) => ref.number).sort()).toEqual([11, 7, 9]);
    expect(lives.get('run-a')).toEqual([
      expect.objectContaining({
        key: 'acme/app#7',
        marks: [
          expect.objectContaining({ seq: 4, source: 'done_check' }),
          expect.objectContaining({ seq: 6, source: 'record_outcome' }),
        ],
        read: { unavailable: 'gh-signed-out' },
      }),
      expect.objectContaining({ key: 'acme/app#9', marks: [] }),
      expect.objectContaining({
        key: 'acme/app#11',
        marks: [expect.objectContaining({ seq: 8 })],
      }),
    ]);
  });

  it('asks GitHub about the one pull request `only` selects, the rest answering read-budget-spent', async () => {
    await db.run('run-a');
    await db.ensureIndex();

    const lives = await service.forRuns(
      [
        {
          run: {
            id: 'run-a',
            pullRequests: JSON.stringify([captured(7, 2), captured(8, 3)]),
            touchedPullRequests: null,
          },
          snapshotSeq: 10,
          outcomes: [],
        },
      ],
      (key) => key === 'acme/app#8',
    );

    expect(asked.map((ref) => ref.number)).toEqual([8]);
    expect(lives.get('run-a')?.map((life) => [life.key, life.read])).toEqual([
      ['acme/app#7', { unavailable: 'read-budget-spent' }],
      ['acme/app#8', { unavailable: 'gh-signed-out' }],
    ]);
  });

  it('reads a pull request the run only links to from a message, by its number alone', async () => {
    await db.run('run-a');
    await db.item('linked', {
      runId: 'run-a',
      seq: 3,
      payload: said(
        'Two more open PRs, [#8761](https://github.com/acme/app/pull/8761) and others.',
      ),
    });
    await db.item('thought', {
      runId: 'run-a',
      seq: 4,
      kind: 'reasoning',
      role: null,
      payload: said('maybe https://github.com/other/repo/pull/8761 too'),
    });
    await db.ensureIndex();
    const at = {
      run: { id: 'run-a', pullRequests: null, touchedPullRequests: null },
      snapshotSeq: 10,
      outcomes: [],
    };

    const life = await service.mentioned(at, { number: 8761 });

    expect(life).toMatchObject({
      key: 'acme/app#8761',
      url: 'https://github.com/acme/app/pull/8761',
      read: { unavailable: 'gh-signed-out' },
    });
    expect(await service.mentioned(at, { number: 8762 })).toBeNull();
    expect(
      await service.mentioned(at, { owner: 'x', repo: 'y', number: 8761 }),
    ).toBeNull();
  });

  it('asks GitHub nothing for a run that named no pull request', async () => {
    await db.run('run-a');

    const lives = await service.forRuns([
      {
        run: { id: 'run-a', pullRequests: null, touchedPullRequests: null },
        snapshotSeq: 10,
        outcomes: [],
      },
    ]);

    expect(lives.get('run-a')).toEqual([]);
    expect(asked).toEqual([]);
  });
});
