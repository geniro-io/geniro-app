import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { readRunPullRequests } from '../../agents/utils/pull-request-capture';
import { TaskDao } from '../dao/task.dao';
import type { Task } from '../entity/task.entity';
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

  /**
   * Where the last CAPPED sweep's handout ended — the last card it named, by
   * the listing's own sort key — so the next sweep starts after it.
   *
   * A pull request that stays open, or is closed without merging, leaves its
   * card in review for as long as nobody moves it, and nothing a sweep does
   * changes that card's `updatedAt`. With more such cards than the cap, a
   * handout that always began at the oldest named the same cards every time
   * and never reached the rest. Resuming walks the whole column in turn.
   *
   * In memory, deliberately: a restart starting again from the oldest costs
   * one repeated window, and nothing about it needs to survive one.
   */
  private resumeAfter: { at: number; id: string } | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly runDao: RunDao,
    private readonly tasks: TasksService,
  ) {}

  /**
   * Every card whose column could be ended by a merge, with the pull requests
   * that would end it — at most {@link TASKS_AWAITING_MERGE_MAX} of them.
   *
   * Cards with no captured pull request are dropped rather than listed empty:
   * the caller's only use for a row is to ask GitHub about it, and a row it
   * can ask nothing about is a pass it pays for and learns nothing from. That
   * is the common case, too — a card moved into review by hand, and a run
   * whose agent finished without opening anything. They are dropped BEFORE the
   * cap: capped first, a column holding that many such cards filled every
   * window and hid the cards that did have something to watch.
   *
   * ONE query for every card's pull requests — a run deleted from the chat
   * sidebar takes its captures with it and is simply absent from the answer.
   */
  async listAwaitingMerge(): Promise<TaskAwaitingMergeWire[]> {
    const em = this.em.fork();
    const tasks = await this.taskDao.listAwaitingMerge(em);
    const byRun = await this.runDao.pullRequestsOf(
      tasks.flatMap((task) => (task.runId === null ? [] : [task.runId])),
      em,
    );
    const watchable = tasks.flatMap((task) => {
      const pullRequests =
        task.runId === null ? undefined : byRun.get(task.runId);
      return pullRequests === undefined ? [] : [{ task, pullRequests }];
    });
    return this.nextWindow(watchable).map(({ task, pullRequests }) => ({
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      pullRequests,
    }));
  }

  /**
   * This sweep's share of the watchable cards: all of them while they fit
   * under the cap, else the next {@link TASKS_AWAITING_MERGE_MAX} after where
   * the last sweep stopped, wrapping round to the oldest.
   *
   * Compared by sort key rather than looked up by id, so a card that left the
   * column since — merged, or moved by hand — does not lose the place.
   */
  private nextWindow<Row extends { task: Pick<Task, 'id' | 'updatedAt'> }>(
    rows: readonly Row[],
  ): Row[] {
    if (rows.length <= TASKS_AWAITING_MERGE_MAX) {
      this.resumeAfter = null;
      return [...rows];
    }
    const cursor = this.resumeAfter;
    const start =
      cursor === null
        ? 0
        : rows.findIndex(({ task }) => sortsAfter(task, cursor));
    const from = start === -1 ? 0 : start;
    const window = [...rows.slice(from), ...rows.slice(0, from)].slice(
      0,
      TASKS_AWAITING_MERGE_MAX,
    );
    const last = window[window.length - 1]!.task;
    this.resumeAfter = { at: last.updatedAt.getTime(), id: last.id };
    return window;
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

/**
 * Whether a card sorts after the cursor in `TaskDao.listAwaitingMerge`'s own
 * order — `updatedAt`, then `id` — so the resume and the listing agree.
 */
function sortsAfter(
  task: Pick<Task, 'id' | 'updatedAt'>,
  cursor: { at: number; id: string },
): boolean {
  const at = task.updatedAt.getTime();
  return at > cursor.at || (at === cursor.at && task.id > cursor.id);
}
