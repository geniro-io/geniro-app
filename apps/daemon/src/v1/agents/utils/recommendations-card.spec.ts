import { describe, expect, it } from 'vitest';

import { parseRecommendationsPayload } from './recommendations-card';

const ITEM = {
  id: 'W-1',
  target: 'team',
  territory: 'process',
  kind: 'parallelize',
  location: 'reviewer',
  title: 'Run reviewers in parallel',
  change: 'the exact change',
  evidence: [{ seq: 4, quote: 'waited' }],
  rootCause: 'serial calls',
  impact: {
    minutesSaved: 12,
    costSavedUsd: null,
    basis: 'critical path',
    confidence: 4,
    outcome: 'reviewer waits end',
  },
  risk: { level: 'low', note: 'none' },
};

const TEAM_STATS = {
  runs: 1,
  perRun: {
    wallMs: 1000,
    activeMs: 800,
    waitingOnUserMs: 0,
    criticalPathMs: 900,
    turns: 2,
    calls: 0,
    costUsd: null,
    pricedRuns: 0,
  },
  totals: {
    wallMs: 1000,
    activeMs: 800,
    turns: 2,
    failedTurns: 0,
    cancelledTurns: 0,
    toolCalls: 3,
    failedToolCalls: 0,
    calls: 0,
    costUsd: null,
  },
  runList: [],
  agents: [],
  callEdges: 0,
  calls: [],
};

describe('parseRecommendationsPayload', () => {
  it('reads a card filed before the rename, which says workflow for the team', () => {
    const card = parseRecommendationsPayload({
      sourceRunId: 'source',
      sourceKind: 'workflow',
      timing: null,
      workflowStats: TEAM_STATS,
      items: [{ ...ITEM, target: 'workflow' }],
    });

    expect(card.success).toBe(true);
    expect(card.data?.sourceKind).toBe('team');
    expect(card.data?.items[0]?.target).toBe('team');
    expect(card.data?.teamStats).toEqual(TEAM_STATS);
  });

  it('reads a card filed today as it is', () => {
    const card = parseRecommendationsPayload({
      sourceRunId: 'source',
      sourceKind: 'chat',
      timing: null,
      items: [{ ...ITEM, id: 'R-1', target: 'repo', territory: 'domain' }],
    });

    expect(card.success).toBe(true);
    expect(card.data?.sourceKind).toBe('chat');
    expect(card.data?.items[0]?.target).toBe('repo');
  });

  it('refuses what is no card at all', () => {
    expect(parseRecommendationsPayload(null).success).toBe(false);
    expect(parseRecommendationsPayload([]).success).toBe(false);
  });
});
