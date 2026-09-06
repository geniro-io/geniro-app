import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Task } from '../entity/task.entity';
import type { TaskStatus } from '../tasks.types';

@Injectable()
export class TaskDao extends BaseDao<Task> {
  constructor(em: EntityManager) {
    super(em, Task);
  }

  /**
   * One project's board, in the order the columns render it: by status, then
   * by position within the column.
   */
  async listForProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<Task[]> {
    return this.getAll(
      { projectId },
      { orderBy: { status: 'asc', position: 'asc' } },
      txEm,
    );
  }

  /**
   * The tasks sitting in one project's intake column, oldest first — what the
   * autopilot picks up, and the reason `status` carries its own index.
   */
  async listInStatus(
    projectId: string,
    status: TaskStatus,
    txEm?: EntityManager,
  ): Promise<Task[]> {
    return this.getAll(
      { projectId, status },
      { orderBy: { position: 'asc' } },
      txEm,
    );
  }

  /**
   * How many tasks a project holds. Read before a project delete, so the
   * acknowledgement can say how many cards went with the board.
   */
  async countInProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.count({ projectId }, txEm);
  }

  /** How many tasks a column already holds. */
  async countInStatus(
    projectId: string,
    status: TaskStatus,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.count({ projectId, status }, txEm);
  }

  /**
   * The position to give the next card appended to a column.
   *
   * The COUNT of the column is the wrong answer and was the first one here: a
   * soft-deleted card keeps its position but leaves the count, and a card moved
   * to another column leaves its old slot behind too — so counting hands the
   * next card a position a live card already holds, and `orderBy: position`
   * then leaves those two to SQLite's tie-break. Measured: three live rows
   * sharing position 2 after one delete and one move-out.
   *
   * Reading the maximum instead is collision-free by construction, because a
   * position is only ever appended. It leaves GAPS where the count did not,
   * which is the trade — nothing here renumbers, so the column is monotonic
   * rather than contiguous.
   */
  async nextPositionIn(
    projectId: string,
    status: TaskStatus,
    txEm?: EntityManager,
  ): Promise<number> {
    const last = await this.getOne(
      { projectId, status },
      { orderBy: { position: 'desc' } },
      txEm,
    );
    return (last?.position ?? -1) + 1;
  }

  /**
   * Remove every task belonging to a project.
   *
   * Soft-delete, like every other default delete path here: `BaseDao.delete`
   * stamps `deletedAt` and the `softDelete` filter hides the rows from every
   * read. Nothing in this daemon declares a cascade, so the project service
   * calls this explicitly rather than leaving the rows behind on a board that
   * no longer exists.
   */
  async deleteForProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.delete({ projectId }, txEm);
  }
}
