import { EntityManager, type FilterQuery } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { LabelInstruction } from '../entity/label-instruction.entity';

@Injectable()
export class LabelInstructionDao extends BaseDao<LabelInstruction> {
  constructor(em: EntityManager) {
    super(em, LabelInstruction);
  }

  /**
   * `projectId` null means "every board" — every row on the machine, global
   * and project-scoped alike, which is what the task board's unscoped caller
   * wants (the all-projects view, and label suggestions). A given project id
   * narrows to GLOBAL rows plus that project's own, never another board's.
   */
  async listForScope(
    projectId: string | null,
    txEm?: EntityManager,
  ): Promise<LabelInstruction[]> {
    const where: FilterQuery<LabelInstruction> =
      projectId === null ? {} : { $or: [{ projectId: null }, { projectId }] };
    return this.getAll(where, {}, txEm);
  }

  /** Exact scope match — the duplicate check, which cares about ONE row's scope. */
  async findByScopeAndLabel(
    projectId: string | null,
    label: string,
    txEm?: EntityManager,
  ): Promise<LabelInstruction | null> {
    return this.getOne(
      { projectId, label } as FilterQuery<LabelInstruction>,
      {},
      txEm,
    );
  }

  /**
   * Every row a task carrying these labels should see: global rows, plus this
   * one project's own. Never another project's.
   *
   * The board's label suggestions mirror this rule (`labelsFor` in
   * apps/ui/src/renderer/tasks/Tasks.tsx); a change here is mirrored there.
   */
  async matching(
    projectId: string,
    labels: readonly string[],
    txEm?: EntityManager,
  ): Promise<LabelInstruction[]> {
    if (labels.length === 0) {
      return [];
    }
    return this.getAll(
      {
        label: { $in: [...labels] },
        $or: [{ projectId: null }, { projectId }],
      } as FilterQuery<LabelInstruction>,
      {},
      txEm,
    );
  }

  /**
   * Remove every instruction scoped to a project — its half of the project
   * delete, the same shape `TaskDao.deleteForProject` takes: soft-deleted,
   * since nothing here cascades and a project's delete is itself reversible.
   */
  async deleteForProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.delete({ projectId }, txEm);
  }
}
