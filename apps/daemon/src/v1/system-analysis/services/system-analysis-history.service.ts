import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import { SYSTEM_LEDGER_SLUG } from '../../stats/stats.types';
import { recommendationStatusOf } from '../../stats/utils/team-history-fold';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { SystemHistory } from '../system-analysis.types';

/**
 * What every earlier system analysis proposed and what became of it, for
 * `read_analyzed_thread view=history` on a system turn: each item's mark, what
 * its press did, and where its board card stands now — so a recurring problem
 * is written up as "proposed earlier, still happening", never filed twice.
 */
@Injectable()
export class SystemAnalysisHistoryService {
  constructor(
    private readonly em: EntityManager,
    private readonly ledger: TeamRecommendationDao,
    private readonly runDao: RunDao,
    private readonly taskDao: TaskDao,
  ) {}

  async read(readerRunId: string): Promise<SystemHistory> {
    const em = this.em.fork();
    const rows = await this.ledger.rowsOf(SYSTEM_LEDGER_SLUG, em);
    const liveChats = await this.runDao.existingIds(
      rows.map((row) => row.chatRunId),
      em,
    );
    const taskIds = rows.flatMap((row) =>
      row.taskId === null ? [] : [row.taskId],
    );
    const tasks = new Map(
      (taskIds.length === 0
        ? []
        : await this.taskDao.listByIds(taskIds, em)
      ).map((task) => [task.id, task]),
    );
    const cardKey = (row: { chatRunId: string; cardSeq: number }): string =>
      JSON.stringify([row.chatRunId, row.cardSeq]);
    const appliedCards = new Set(
      rows.flatMap((row) =>
        row.selectedAt === null && row.applyAction === null
          ? []
          : [cardKey(row)],
      ),
    );
    const items: SystemHistory['items'] = rows
      .filter((row) => row.chatRunId !== readerRunId)
      .map((row) => {
        const task = row.taskId === null ? undefined : tasks.get(row.taskId);
        return {
          chatRunId: row.chatRunId,
          cardSeq: row.cardSeq,
          filedAt: row.filedAt.toISOString(),
          id: row.itemId,
          target: row.target,
          location: row.location,
          title: row.title,
          rootCause: row.rootCause,
          status: recommendationStatusOf(
            row,
            liveChats.has(row.chatRunId),
            appliedCards.has(cardKey(row)),
          ),
          note: row.outcomeNote,
          applyAction: row.applyAction,
          card:
            row.taskId === null
              ? null
              : {
                  taskId: row.taskId,
                  column: task?.status ?? null,
                  deleted: task === undefined,
                },
        };
      })
      .reverse();
    return {
      analyses: new Set(items.map((item) => item.chatRunId)).size,
      items,
    };
  }
}
