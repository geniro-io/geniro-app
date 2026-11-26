import { describe, expect, it } from 'vitest';

import { isNewestDone, newestDoneSeqByRun } from './thread-done-context';

const done = (runId: string) => ({
  runId,
  title: runId,
  handle: 't1',
  summary: null,
  pullRequest: null,
});

describe('newestDoneSeqByRun', () => {
  it('keeps the highest seq of each run across rows in any order', () => {
    const newest = newestDoneSeqByRun([
      { seq: 9, payload: { threadDone: [done('a')] } },
      { seq: 3, payload: { threadDone: [done('a'), done('b')] } },
      { seq: 5, payload: { threadDone: [done('b')] } },
    ]);
    expect(newest.get('a')).toBe(9);
    expect(newest.get('b')).toBe(5);
  });

  it('ignores rows that are not Done rows', () => {
    const newest = newestDoneSeqByRun([
      { seq: 1, payload: { message: 'hi' } },
      { seq: 2 },
      { seq: 3, payload: { threadWake: { fromRunId: 'a', fromTitle: 'A' } } },
    ]);
    expect(newest.size).toBe(0);
  });
});

describe('isNewestDone', () => {
  const newest = new Map([['a', 9]]);

  it('draws only the entry in the newest row', () => {
    expect(isNewestDone(newest, 'a', 9)).toBe(true);
    expect(isNewestDone(newest, 'a', 3)).toBe(false);
  });

  it('draws an entry whose run is not counted, or any with no map', () => {
    expect(isNewestDone(newest, 'z', 1)).toBe(true);
    expect(isNewestDone(null, 'a', 3)).toBe(true);
  });
});
