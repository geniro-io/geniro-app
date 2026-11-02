import { EntityManager, type FilterQuery } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Goal } from '../../runs/entity/goal.entity';
import { idBatches } from '../utils/id-batches';

/** `run_goals` — one row per goal, kept after its run is deleted. */
@Injectable()
export class GoalDao extends BaseDao<Goal> {
  constructor(em: EntityManager) {
    super(em, Goal);
  }

  /** The run's goals in the order they were recorded. */
  async listByRun(runId: string, txEm?: EntityManager): Promise<Goal[]> {
    return this.getRepo(txEm).find({ runId }, { orderBy: { number: 'asc' } });
  }

  /** The run's highest goal number, removed goals included, so a number is never handed out twice. */
  async highestNumber(runId: string, txEm?: EntityManager): Promise<number> {
    const row = await (txEm ?? this.em.fork())
      .getKysely<{ run_goals: { run_id: string; number: number } }>({
        convertValues: false,
      })
      .selectFrom('run_goals')
      .select((eb) => eb.fn.max<number | null>('number').as('number'))
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return row?.number ?? 0;
  }

  /** The goals of these runs, or of every run of one team, as the stats count them. */
  async statusesOf(
    scope: { teamSlug: string } | { runIds: readonly string[] },
    txEm?: EntityManager,
  ): Promise<{ runId: string; status: Goal['status'] }[]> {
    const repo = this.getRepo(txEm ?? this.em.fork());
    const read = (where: FilterQuery<Goal>) =>
      repo.find(where, {
        fields: ['runId', 'status'],
        disableIdentityMap: true,
      });
    const rows =
      'teamSlug' in scope
        ? await read({ teamSlug: scope.teamSlug })
        : (
            await Promise.all(
              idBatches(scope.runIds).map((batch) =>
                read({ runId: { $in: batch } }),
              ),
            )
          ).flat();
    return rows.map((row) => ({ runId: row.runId, status: row.status }));
  }
}
