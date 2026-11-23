import { describe, expect, it } from 'vitest';

import { fuseRanks, RRF_K } from './rrf';

describe('fuseRanks', () => {
  it('scores a single list best first, its first place 1 and every other place in (0, 1]', () => {
    const relevance = fuseRanks([{ ids: ['a', 'b', 'c', 'd'], weight: 1 }]);

    expect([...relevance.keys()]).toEqual(['a', 'b', 'c', 'd']);
    expect(relevance.get('a')).toBe(1);
    const values = [...relevance.values()];
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(values).toEqual([...values].sort((x, y) => y - x));
  });

  it('gives the second place of a meaning-only list (RRF_K + 1) / (RRF_K + 2) of the first', () => {
    const relevance = fuseRanks([{ ids: ['m1', 'm2'], weight: 1 }]);

    expect(relevance.get('m1')).toBe(1);
    expect(relevance.get('m2')).toBeCloseTo((RRF_K + 1) / (RRF_K + 2), 12);
  });

  it('puts an id first in both the strict and the meaning list above one first in only one', () => {
    const relevance = fuseRanks([
      { ids: ['strictFirst', 'both'], weight: 1 },
      { ids: ['both', 'meaningFirst'], weight: 1 },
    ]);

    expect(relevance.get('both')).toBe(1);
    expect(relevance.get('strictFirst')).toBeLessThan(1);
    expect(relevance.get('meaningFirst')).toBeLessThan(
      relevance.get('strictFirst') ?? Number.NaN,
    );
  });

  it('counts a list at half weight as half as much at the same place', () => {
    const relevance = fuseRanks([
      { ids: ['full'], weight: 1 },
      { ids: ['half'], weight: 0.5 },
    ]);

    expect(relevance.get('full')).toBe(1);
    expect(relevance.get('half')).toBeCloseTo(0.5, 12);
  });

  it('keeps the best id at 1 when only a half-weight list answers', () => {
    expect(fuseRanks([{ ids: ['only'], weight: 0.5 }]).get('only')).toBe(1);
  });

  it('answers nothing for no lists', () => {
    expect(fuseRanks([]).size).toBe(0);
  });
});
