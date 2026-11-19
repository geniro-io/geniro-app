import { describe, expect, it } from 'vitest';

import { type NameableThread, resolveTarget } from './resolve-target';

const billing: NameableThread = {
  handle: 't1',
  runId: '6f1d2c1e-1111-4a3b-8c1d-000000000001',
  title: 'Billing export',
  done: false,
};
const cacheA: NameableThread = {
  handle: 't2',
  runId: '6f1d2c1e-1111-4a3b-8c1d-000000000002',
  title: 'Cache fix',
  done: false,
};
const cacheB: NameableThread = {
  handle: 't3',
  runId: '6f1d2c1e-1111-4a3b-8c1d-000000000003',
  title: 'cache  FIX',
  done: false,
};
const roster = [billing, cacheA, cacheB];

describe('resolveTarget', () => {
  it('resolves a handle in any case, a run id, and a unique exact title', () => {
    expect(resolveTarget('T1', roster)).toEqual({
      kind: 'resolved',
      thread: billing,
    });
    expect(resolveTarget(cacheA.runId, roster)).toEqual({
      kind: 'resolved',
      thread: cacheA,
    });
    expect(resolveTarget(' billing   EXPORT ', roster)).toEqual({
      kind: 'resolved',
      thread: billing,
    });
  });

  it('calls a title two roster threads share ambiguous, naming both', () => {
    expect(resolveTarget('Cache fix', roster)).toEqual({
      kind: 'ambiguous',
      candidates: [cacheA, cacheB],
    });
  });

  it('calls a word two roster titles contain ambiguous, naming both', () => {
    expect(resolveTarget('cache', roster)).toEqual({
      kind: 'ambiguous',
      candidates: [cacheA, cacheB],
    });
  });

  it('answers a name no title matches exactly with the one title containing it, never resolving it', () => {
    expect(resolveTarget('billing', roster)).toEqual({
      kind: 'unknown',
      candidates: [billing],
    });
    expect(resolveTarget('mobile app', roster)).toEqual({
      kind: 'unknown',
      candidates: [],
    });
  });

  describe('with finished threads on the roster', () => {
    const cacheDone: NameableThread = {
      handle: 't4',
      runId: '6f1d2c1e-1111-4a3b-8c1d-000000000004',
      title: 'Cache fix',
      done: true,
    };
    const docsOld: NameableThread = {
      handle: 't5',
      runId: '6f1d2c1e-1111-4a3b-8c1d-000000000005',
      title: 'Docs',
      done: true,
    };
    const docsNew: NameableThread = {
      handle: 't6',
      runId: '6f1d2c1e-1111-4a3b-8c1d-000000000006',
      title: 'docs',
      done: false,
    };
    const exportDone: NameableThread = {
      handle: 't7',
      runId: '6f1d2c1e-1111-4a3b-8c1d-000000000007',
      title: 'Export to CSV',
      done: true,
    };

    it('keeps a title an unfinished and a finished thread share ambiguous when the preference is off', () => {
      expect(resolveTarget('Docs', [docsOld, docsNew], false)).toEqual({
        kind: 'ambiguous',
        candidates: [docsOld, docsNew],
      });
    });

    it('resolves a title an unfinished and a finished thread share to the unfinished one', () => {
      expect(resolveTarget('Docs', [docsOld, docsNew])).toEqual({
        kind: 'resolved',
        thread: docsNew,
      });
    });

    it('stays ambiguous among the unfinished threads alone, naming no finished one', () => {
      expect(resolveTarget('Cache fix', [cacheA, cacheB, cacheDone])).toEqual({
        kind: 'ambiguous',
        candidates: [cacheA, cacheB],
      });
    });

    it('answers a word one unfinished and one finished title contain with the unfinished one, never resolving it', () => {
      expect(resolveTarget('export', [billing, exportDone])).toEqual({
        kind: 'unknown',
        candidates: [billing],
      });
    });

    it('still reaches a finished thread by its handle, its id, or a title only finished threads match', () => {
      const roster = [docsNew, cacheDone, exportDone];

      expect(resolveTarget('t4', roster)).toEqual({
        kind: 'resolved',
        thread: cacheDone,
      });
      expect(resolveTarget(exportDone.runId, roster)).toEqual({
        kind: 'resolved',
        thread: exportDone,
      });
      expect(resolveTarget('cache fix', roster)).toEqual({
        kind: 'resolved',
        thread: cacheDone,
      });
      expect(
        resolveTarget('cache', [
          cacheDone,
          { ...exportDone, title: 'Cache warm' },
        ]),
      ).toEqual({
        kind: 'ambiguous',
        candidates: [cacheDone, { ...exportDone, title: 'Cache warm' }],
      });
    });
  });
});
