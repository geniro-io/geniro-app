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
      const project = await this.projectDao.getById(task.projectId, em);
      const key =
        (project === null
          ? null
          : taskIdentifier(project.taskKey, task.number)) ?? task.id;
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
    }
    await this.notices.info(analysisRunId, `Started "${task.title}"`);
  }

  async reportFailed(failure: {
    taskId: string;
    byRunId: string;
    title: string;
    reason: string;
  }): Promise<void> {
    const item = await this.ledger.byTaskId(failure.taskId, this.em.fork());
    if (item !== null) {
      await this.chats.recordAnalysisRow(
        item.chatRunId,
        'recommendation_outcome',
        {
          cardSeq: item.cardSeq,
          outcomes: [
            {
              id: item.itemId,
              status: 'failed',
              note: `the card was filed but could not be started: ${failure.reason}`.slice(
                0,
                600,
              ),
            },
          ],
        },
      );
      await this.ledger.markApplied(item.chatRunId, item.cardSeq, item.itemId, {
        taskId: failure.taskId,
        applyAction: 'filed',
      });
    }
    await this.notices.warn(
      failure.byRunId,
      `Could not start "${failure.title}": ${failure.reason}`,
      'Start failed',
    );
  }
}
