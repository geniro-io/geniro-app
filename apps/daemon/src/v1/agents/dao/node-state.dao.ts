import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { NodeState } from '../../runs/entity/node-state.entity';

@Injectable()
export class NodeStateDao extends BaseDao<NodeState> {
  constructor(em: EntityManager) {
    super(em, NodeState);
  }

  async getByRunNode(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<NodeState | null> {
    return this.getRepo(txEm).findOne({ runId, nodeId });
  }

  /**
   * Create or update the per-node state, persisting the CLI session id used for
   * `--resume`. Composite-PK entity, so `BaseDao.getById` (which keys on `id`)
   * does not apply — this upsert keys on (runId, nodeId).
   */
  async saveSessionId(
    runId: string,
    nodeId: string,
    agentSessionId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const existing = await repo.findOne({ runId, nodeId });
    if (existing) {
      existing.agentSessionId = agentSessionId;
    } else {
      repo.create(
        { runId, nodeId, status: 'running', agentSessionId },
        { partial: true },
      );
    }
    await em.flush();
  }
}
