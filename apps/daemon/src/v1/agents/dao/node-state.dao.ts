import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { NodeState } from '../../runs/entity/node-state.entity';
import type { NodeStatus } from '../../runs/runs.types';

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

  async listByRun(runId: string, txEm?: EntityManager): Promise<NodeState[]> {
    return this.getRepo(txEm).find({ runId });
  }

  /** Seed one `pending` row per graph node when a workflow run starts. */
  async createPending(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    this.getRepo(txEm).create(
      { runId, nodeId, status: 'pending' },
      { partial: true },
    );
    await em.flush();
  }

  /**
   * Transition a node's lifecycle status (composite PK, so `BaseDao.updateById`
   * does not apply). An absent patch field leaves the stored value untouched.
   */
  async setStatus(
    runId: string,
    nodeId: string,
    patch: {
      status: NodeStatus;
      startedAt?: number;
      endedAt?: number;
      error?: string | null;
    },
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const existing = await repo.findOne({ runId, nodeId });
    if (existing) {
      existing.status = patch.status;
      if (patch.startedAt !== undefined) {
        existing.startedAt = patch.startedAt;
      }
      if (patch.endedAt !== undefined) {
        existing.endedAt = patch.endedAt;
      }
      if (patch.error !== undefined) {
        existing.error = patch.error;
      }
    } else {
      repo.create(
        {
          runId,
          nodeId,
          status: patch.status,
          startedAt: patch.startedAt ?? null,
          endedAt: patch.endedAt ?? null,
          error: patch.error ?? null,
        },
        { partial: true },
      );
    }
    await em.flush();
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
