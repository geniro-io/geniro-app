import type { EntityData } from '@mikro-orm/core';
import { EntityManager, type FilterQuery } from '@mikro-orm/sqlite';
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
   * The card holding one run, if any still does.
   *
   * The run<->task edge has an end on each row, and this reads it from the RUN
   * side — which is what a `run_deleted` announcement gives you, the run row
   * itself being gone by the time it fires. Null is an ordinary answer: most
   * runs are chats that never belonged to a card.
   */
  async findByRunId(runId: string, txEm?: EntityManager): Promise<Task | null> {
    return this.getOne({ runId }, {}, txEm);
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

  /**
   * The position to give the next card appended to a column.
   *
   * Counting the column is the wrong answer: a soft-deleted card keeps its
   * position but leaves the count, and a card moved to another column leaves
   * its old slot behind — so a count hands the next card a position a live
   * card still holds, and `orderBy: position` then leaves those two to
   * SQLite's tie-break. Reading the maximum cannot collide, at the price of
   * gaps, since nothing here renumbers.
   *
   * Projected to `position` alone, like `ItemDao.maxSeq`: hydrating the whole
   * newest row — `description` runs to `TASK_DESCRIPTION_MAX` — to read one
   * integer is waste, and attaching it to the caller's UnitOfWork is a side
   * effect this read has no business having.
   */
  async nextPositionIn(
    projectId: string,
    status: TaskStatus,
    txEm?: EntityManager,
  ): Promise<number> {
    const last = await this.getOne(
      { projectId, status },
      {
        orderBy: { position: 'desc' },
        fields: ['position'],
        disableIdentityMap: true,
      },
      txEm,
    );
    return (last?.position ?? -1) + 1;
  }

  /**
   * Move one card between columns in a single conditional UPDATE, reporting
   * whether it landed.
   *
   * The `status` in the WHERE clause is the entire mechanism. Two callers that
   * both read the card in `todo` both send `from: 'todo'`, and the database
   * applies exactly one of them — the loser matches no row and gets `false`.
   * Comparing in JavaScript instead cannot hold that line: the position lookup
   * between the read and the write is an `await`, and the autopilot's sweep is
   * precisely a caller that starts several moves inside one tick.
   *
   * `deletedAt` is named explicitly because a native update runs beneath the
   * `softDelete` filter; without it this would move a card someone deleted.
   * `updatedAt` likewise — the `onUpdate` hook belongs to the UnitOfWork and
   * does not fire here.
   */
  async compareAndSetStatus(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    position: number,
    at: Date,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const affected = await this.getRepo(txEm).nativeUpdate(
      { id: taskId, status: from, deletedAt: null } as FilterQuery<Task>,
      { status: to, position, updatedAt: at } as EntityData<Task>,
    );
    return affected === 1;
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
