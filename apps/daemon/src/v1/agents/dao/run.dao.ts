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
      // Read-only list paths: skip identity-map tracking so a long run history
      // doesn't accumulate managed entities in the forked EM (see item.dao).
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Forget the snapshotted custom instructions on every run still holding any,
   * and report how many were cleared.
   *
   * EVERY run, not only the unsettled ones. A settled chat is a chat whose last
   * turn ended, not one that is closed — the user can send it another message
   * at any time, and that turn would re-send the text they retracted. Limiting
   * this to in-flight runs would leave the retention it exists to end.
   *
   * The cost is deliberate and is the whole reason this is a BUTTON rather
   * than something clearing the settings box does on its own: it discards the
   * per-run snapshot, so an old chat continued afterwards runs without the
   * instructions it started under.
   */
  async forgetCustomInstructions(txEm?: EntityManager): Promise<number> {
    return this.getRepo(txEm).nativeUpdate(
      { customInstructions: { $ne: null } },
      { customInstructions: null },
    );
  }

  /**
   * Chat runs stuck in a non-terminal `running` state — used by the boot-time
   * reconcile to close runs a crash / SIGKILL / restart left mid-turn.
   */
  async listRunningChats(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: null, status: 'running' },
      { disableIdentityMap: true },
    );
  }

  /**
   * Release every run filed under a group — used when the group is deleted.
   *
   * The runs are UNTOUCHED apart from the column: a folder disappearing must
   * never take a conversation with it, which is the whole reason this exists
   * instead of a cascade. Both run kinds are swept, since the sidebar files
   * chats and workflow runs into the same groups.
   */
  async clearGroup(groupId: string, txEm?: EntityManager): Promise<number> {
    const em = txEm ?? this.em;
    const runs = await this.getRepo(txEm).find({ groupId });
    for (const run of runs) {
      run.groupId = null;
    }
    await em.flush();
    return runs.length;
  }

  /** Workflow runs (graph executions), newest first. */
  async listWorkflowRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: { $ne: null } },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Workflow runs left in a non-terminal state by a crash / SIGKILL — the
   * graph executor's boot reconcile closes them (pending counts too: a
   * workflow run is created `running`, so anything non-terminal is orphaned).
   */
  async listRunningWorkflowRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      {
        workflowId: { $ne: null },
        status: { $in: ['pending', 'running'] },
      },
      { disableIdentityMap: true },
    );
  }
}
