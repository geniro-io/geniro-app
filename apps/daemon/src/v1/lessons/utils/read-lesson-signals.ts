import type { EntityManager } from '@mikro-orm/sqlite';

import type { GoalDao } from '../../agents/dao/goal.dao';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { LessonSignal } from '../lessons.types';
import {
  foldLessonSignals,
  LESSON_SIGNAL_ITEM_KINDS,
  type LessonSignalItem,
} from './lesson-signals.fold';

const SIGNAL_PAGE_SIZE = 500;

/** The stores a stretch's signals are read from. */
export interface LessonSignalSources {
  itemDao: ItemDao;
  goalDao: GoalDao;
}

/** The learning signals of a run after `afterSeq`, up to and including `maxSeq`, paged off the store. */
export async function readLessonSignals(
  sources: LessonSignalSources,
  runId: string,
  afterSeq: number,
  maxSeq: number,
  em: EntityManager,
): Promise<LessonSignal[]> {
  const items: LessonSignalItem[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await sources.itemDao.analysisPage(
      runId,
      {
        afterSeq: cursor,
        maxSeq,
        limit: SIGNAL_PAGE_SIZE,
        kinds: LESSON_SIGNAL_ITEM_KINDS,
      },
      em,
    );
    items.push(...page);
    if (page.length < SIGNAL_PAGE_SIZE) {
      break;
    }
    cursor = page[page.length - 1]!.seq;
  }
  const goals = await sources.goalDao.listByRun(runId, em);
  const [nextRow] = await sources.itemDao.analysisPage(
    runId,
    { afterSeq: maxSeq, maxSeq: Number.MAX_SAFE_INTEGER, limit: 1 },
    em,
  );
  return foldLessonSignals(items, {
    afterFinishedTurn: afterSeq >= 0,
    afterEarlierStretch: afterSeq >= 0,
    nextRowAt: nextRow?.createdAt ?? null,
    goals,
  });
}
