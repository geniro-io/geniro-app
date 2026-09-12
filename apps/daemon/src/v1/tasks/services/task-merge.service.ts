import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { readRunPullRequests } from '../../agents/utils/pull-request-capture';
import { TaskDao } from '../dao/task.dao';
import {
  type TaskAwaitingMergeWire,
  TASKS_AWAITING_MERGE_MAX,
  type TaskWire,
} from '../tasks.types';
import { TasksService } from './tasks.service';

/**
 * Where a card lands when the pull request it is in review for is merged.
 *
 * The counterpart of `TaskSettleService`, one step further along the same
 * life: that one moves a card to `in_review` when its agent stops, and this
 * one moves it to `done` when the work it produced lands. The card's own
 * statuses are the join — a card in review is by definition one whose outcome
 * is still somewhere else.
 *
 * It is split across two processes because the answer is, and neither half can
 * hold the other's. THIS process knows which pull requests belong to a card:
 * the run captured them out of the agent's own `gh pr create` output, and
 * nothing else on the machine could recover that. It does not know, and must
 * never claim to know, what those pull requests currently are — that is a live
 * question for GitHub, asked with the user's own `gh` login, which lives in
 * the Electron main process along with every other command this app shells
 * out to. So main sweeps {@link listAwaitingMerge}, asks GitHub, and reports a
 * merge back to {@link settleMerged}.
 *
 * What that split buys is that no merged/open state is ever STORED here —
 * `RunPullRequestSchema` gives the whole reasoning — so a card cannot be moved
 * by a stale reading of a pull request that has since been reopened.
 */
@Injectable()
export class TaskMergeService {
  private readonly logger = new Logger(TaskMergeService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly runDao: RunDao,
    private readonly tasks: TasksService,
  ) {}

  /**
   * Every card whose column could be ended by a merge, with the pull requests
   * that would end it.
   *
   * Cards with no captured pull request are dropped rather than listed empty:
   * the caller's only use for a row is to ask GitHub about it, and a row it
   * can ask nothing about is a pass it pays for and learns nothing from. That
   * is the common case, too — a card moved into review by hand, and a run
   * whose agent finished without opening anything.
   */
  async listAwaitingMerge(): Promise<TaskAwaitingMergeWire[]> {
    const em = this.em.fork();
    const tasks = await this.taskDao.listAwaitingMerge(
      TASKS_AWAITING_MERGE_MAX,
      em,
    );
    const rows: TaskAwaitingMergeWire[] = [];
    for (const task of tasks) {
      if (task.runId === null) {
        continue;
      }
      const run = await this.runDao.getById(task.runId, em);
      // A run deleted from the chat sidebar takes its captures with it. The
      // card keeps its own column until something moves it; there is simply
      // nothing left here to watch.
      if (!run) {
        continue;
      }
      const pullRequests = readRunPullRequests(run.pullRequests);
      if (pullRequests.length === 0) {
        continue;
      }
      rows.push({
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        pullRequests,
      });
    }
    return rows;
  }

  /**
   * Record that one of a card's pull requests has been merged, and end the
   * card if that is still what it is waiting for.
   *
   * A card that has MOVED ON is a no-op rather than a refusal, on
   * `TaskSettleService.settle`'s own rule: the sweep runs on a timer against a
   * board a person is using, so a card they dragged to `done` themselves, or
   * re-opened back into `todo`, is an ordinary race and not a fault. Ending it
   * anyway would drag a card out of the column they just chose for it.
   *
   * A pull request that is NOT this card's is refused, and the difference
   * matters: that is a caller reporting about the wrong card, which no timing
   * makes reachable, and moving a card on it would end work nobody finished.
   */
  async settleMerged(taskId: string, url: string): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(taskId, em);
    if (!task) {
      throw new NotFoundException('TASK_NOT_FOUND', `task ${taskId} not found`);
    }
    const run =
      task.runId === null ? null : await this.runDao.getById(task.runId, em);
    const known = readRunPullRequests(run?.pullRequests).some(
      (pullRequest) => pullRequest.url === url,
    );
    if (!known) {
      throw new BadRequestException(
        'TASK_PULL_REQUEST_UNKNOWN',
        `task ${taskId} did not open ${url}`,
      );
    }
    if (task.status !== 'in_review') {
      return this.tasks.get(taskId);
    }
    this.logger.log(
      `task ${taskId} is done — ${url} was merged while it was in review`,
    );
    return this.tasks.moveStatus(taskId, { from: 'in_review', to: 'done' });
  }
}
