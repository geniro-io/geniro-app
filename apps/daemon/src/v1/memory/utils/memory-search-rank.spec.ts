import { describe, expect, it } from 'vitest';

import {
  MEMORY_COLD_DAYS,
  MEMORY_RANK_USAGE_HALF_LIFE_DAYS,
  type MemoryUsageCount,
} from '../memory.types';
import {
  decayedReads,
  type MemoryRankSignals,
  type MemorySearchCandidate,
  rankBoost,
  rankSearchCandidates,
  relevanceOfRanks,
} from './memory-search-rank';
import { DAY_MS } from './memory-usage-day';

const NOW = new Date('2026-11-23T12:00:00Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function candidate(
  id: string,
  handle: number,
  relevance: number,
  scope: 'global' | 'project' | 'team' = 'global',
): MemorySearchCandidate {
  return {
    id,
    handle,
    relevance,
    projectId: scope === 'project' ? 'p1' : null,
    teamSlug: scope === 'team' ? 'a' : null,
  };
}

function orderOf(
  candidates: readonly MemorySearchCandidate[],
  signals: Record<string, MemoryRankSignals> = {},
  limit = candidates.length,
): string[] {
  return rankSearchCandidates(
    candidates,
    new Map(Object.entries(signals)),
    limit,
  );
}

function reads(memoryId: string, day: string, count: number): MemoryUsageCount {
  return { memoryId, day, reads: count, searchHits: 0, indexShows: 0 };
}

describe('relevanceOfRanks', () => {
  it('scales every rank to the best one, so the best is 1 and a weaker match a fraction of it', () => {
    expect(relevanceOfRanks([{ rank: -8 }, { rank: -2 }])).toEqual([1, 0.25]);
  });

  it('is 1 for every match when no rank is negative', () => {
    expect(relevanceOfRanks([{ rank: 0 }, { rank: 3 }])).toEqual([1, 1]);
  });

  it('keeps every relevance above 0 and at most 1 when some ranks are not negative', () => {
    const relevance = relevanceOfRanks([
      { rank: -4 },
      { rank: 0 },
      { rank: 2 },
    ]);

    expect(relevance[0]).toBe(1);
    for (const value of relevance.slice(1)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is empty when nothing matched', () => {
    expect(relevanceOfRanks([])).toEqual([]);
  });
});

describe('decayedReads', () => {
  it('counts a read of today in full', () => {
    expect(decayedReads([reads('a', daysAgo(0), 2)], NOW).get('a')).toBe(2);
  });

  it('halves a read every MEMORY_RANK_USAGE_HALF_LIFE_DAYS days', () => {
    const weight = decayedReads(
      [reads('a', daysAgo(MEMORY_RANK_USAGE_HALF_LIFE_DAYS), 1)],
      NOW,
    ).get('a');

    expect(weight).toBeCloseTo(0.5);
  });

  it('adds up the days of one entry', () => {
    const weight = decayedReads(
      [reads('a', daysAgo(0), 1), reads('a', daysAgo(30), 2)],
      NOW,
    ).get('a');

    expect(weight).toBeCloseTo(2);
  });

  it('counts a read MEMORY_COLD_DAYS old, and nothing older', () => {
    const weights = decayedReads(
      [
        reads('edge', daysAgo(MEMORY_COLD_DAYS), 1),
        reads('old', daysAgo(MEMORY_COLD_DAYS + 1), 1),
      ],
      NOW,
    );

    expect(weights.get('edge')).toBeGreaterThan(0);
    expect(weights.get('old')).toBeUndefined();
  });

  it('reads the reads only, not search hits or index shows', () => {
    const weights = decayedReads(
      [
        {
          memoryId: 'a',
          day: daysAgo(0),
          reads: 0,
          searchHits: 5,
          indexShows: 3,
        },
      ],
      NOW,
    );

    expect(weights.get('a') ?? 0).toBe(0);
  });
});

describe('rankBoost', () => {
  it('caps the mark boost at the forget threshold, whichever way the net points', () => {
    const entry = candidate('a', 1, 1);

    expect(rankBoost(entry, { net: 10, recentReads: 0 })).toBe(
      rankBoost(entry, { net: 3, recentReads: 0 }),
    );
    expect(rankBoost(entry, { net: -10, recentReads: 0 })).toBe(
      rankBoost(entry, { net: -3, recentReads: 0 }),
    );
  });
});

describe('rankSearchCandidates', () => {
  it('keeps the text order when nothing is marked or read and every entry shares a scope', () => {
    expect(
      orderOf([
        candidate('low', 2, 0.5),
        candidate('top', 3, 1),
        candidate('mid', 1, 0.8),
      ]),
    ).toEqual(['top', 'mid', 'low']);
  });

  it('lifts an entry with helped threads above an equal match with none, and drops one with net not-useful below it', () => {
    const equal = [
      candidate('none', 1, 1),
      candidate('helped', 2, 1),
      candidate('unhelpful', 3, 1),
    ];

    expect(
      orderOf(equal, {
        helped: { net: 2, recentReads: 0 },
        unhelpful: { net: -2, recentReads: 0 },
      }),
    ).toEqual(['helped', 'none', 'unhelpful']);
  });

  it('lifts an entry read more or more recently above an equal match never read', () => {
    const equal = [
      candidate('never', 1, 1),
      candidate('once', 2, 1),
      candidate('often', 3, 1),
    ];

    expect(
      orderOf(equal, {
        once: { net: 0, recentReads: 1 },
        often: { net: 0, recentReads: 5 },
      }),
    ).toEqual(['often', 'once', 'never']);
  });

  it('puts a team entry above a project one above a global one when nothing else separates them', () => {
    const equal = [
      candidate('global', 1, 1),
      candidate('project', 2, 1, 'project'),
      candidate('team', 3, 1, 'team'),
    ];

    expect(orderOf(equal)).toEqual(['team', 'project', 'global']);
  });

  it('never lets a weak match beat a strong one at 1.5 times its relevance, whatever the weak one has or the strong one was voted down', () => {
    const strong = candidate('strong', 2, 1);
    const weak = candidate('weak', 1, 1 / 1.5, 'team');

    expect(
      orderOf([weak, strong], {
        strong: { net: -10, recentReads: 0 },
        weak: { net: 10, recentReads: 1000 },
      }),
    ).toEqual(['strong', 'weak']);
  });

  it('breaks equal scores by handle ascending, whatever order the candidates come in', () => {
    const forward = [
      candidate('seven', 7, 1),
      candidate('three', 3, 1),
      candidate('five', 5, 1),
    ];
    const backward = [...forward].reverse();

    expect(orderOf(forward)).toEqual(['three', 'five', 'seven']);
    expect(orderOf(backward)).toEqual(['three', 'five', 'seven']);
  });

  it('breaks equal scores by the better text match before the handle', () => {
    const team = candidate('team', 1, 0.5, 'team');
    const global = candidate(
      'global',
      2,
      team.relevance * (1 + rankBoost(team, undefined)),
    );

    expect(orderOf([team, global])).toEqual(['global', 'team']);
  });

  it('returns at most the limit, best first', () => {
    const equal = [
      candidate('c', 3, 1),
      candidate('a', 1, 1),
      candidate('b', 2, 1),
    ];

    expect(orderOf(equal, {}, 2)).toEqual(['a', 'b']);
  });
});
