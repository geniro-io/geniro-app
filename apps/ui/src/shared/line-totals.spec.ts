import { describe, expect, it } from 'vitest';

import { sumLineTotals } from './line-totals';

describe('sumLineTotals', () => {
  it('adds up every change that measured a count', () => {
    expect(
      sumLineTotals([
        { added: 3, removed: 1 },
        { added: 4, removed: 0 },
      ]),
    ).toEqual({ added: 7, removed: 1 });
  });

  it('answers null for a count no change measured, not zero', () => {
    expect(sumLineTotals([{ added: null, removed: null }])).toEqual({
      added: null,
      removed: null,
    });
    expect(sumLineTotals([])).toEqual({ added: null, removed: null });
  });

  it('sums the counts that were measured past a change that was not', () => {
    expect(
      sumLineTotals([
        { added: 5, removed: 2 },
        { added: null, removed: null },
      ]),
    ).toEqual({ added: 5, removed: 2 });
  });
});
