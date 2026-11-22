import { describe, expect, it } from 'vitest';

import { POLLED_SPEND_SEQ, PROMPT_CACHE_WARMUP_SEQ } from '../stats.types';
import {
  isPolledSpendRow,
  isSpendWithoutTurn,
  polledSpendRows,
  type PolledSpendRun,
  PolledTurnCredit,
  turnKey,
} from './polled-spend';

const run = (over: Partial<PolledSpendRun> = {}): PolledSpendRun => ({
  id: 'run-1',
  polledCostCents: 1000,
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  agentKind: null,
  model: null,
  cwd: '/repo',
  teamId: 'dev-team',
  teamSnapshot: null,
  analysisPurpose: null,
  polledSpendBuckets: JSON.stringify({
    '2026-10-01|gpt-5': 600,
    '2026-10-02|gpt-5': 400,
  }),
  ...over,
});

const pollsCursor = (kind: string): boolean => kind === 'cursor-agent';

describe('polledSpendRows', () => {
  it('files a chat run’s bill under no member', () => {
    const rows = polledSpendRows(
      run({ agentKind: 'cursor-agent', teamId: null }),
      'cursor-agent',
    );

    expect(rows.map((row) => [row.memberId, row.costUsd])).toEqual([
      [null, 6],
      [null, 4],
    ]);
  });

  it('splits a team run’s bill across the members the poll credited', () => {
    const rows = polledSpendRows(
      run(),
      'cursor-agent',
      null,
      [
        { memberId: 'qa', agentKind: 'cursor-agent', polledCostCents: 750 },
        {
          memberId: 'handyman',
          agentKind: 'cursor-agent',
          polledCostCents: 250,
        },
        { memberId: 'manager', agentKind: 'claude', polledCostCents: 0 },
      ],
      pollsCursor,
    );

    expect(
      rows.map((row) => [row.memberId, row.agentKind, row.costUsd, row.seq]),
    ).toEqual([
      ['handyman', 'cursor-agent', 1.5, -1],
      ['qa', 'cursor-agent', 4.5, -2],
      ['handyman', 'cursor-agent', 1, -3],
      ['qa', 'cursor-agent', 3, -4],
    ]);
    expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBe(10);
  });

  it('keeps a team run’s bill unattributed when no member was credited', () => {
    const rows = polledSpendRows(run(), 'cursor-agent', null, [], pollsCursor);

    expect(rows.map((row) => row.memberId)).toEqual([null, null]);
  });
});

describe('spend without a turn', () => {
  it('splits it into the account poll’s rows and the warm-ups below them', () => {
    expect(isSpendWithoutTurn({ seq: POLLED_SPEND_SEQ })).toBe(true);
    expect(isSpendWithoutTurn({ seq: PROMPT_CACHE_WARMUP_SEQ })).toBe(true);
    expect(isSpendWithoutTurn({ seq: 0 })).toBe(false);
    expect(isPolledSpendRow({ seq: POLLED_SPEND_SEQ })).toBe(true);
    expect(isPolledSpendRow({ seq: PROMPT_CACHE_WARMUP_SEQ })).toBe(false);
  });

  it('takes no unpriced turns for a warm-up, leaving the run’s polled row its turns', () => {
    const credit = new PolledTurnCredit(
      new Map([[turnKey('run-a', 'cursor-agent'), 3]]),
      ['cursor-agent'],
    );

    expect(
      credit.next({
        runId: 'run-a',
        agentKind: 'claude',
        seq: PROMPT_CACHE_WARMUP_SEQ,
      }),
    ).toEqual({ turns: 0, agentTurns: 0 });
    expect(
      credit.next({
        runId: 'run-a',
        agentKind: 'cursor-agent',
        seq: POLLED_SPEND_SEQ,
      }),
    ).toEqual({ turns: 3, agentTurns: 3 });
  });
});
