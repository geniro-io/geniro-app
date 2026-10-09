import { describe, expect, it } from 'vitest';

import {
  isOutstanding,
  readUnrecordedSpend,
  writeUnrecordedSpend,
} from './unrecorded-spend';

describe('Run.unrecordedSpend — the column codec', () => {
  it('round-trips the owners still owed a row', () => {
    const spend = new Map([
      ['engineer::call-1', 38.5],
      ['agent', 0.25],
    ]);

    expect(readUnrecordedSpend(writeUnrecordedSpend(spend))).toEqual(spend);
  });

  it('writes NULL, not an empty object, when nothing is owed', () => {
    // The boot rehydration scans `IS NOT NULL`; an `{}` would be a row it
    // reads for nothing on every launch.
    expect(writeUnrecordedSpend(new Map())).toBeNull();
    expect(writeUnrecordedSpend(new Map([['agent', 0]]))).toBeNull();
  });

  it('serializes one set of entries to one text, whatever order it was built in', () => {
    // What lets the store skip a write that would change nothing.
    expect(
      writeUnrecordedSpend(
        new Map([
          ['b', 1],
          ['a', 2],
        ]),
      ),
    ).toBe(
      writeUnrecordedSpend(
        new Map([
          ['a', 2],
          ['b', 1],
        ]),
      ),
    );
  });

  it('drops what it cannot read rather than the whole column', () => {
    expect(
      readUnrecordedSpend(
        JSON.stringify({ good: 1.5, zero: 0, negative: -2, text: 'x', '': 3 }),
      ),
    ).toEqual(new Map([['good', 1.5]]));
    expect(readUnrecordedSpend('not json')).toEqual(new Map());
    expect(readUnrecordedSpend('[1,2]')).toEqual(new Map());
    expect(readUnrecordedSpend(null)).toEqual(new Map());
  });

  it('counts only a positive, finite figure as outstanding', () => {
    expect(isOutstanding(0.01)).toBe(true);
    expect(isOutstanding(0)).toBe(false);
    expect(isOutstanding(-1)).toBe(false);
    expect(isOutstanding(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isOutstanding(null)).toBe(false);
  });
});
