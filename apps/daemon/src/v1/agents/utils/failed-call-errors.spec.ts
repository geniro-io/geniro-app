import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import { failedCallErrors } from './failed-call-errors';

const em = {} as EntityManager;

function itemDaoWith(rows: Map<number, string>) {
  return {
    rowsAtSeqs: vi.fn(
      (_runId: string, seqs: readonly number[], _maxSeq: number) =>
        Promise.resolve(
          seqs
            .filter((seq) => rows.has(seq))
            .map((seq) => ({ seq, payload: rows.get(seq)! })),
        ),
    ),
  };
}

describe('failedCallErrors', () => {
  it('reads every result row in windows of one statement each, and gives a missing row no entry', async () => {
    const rows = new Map(
      Array.from({ length: 201 }, (_, seq) => [
        seq,
        JSON.stringify({ result: `INVALID_ARGS: call ${seq}`, isError: true }),
      ]),
    );
    rows.delete(7);
    const itemDao = itemDaoWith(rows);
    const yieldTurn = vi.fn(() => Promise.resolve());

    const errors = await failedCallErrors(
      itemDao,
      'run-1',
      Array.from({ length: 201 }, (_, seq) => seq),
      500,
      em,
      yieldTurn,
    );

    expect(itemDao.rowsAtSeqs).toHaveBeenCalledTimes(2);
    expect(itemDao.rowsAtSeqs.mock.calls[0]![1]).toHaveLength(200);
    expect(itemDao.rowsAtSeqs.mock.calls[1]![1]).toEqual([200]);
    expect(itemDao.rowsAtSeqs.mock.calls[0]![2]).toBe(500);
    expect(yieldTurn).toHaveBeenCalledTimes(2);
    expect(errors.size).toBe(200);
    expect(errors.get(200)).toBe('INVALID_ARGS: call 200');
    expect(errors.has(7)).toBe(false);
  });

  it('reads a result recorded as content blocks as the text they carry', async () => {
    const itemDao = itemDaoWith(
      new Map([
        [
          4,
          JSON.stringify({
            result: [{ type: 'text', text: 'INVALID_ARGS: limit is too big' }],
            isError: true,
          }),
        ],
      ]),
    );

    const errors = await failedCallErrors(itemDao, 'run-1', [4], 9, em, () =>
      Promise.resolve(),
    );

    expect(errors.get(4)).toBe('INVALID_ARGS: limit is too big');
  });

  it('cuts a long error to what a signature needs', async () => {
    const itemDao = itemDaoWith(
      new Map([[3, JSON.stringify({ result: 'x'.repeat(10_000) })]]),
    );

    const errors = await failedCallErrors(itemDao, 'run-1', [3], 9, em, () =>
      Promise.resolve(),
    );

    expect(errors.get(3)).toHaveLength(4_000);
  });
});
