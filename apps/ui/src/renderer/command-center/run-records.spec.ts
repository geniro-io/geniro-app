import { describe, expect, it } from 'vitest';

import {
  hasFiniteNumbers,
  keptRunRecords,
  type RunRecords,
  withRunRecord,
} from './run-records';

describe('withRunRecord', () => {
  it('sets a record last, and moves one set again to last without dropping another', () => {
    const records: RunRecords<number> = { a: 1, b: 2 };

    const added = withRunRecord(records, 'c', 3, 10);
    expect(Object.keys(added)).toEqual(['a', 'b', 'c']);

    const moved = withRunRecord(records, 'a', 4, 10);
    expect(Object.keys(moved)).toEqual(['b', 'a']);
    expect(moved.a).toBe(4);
  });

  it('drops the oldest records past the cap', () => {
    const records: RunRecords<number> = { a: 1, b: 2 };

    expect(Object.keys(withRunRecord(records, 'c', 3, 2))).toEqual(['b', 'c']);
    expect(Object.keys(withRunRecord(records, 'a', 3, 2))).toEqual(['b', 'a']);
  });
});

describe('keptRunRecords', () => {
  it('hands back the same records when none fall outside the set', () => {
    const records: RunRecords<number> = { a: 1, b: 2 };

    expect(keptRunRecords(records, new Set(['a', 'b', 'c']))).toBe(records);
  });

  it('drops the records outside the set into a new object, leaving the original as it was', () => {
    const records: RunRecords<number> = { a: 1, b: 2 };

    const kept = keptRunRecords(records, new Set(['b']));

    expect(kept).not.toBe(records);
    expect(kept).toEqual({ b: 2 });
    expect(records).toEqual({ a: 1, b: 2 });
  });
});

describe('hasFiniteNumbers', () => {
  it('accepts an object whose named keys are all finite numbers', () => {
    expect(hasFiniteNumbers({ x: 1, y: -2.5, z: 'extra' }, ['x', 'y'])).toBe(
      true,
    );
  });

  it('rejects a value whose key is NaN or infinite', () => {
    expect(hasFiniteNumbers({ x: NaN, y: 1 }, ['x', 'y'])).toBe(false);
    expect(hasFiniteNumbers({ x: 1, y: Infinity }, ['x', 'y'])).toBe(false);
    expect(hasFiniteNumbers({ x: -Infinity }, ['x'])).toBe(false);
  });

  it('rejects a value with a key missing or not a number, and any value that is not an object', () => {
    expect(hasFiniteNumbers({ x: 1 }, ['x', 'y'])).toBe(false);
    expect(hasFiniteNumbers({ x: '1', y: 2 }, ['x', 'y'])).toBe(false);
    expect(hasFiniteNumbers(null, ['x'])).toBe(false);
    expect(hasFiniteNumbers('text', ['x'])).toBe(false);
    expect(hasFiniteNumbers(3, ['x'])).toBe(false);
  });
});
