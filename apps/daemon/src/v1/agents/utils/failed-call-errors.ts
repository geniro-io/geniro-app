import type { EntityManager } from '@mikro-orm/sqlite';

import type { ItemDao } from '../dao/item.dao';
import { toolResultText } from './payload-field-text';

/** How many failed calls' result rows one statement reads. */
const FAILURE_ROWS_READ = 200;

/** How much of a failed call's error is kept to sign it; a signature reads its first line. */
const FAILURE_TEXT_READ_CHARS = 4_000;

/**
 * The error text of each failed call of one run whose result row is at one
 * of `resultSeqs`, at or below `maxSeq`, read in windows of one statement
 * each and cut to what a signature needs; a row not found has no entry.
 */
export async function failedCallErrors(
  itemDao: Pick<ItemDao, 'rowsAtSeqs'>,
  runId: string,
  resultSeqs: readonly number[],
  maxSeq: number,
  em: EntityManager,
  yieldTurn: () => Promise<void>,
): Promise<Map<number, string>> {
  const errors = new Map<number, string>();
  for (let at = 0; at < resultSeqs.length; at += FAILURE_ROWS_READ) {
    const rows = await itemDao.rowsAtSeqs(
      runId,
      resultSeqs.slice(at, at + FAILURE_ROWS_READ),
      maxSeq,
      em,
    );
    for (const row of rows) {
      errors.set(
        row.seq,
        toolResultText(row.payload).slice(0, FAILURE_TEXT_READ_CHARS),
      );
    }
    await yieldTurn();
  }
  return errors;
}
