import { describe, expect, it } from 'vitest';

import { capWholeSections } from './cap-whole-sections';

const textOf = (s: string): string => s;

describe('capWholeSections', () => {
  it('keeps everything when the items are well under budget', () => {
    const result = capWholeSections(['a', 'b', 'c'], textOf, ', ', 100);

    expect(result).toEqual({ kept: ['a', 'b', 'c'], omitted: [] });
  });

  it('omits an oversized item in the middle and still keeps a later short one', () => {
    const huge = 'x'.repeat(50);
    const result = capWholeSections(
      ['first', huge, 'last'],
      textOf,
      '\n\n',
      20,
    );

    expect(result.kept).toEqual(['first', 'last']);
    expect(result.omitted).toEqual([huge]);
  });

  it('keeps an item that lands exactly at the budget', () => {
    // 'ab' (2) + separator '|' (1) + 'cd' (2) === budget of 5, exactly.
    const result = capWholeSections(['ab', 'cd'], textOf, '|', 5);

    expect(result).toEqual({ kept: ['ab', 'cd'], omitted: [] });
  });

  it('omits an item one character past the budget', () => {
    // 'ab' (2) + separator '|' (1) + 'cde' (3) === 6, one over a budget of 5.
    const result = capWholeSections(['ab', 'cde'], textOf, '|', 5);

    expect(result.kept).toEqual(['ab']);
    expect(result.omitted).toEqual(['cde']);
  });

  it('answers empty kept and omitted for empty input', () => {
    const result = capWholeSections([], textOf, ', ', 100);

    expect(result).toEqual({ kept: [], omitted: [] });
  });
});
