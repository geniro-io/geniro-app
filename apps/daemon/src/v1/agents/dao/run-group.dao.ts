import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { RunGroup } from '../../runs/entity/run-group.entity';

@Injectable()
export class RunGroupDao extends BaseDao<RunGroup> {
  constructor(em: EntityManager) {
    super(em, RunGroup);
  }

  /**
   * Every group in sidebar order.
   *
   * `position` alone is not a total order — two rows can hold the same number
   * for as long as it takes a reorder to renumber them — so `createdAt` breaks
   * the tie and the list a client renders is never arbitrary. Identity-map
   * tracking is left ON, unlike the run list paths: the reorder path mutates
   * exactly the rows this returns.
   */
  async listOrdered(txEm?: EntityManager): Promise<RunGroup[]> {
    return this.getRepo(txEm).find(
      {},
      { orderBy: { position: 'asc', createdAt: 'asc' } },
    );
  }
}
