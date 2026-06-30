import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Item } from '../../runs/entity/item.entity';

@Injectable()
export class ItemDao extends BaseDao<Item> {
  constructor(em: EntityManager) {
    super(em, Item);
  }

  /**
   * Ordered transcript for a run. `afterSeq` is the replay cursor: pass the
   * highest seq the client has already rendered to fetch only newer items
   * (default -1 returns the whole transcript, since seq starts at 0).
   */
  async getByRun(
    runId: string,
    afterSeq = -1,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    return this.getRepo(txEm).find(
      { runId, seq: { $gt: afterSeq } },
      { orderBy: { seq: 'asc' } },
    );
  }

  /** Highest seq persisted for a run, or -1 when the run has no items yet. */
  async maxSeq(runId: string, txEm?: EntityManager): Promise<number> {
    const last = await this.getRepo(txEm).findOne(
      { runId },
      { orderBy: { seq: 'desc' } },
    );
    return last ? last.seq : -1;
  }
}
