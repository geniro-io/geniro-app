import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { asRecord } from '../utils/json-util';
import {
  foldTaskLists,
  readRunTaskList,
  writeRunTaskList,
} from '../utils/task-list-fold';
import { AgentEventBus } from './agent-events.bus';

/**
 * One `Item.payload` as an object, or null.
 *
 * The column is JSON TEXT — only the wire projection parses it — so every reader
 * of a raw row does this for itself, the same two lines
 * {@link PullRequestCaptureService} carries for the same reason.
 */
function parseRow(payload: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * The agent's own task list, folded onto the run row and announced.
 *
 * The WHY is in `utils/task-list-fold.ts`; this is the pass that runs it. It is
 * a SUBSCRIBER rather than a call from the turn path, for the reason the stats
 * recorder and the pull-request capture are: the bus is where the chat path and
 * the graph executor converge on one `persistItemAndEmit`, so neither has to
 * remember to do this, and a workflow node's list is covered by the same code.
 *
 * Two properties shape it:
 *
 * - It **re-folds the whole run** on every announcement rather than keeping a
 *   marker. That is affordable precisely because these rows are few (a few dozen
 *   in the longest conversation, against the 14k `tool_result` rows the
 *   pull-request scan has to page through), and it buys correctness with nothing
 *   to keep in step: a daemon restarted mid-conversation and a run created
 *   before this column existed both fold exactly as a live one does, so the
 *   backfill is free rather than a migration.
 * - It **never fails a caller**. A subscriber that rejects takes the RxJS stream
 *   down with it, which would cost far more than a chip showing an old count, so
 *   every error is logged and swallowed per run.
 */
@Injectable()
export class TaskListCaptureService implements OnModuleInit {
  private readonly logger = new Logger(TaskListCaptureService.name);

  constructor(
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
  ) {}

  /**
   * Fold on every `task_list` row, which is the only kind that can change the
   * answer — unlike the pull-request capture next door, which runs on a turn's
   * END because its evidence is scattered through the transcript. A conversation
   * whose agent keeps no checklist therefore costs nothing at all here.
   */
  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      if (event.item.kind !== 'task_list') {
        return;
      }
      void this.captureAndAnnounce(event.runId);
    });
  }

  /**
   * Re-fold one run's list and tell every window what it holds now.
   *
   * `status: null`, like the activity, hold and pull-request announces beside
   * it: this says what the run HAS, never whether it is still going. A status
   * asserted by an event that never read the run is the defect the nullable
   * status exists to prevent.
   *
   * Silent when the fold did not MOVE. A single announcement routinely names a
   * row whose status did not change, and every chat with a checklist would
   * otherwise broadcast its whole list to every window on every tool call.
   */
  private async captureAndAnnounce(runId: string): Promise<void> {
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null) {
        return;
      }
      const rows = await this.itemDao.taskListRows(runId, em);
      const folded = foldTaskLists(
        rows.map((row) => ({
          nodeId: row.nodeId,
          payload: parseRow(row.payload),
        })),
      );
      const taskList = writeRunTaskList(folded);
      if (taskList === run.taskList) {
        return;
      }
      await this.runDao.updateById(runId, { taskList }, em);
      run.taskList = taskList;
      // Read back through the same parser the wire projection uses, so a client
      // is handed exactly the shape a later `GET /v1/chats` would give it —
      // announcing the in-memory fold instead is how the live value and the
      // refetched one come to differ.
      this.bus.publishRunStatus({
        runId,
        status: null,
        taskList: readRunTaskList(taskList),
      });
    } catch (error) {
      this.logger.warn(
        `run ${runId}: could not capture the task list: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
