import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Run } from '../../runs/entity/run.entity';

@Injectable()
export class RunDao extends BaseDao<Run> {
  constructor(em: EntityManager) {
    super(em, Run);
  }

  /** Single-agent chat runs (no workflow), newest first. */
  async listChats(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: null },
      { orderBy: { createdAt: 'desc' } },
    );
  }
}
