import { describe, expect, it } from 'vitest';

import { POLLED_SPEND_SEQ } from '../stats.types';
import { foldTeamStats, type TeamStatsUsageRow } from './team-stats-fold';

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
      },
    ]);
  });
});
