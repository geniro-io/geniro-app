import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { ChatService } from '../../agents/services/chat.service';
import { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import { ProjectDao } from '../../projects/dao/project.dao';
import { taskIdentifier } from '../../projects/utils/project-key';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { Task } from '../../tasks/entity/task.entity';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { SystemAnalysisEventBus } from './system-analysis-events.bus';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What became of the cards a system analysis's Implement right away asked to
 * start. The analysis chat is hidden, so nobody would learn a start failed:
 * each start, and each failure the drain reports, is written into it as a
 * notice and onto its item in the ledger. No manager is woken — the start was
 * the user's own press.
 */
@Injectable()
export class SystemAnalysisStartsService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SystemAnalysisStartsService.name);
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly taskEvents: TaskEventBus,
    private readonly chats: ChatService,
    private readonly ledger: TeamRecommendationDao,
    private readonly notices: RunNoticeWriter,
    private readonly projectDao: ProjectDao,
    private readonly events: SystemAnalysisEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.taskEvents.allChanges().subscribe(() => {
        void this.reportStarted();
      }),
      this.taskEvents.startFailures().subscribe((failure) => {
        void this.reportFailed(failure).catch((error: unknown) => {
          this.logger.warn(
            `start failure of ${failure.taskId} not reported: ${messageOf(error)}`,
          );
        });
      }),
    );
  }

  onApplicationBootstrap(): void {
    void this.reportStarted();
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  /** Every card an analysis asked to start that has started and not been told. */
  async reportStarted(): Promise<void> {
    try {
      const em = this.em.fork();
      for (const task of await this.taskDao.listStartedForAnalysis(em)) {
        await this.reportOne(task);
      }
    } catch (error) {
      this.logger.warn(`analysis starts not reported: ${messageOf(error)}`);
    }
  }

  private async reportOne(task: Task): Promise<void> {
    const analysisRunId = task.startRequestedByRunId;
    if (analysisRunId === null || task.runId === null) {
      return;
    }
    const em = this.em.fork();
    if (!(await this.taskDao.claimStartReport(task.id, analysisRunId, em))) {
      return;
    }
    const item = await this.ledger.byTaskId(task.id, em);
    if (item !== null) {
      const key = await this.keyOf(task, em);
      await this.chats.recordAnalysisRow(
        item.chatRunId,
        'recommendation_outcome',
        {
          cardSeq: item.cardSeq,
          outcomes: [
            { id: item.itemId, status: 'applied', note: `started ${key}` },
          ],
        },
      );
      await this.ledger.markApplied(item.chatRunId, item.cardSeq, item.itemId, {
        taskId: task.id,
        applyAction: 'started',
      });
      this.events.publishChanged(item.chatRunId);
    }
    await this.notices.info(analysisRunId, `Started "${task.title}"`);
  }

  async reportFailed(failure: {
    taskId: string;
    byRunId: string;
    title: string;
    reason: string;
  }): Promise<void> {
    const em = this.em.fork();
    const item = await this.ledger.byTaskId(failure.taskId, em);
    if (item !== null) {
      const task = await this.taskDao.getById(failure.taskId, em);
      const key = task === null ? failure.taskId : await this.keyOf(task, em);
      await this.chats.recordAnalysisRow(
        item.chatRunId,
        'recommendation_outcome',
        {
          cardSeq: item.cardSeq,
          outcomes: [
            {
              id: item.itemId,
              status: 'failed',
              note: `could not start ${key}: ${failure.reason}`.slice(0, 600),
            },
          ],
        },
      );
      await this.ledger.markApplied(item.chatRunId, item.cardSeq, item.itemId, {
        taskId: failure.taskId,
        applyAction: 'filed',
      });
      this.events.publishChanged(item.chatRunId);
    }
    await this.notices.warn(
      failure.byRunId,
      `Could not start "${failure.title}": ${failure.reason}`,
      'Start failed',
    );
  }

  /** The card's ticket key, or its task id when its project has none. */
  private async keyOf(task: Task, em: EntityManager): Promise<string> {
    const project = await this.projectDao.getById(task.projectId, em);
    return (
      (project === null
        ? null
        : taskIdentifier(project.taskKey, task.number)) ?? task.id
    );
  }
}
