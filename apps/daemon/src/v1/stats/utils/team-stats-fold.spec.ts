import { describe, expect, it } from 'vitest';

import type { ChatTotalsWire } from '../../agents/chat.types';
import { POLLED_SPEND_SEQ } from '../stats.types';
import {
  foldTeamPopulation,
  foldTeamStats,
  type TeamStatsUsageRow,
} from './team-stats-fold';

const totalsOf = (
  costUsd: number | null,
  workedMs: number | null,
  turns: number,
): ChatTotalsWire =>
  ({ costUsd, workedMs, turns }) as unknown as ChatTotalsWire;

const figures = {
  costUsd: null,
  estimatedCostUsd: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  thinkingTokens: null,
  durationMs: null,
  apiMs: null,
  ttftMs: null,
  timeToRequestMs: null,
  numTurns: null,
};

const row = (over: Partial<TeamStatsUsageRow>): TeamStatsUsageRow => ({
  runId: 'run-1',
  seq: 1,
  agentKind: 'cursor-agent',
  memberId: 'qa',
  occurredAt: new Date('2026-10-01T09:00:00Z'),
  ...figures,
  ...over,
});

describe('foldTeamStats', () => {
  it('credits a member with the polled bill filed under it, keeping the CLI its turns ran on', () => {
    const stats = foldTeamStats({
      slug: 'dev-team',
      threads: [
        {
          runId: 'run-1',
          occurredAt: new Date('2026-10-01T08:00:00Z'),
          slug: 'dev-team',
          version: null,
          inferred: null,
        },
      ],
      usage: [
        row({ seq: 1 }),
        row({ seq: 2 }),
        row({
          seq: POLLED_SPEND_SEQ,
          memberId: 'qa',
          agentKind: 'codex',
          occurredAt: new Date('2026-10-01T23:00:00Z'),
          costUsd: 4.5,
        }),
      ],
      polledKinds: ['cursor-agent'],
      outcomes: [],
    });

    expect(stats.byMember).toEqual([
      {
        memberId: 'qa',
        agentKind: 'cursor-agent',
        costUsd: 4.5,
        turns: 2,
        workedMs: null,
        measuredWorkedMs: 0,
        runs: 0,
        perRun: { costUsd: null, workedMs: null },
        work: null,
        changes: [],
        assessments: [],
      },
    ]);
  });
});

describe('foldTeamPopulation', () => {
  it('counts a run with no usage in the runs, but in none of the per-run figures it did not measure', () => {
    expect(
      foldTeamPopulation(
        [{ runId: 'a' }, { runId: 'b' }, { runId: 'quiet' }],
        new Map([
          ['a', totalsOf(2, 500, 1)],
          ['b', totalsOf(4, 1000, 1)],
        ]),
      ),
    ).toEqual({
      runs: 3,
      perRun: {
        costUsd: 3,
        pricedRuns: 2,
        workedMs: 750,
        timedRuns: 2,
        turns: 0.7,
      },
    });
  });

  it('averages cost and worked time over the runs that measured them, and turns over every run', () => {
    expect(
      foldTeamPopulation(
        [{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }, { runId: 'd' }],
        new Map([
          ['a', totalsOf(2, 500, 4)],
          ['b', totalsOf(null, 1000, 2)],
          ['c', totalsOf(6, null, 2)],
        ]),
      ).perRun,
    ).toEqual({
      costUsd: 4,
      pricedRuns: 2,
      workedMs: 750,
      timedRuns: 2,
      turns: 2,
    });
  });

  it('reads an empty team as no runs, nulls and no turns', () => {
    expect(foldTeamPopulation([], new Map())).toEqual({
      runs: 0,
      perRun: {
        costUsd: null,
        pricedRuns: 0,
        workedMs: null,
        timedRuns: 0,
        turns: 0,
      },
    });
  });
});
