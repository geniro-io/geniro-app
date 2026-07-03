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

  /**
   * Chat runs stuck in a non-terminal `running` state — used by the boot-time
   * reconcile to close runs a crash / SIGKILL / restart left mid-turn.
   */
  async listRunningChats(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find({ workflowId: null, status: 'running' });
  }

  /** Workflow runs (graph executions), newest first. */
  async listWorkflowRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: { $ne: null } },
      { orderBy: { createdAt: 'desc' } },
    );
  }

  /**
   * Workflow runs left in a non-terminal state by a crash / SIGKILL — the
   * graph executor's boot reconcile closes them (pending counts too: a
   * workflow run is created `running`, so anything non-terminal is orphaned).
   */
  async listRunningWorkflowRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find({
      workflowId: { $ne: null },
      status: { $in: ['pending', 'running'] },
    });
  }
}
