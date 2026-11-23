import type { EntityManager } from '@mikro-orm/sqlite';

import type { GoalDao } from '../../agents/dao/goal.dao';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { LessonSignal } from '../lessons.types';
import {
  foldLessonSignals,
  LESSON_SIGNAL_ITEM_KINDS,
  type LessonSignalGoal,
  type LessonSignalItem,
  UNMET_GOAL_STATUSES,
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
  return foldLessonSignals(items, {
    afterFinishedTurn: afterSeq >= 0,
    unmetGoals: await placeUnmetGoals(sources, runId, afterSeq, maxSeq, em),
  });
}

/**
 * Each goal closed unmet inside the stretch, at the newest row of ANY kind written by
 * its close; a stretch that opens the thread takes one closed before its first row.
 */
async function placeUnmetGoals(
  { itemDao, goalDao }: LessonSignalSources,
  runId: string,
  afterSeq: number,
  maxSeq: number,
  em: EntityManager,
): Promise<LessonSignalGoal[]> {
  const unmet = (await goalDao.listByRun(runId, em)).filter(
    (goal) => UNMET_GOAL_STATUSES.has(goal.status) && goal.closedAt !== null,
  );
  if (unmet.length === 0) {
    return [];
  }
  const [nextRow] = await itemDao.analysisPage(
    runId,
    { afterSeq: maxSeq, maxSeq: Number.MAX_SAFE_INTEGER, limit: 1 },
    em,
  );
  const [firstRow] =
    afterSeq < 0
      ? await itemDao.analysisPage(runId, { afterSeq, maxSeq, limit: 1 }, em)
      : [];
  const placed: LessonSignalGoal[] = [];
  for (const goal of unmet) {
    const closedAt = goal.closedAt!;
    if (nextRow !== undefined && closedAt >= nextRow.createdAt) {
      continue;
    }
    const seq =
      (await itemDao.newestSeqAtOrBefore(
        runId,
        { afterSeq, maxSeq, at: closedAt },
        em,
      )) ?? firstRow?.seq;
    if (seq !== undefined) {
      placed.push({
        number: goal.number,
        text: goal.text,
        status: goal.status,
        evidence: goal.evidence,
        seq,
      });
    }
  }
  return placed;
}
