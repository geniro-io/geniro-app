import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { SeqRange } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { RunOutcomeHistoryService } from './run-outcome-history.service';

interface Row {
  seq: number;
  kind: string;
  payload: unknown;
  minute: number;
}

const outcome = (
  pr: number,
  fields: { acceptance: string; reviewRounds?: number; summary?: string },
): Record<string, unknown> => ({
  prOwner: 'Acme',
  prRepo: 'platform',
  prNumber: pr,
  prUrl: `https://github.com/Acme/platform/pull/${pr}`,
  draft: false,
  reviewRounds: fields.reviewRounds ?? 0,
  acceptance: fields.acceptance,
  questionsAsked: 0,
  ...(fields.summary === undefined ? {} : { summary: fields.summary }),
  workflowSlug: 'dev-team',
  nodeId: 'manager',
  conversationId: null,
});

const question = (count: number): Record<string, unknown> => ({
  toolName: 'AskUserQuestion',
  questions: Array.from({ length: count }, (_, at) => ({ question: `q${at}` })),
});

function serviceOver(rows: readonly Row[]): RunOutcomeHistoryService {
  const em = { fork: () => em } as unknown as EntityManager;
  const itemDao = {
    rowsOfKinds: async (
      _runId: string,
      kinds: readonly string[],
      range: SeqRange | undefined,
    ) =>
      rows
        .filter(
          (row) =>
            kinds.includes(row.kind) &&
            (range === undefined ||
              !('before' in range) ||
              row.seq < range.before),
        )
        .map((row) => ({
          seq: row.seq,
          kind: row.kind,
          payload: JSON.stringify(row.payload),
          createdAt: new Date(Date.UTC(2026, 9, 27, 9, row.minute)),
        })),
  } as unknown as ItemDao;
  const adapters = {
    all: () =>
      new Map([
        [
          'claude',
          { getConfig: () => ({ questionToolName: 'AskUserQuestion' }) },
        ],
      ]),
  } as unknown as AgentAdapterRegistry;
  return new RunOutcomeHistoryService(em, itemDao, adapters);
}

describe('RunOutcomeHistoryService', () => {
  const rows: Row[] = [
    { seq: 5, kind: 'approval_request', payload: question(2), minute: 0 },
    {
      seq: 10,
      kind: 'run_outcome',
      payload: outcome(87, { acceptance: 'not_yet' }),
      minute: 1,
    },
    { seq: 12, kind: 'approval_request', payload: question(1), minute: 2 },
    {
      seq: 20,
      kind: 'run_outcome',
      payload: outcome(87, {
        acceptance: 'changes_requested',
        reviewRounds: 1,
        summary: '  Move the retry behind a flag. ',
      }),
      minute: 3,
    },
    {
      seq: 25,
      kind: 'run_outcome',
      payload: outcome(90, { acceptance: 'not_needed' }),
      minute: 4,
    },
    {
      seq: 26,
      kind: 'run_outcome',
      payload: { prNumber: 'garbled' },
      minute: 4,
    },
    {
      seq: 30,
      kind: 'approval_request',
      payload: { toolName: 'Bash' },
      minute: 5,
    },
    { seq: 31, kind: 'approval_request', payload: question(3), minute: 6 },
    {
      seq: 40,
      kind: 'run_outcome',
      payload: outcome(87, { acceptance: 'accepted', reviewRounds: 2 }),
      minute: 21,
    },
  ];

  it('groups the outcomes per pull request, newest first, with what their history adds up to', async () => {
    const { pullRequests, questionsAsked } =
      await serviceOver(rows).read('run-1');

    expect(questionsAsked).toBe(6);

    expect(pullRequests.map((pr) => pr.number)).toEqual([87, 90]);
    expect(pullRequests[0]).toMatchObject({
      owner: 'Acme',
      repo: 'platform',
      url: 'https://github.com/Acme/platform/pull/87',
      changesRequestedRounds: 1,
      msToAccepted: 20 * 60_000,
    });
    expect(
      pullRequests[0]?.outcomes.map((entry) => [
        entry.seq,
        entry.acceptance,
        entry.questionsAsked,
        entry.summary,
      ]),
    ).toEqual([
      [40, 'accepted', 6, null],
      [20, 'changes_requested', 3, 'Move the retry behind a flag.'],
      [10, 'not_yet', 2, null],
    ]);
    expect(pullRequests[1]).toMatchObject({
      changesRequestedRounds: 0,
      msToAccepted: null,
    });
  });

  it('reads the outcomes and the questions only up to the seq it is given', async () => {
    const { pullRequests, questionsAsked } = await serviceOver(rows).read(
      'run-1',
      20,
    );

    expect(questionsAsked).toBe(3);

    expect(pullRequests).toHaveLength(1);
    expect(pullRequests[0]).toMatchObject({
      changesRequestedRounds: 1,
      msToAccepted: null,
    });
    expect(pullRequests[0]?.outcomes.map((entry) => entry.seq)).toEqual([
      20, 10,
    ]);
  });

  it('counts a question card written exactly at the seq it reads to', async () => {
    expect((await serviceOver(rows).read('run-1', 31)).questionsAsked).toBe(6);
  });

  it('answers no pull requests for a run that recorded none, its questions still counted', async () => {
    expect(
      await serviceOver(rows.filter((row) => row.kind !== 'run_outcome')).read(
        'run-1',
      ),
    ).toEqual({ pullRequests: [], questionsAsked: 6 });
  });
});
