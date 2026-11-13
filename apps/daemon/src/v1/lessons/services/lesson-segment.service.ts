import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import type { RunStatusEvent } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { TeamStoreService } from '../../teams/services/team-store.service';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_DONE_QUIET_MS,
  LESSON_ROW_KINDS,
  type LessonSegmentCloser,
} from '../lessons.types';
import { offersLessons, teamLessonsOverrideOf } from '../utils/lessons-mode';
import { readLessonSignals } from '../utils/read-lesson-signals';
import { isReflectable } from '../utils/reflectable';
import { LessonEstimateService } from './lesson-estimate.service';
import { LessonRowWriter } from './lesson-row.writer';
import { LessonsConfigService } from './lessons-config.service';

const HOUR_MS = 3_600_000;
/** How far back daemon start looks for a thread whose quiet timer the last launch took with it. */
export const LESSON_BOOT_LOOKBACK_MS = 3 * 24 * HOUR_MS;
/** How long after start that look happens, so it never competes with boot. */
export const LESSON_BOOT_SWEEP_DELAY_MS = 30_000;

type QuietCloser = Extract<LessonSegmentCloser, 'done' | 'idle'>;

/**
 * Closes the stretches of a thread a reflection would read, and offers the
 * ones with a learning signal in them. Nothing here starts a reflection: an
 * offer is a `lesson_offer` row and an `offered` segment, priced, and waits
 * for the user's press.
 *
 * - Archive closes at once.
 * - A recorded outcome, a final stage done or the card moved to In review or
 *   Done close after `LESSON_DONE_QUIET_MS` with no new user message.
 * - A thread left open closes after the quiet window in the lessons settings.
 *
 * A user message cancels a waiting close; a turn geniro started itself (a
 * monitor's output) neither cancels nor arms one. Only the items past the
 * thread's `reflectedThroughSeq` belong to a stretch, and a thread has at
 * most one stretch waiting: a later close extends it.
 */
@Injectable()
export class LessonSegmentService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LessonSegmentService.name);
  private readonly timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; closer: QuietCloser }
  >();
  /** Threads a done close found still working: the next settle waits the short window. */
  private readonly doneWaiting = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private subscriptions: Subscription[] = [];
  private bootTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly tasks: TaskEventBus,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly estimates: LessonEstimateService,
    private readonly rows: LessonRowWriter,
    private readonly config: LessonsConfigService,
    @Optional() private readonly teams?: TeamStoreService,
  ) {}

  onModuleInit(): void {
    this.subscriptions = [
      this.bus.allChanged().subscribe((runs) => {
        for (const run of runs) {
          if (run.archivedAt !== null) {
            this.cancel(run.id);
            this.closeQuietly(run.id, 'archive');
          }
        }
      }),
      this.bus.allStatuses().subscribe((event) => this.onStatus(event)),
      this.bus.all().subscribe((event) => {
        if (event.item.kind === 'message' && event.item.role === 'user') {
          this.cancel(event.runId);
        }
      }),
      this.bus.allDeleted().subscribe((runId) => this.cancel(runId)),
      this.tasks.allChanges().subscribe((event) => {
        if (event.status === 'in_review' || event.status === 'done') {
          void this.onCardFinished(event.taskId);
        }
      }),
    ];
  }

  onApplicationBootstrap(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.sweep().catch((err: unknown) => {
        this.logger.warn(`lessons start-up sweep failed: ${messageOf(err)}`);
      });
    }, LESSON_BOOT_SWEEP_DELAY_MS);
    this.bootTimer.unref();
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    if (this.bootTimer !== null) {
      clearTimeout(this.bootTimer);
    }
    for (const runId of [...this.timers.keys()]) {
      this.cancel(runId);
    }
  }

  /**
   * Close the thread's stretch past its last reflection, and offer it when it
   * holds a learning signal. Null when nothing was offered: nothing new, no
   * signal, offers switched off for this thread, or a reflection already on it.
   */
  close(runId: string, closedBy: LessonSegmentCloser): Promise<LessonSegment | null> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.closeNow(runId, closedBy));
    const settled = next.catch(() => undefined);
    this.queues.set(runId, settled);
    void settled.then(() => {
      if (this.queues.get(runId) === settled) {
        this.queues.delete(runId);
      }
    });
    return next;
  }

  /** Whether offers are on for this thread, by the app's, its project's and its team's settings. */
  async offersFor(run: Run): Promise<boolean> {
    if (this.config.config.mode === 'off') {
      return false;
    }
    const project = await this.projectScope.projectOfRun(run);
    return offersLessons(
      this.config.config.mode,
      project?.lessons ?? null,
      await this.teamOverrideOf(run),
    );
  }

  /** Whether a quiet close is waiting on this thread; for specs and the settings readout. */
  waiting(runId: string): QuietCloser | null {
    return this.timers.get(runId)?.closer ?? null;
  }

  private async closeNow(
    runId: string,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonSegment | null> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null || !isReflectable(run) || run.pendingDeleteAt !== null) {
      return null;
    }
    const fromSeq = run.reflectedThroughSeq ?? -1;
    const toSeq = await this.itemDao.maxSeqExcept(run.id, LESSON_ROW_KINDS, em);
    if (toSeq <= fromSeq) {
      return null;
    }
    const open = await this.segments.openOf(run.id, em);
    if (open !== null && open.fromSeq === fromSeq && open.toSeq >= toSeq) {
      return null;
    }
    if (!(await this.offersFor(run)) || (await this.reflecting(run.id, em))) {
      return null;
    }
    const signals = await readLessonSignals(
      this.itemDao,
      run.id,
      fromSeq,
      toSeq,
      em,
    );
    if (signals.length === 0) {
      return null;
    }
    const estimate = await this.estimates.estimate(run, { fromSeq, toSeq }, {}, em);
    const fields = {
      fromSeq,
      toSeq,
      closedBy,
      closedAt: new Date(),
      signals: JSON.stringify(signals),
      status: 'offered' as const,
      reflectionRunId: null,
      estimateTokens: estimate.tokens,
      estimateUsd: estimate.usd,
    };
    let segment: LessonSegment;
    if (open === null) {
      segment = await this.segments.create(
        { runId: run.id, attempts: 0, ...fields },
        em,
      );
    } else {
      await this.segments.updateById(open.id, fields, em);
      segment = Object.assign(open, fields);
    }
    await this.rows.write(run.id, {
      kind: 'lesson_offer',
      payload: {
        segmentId: segment.id,
        fromSeq,
        toSeq,
        closedBy,
        signals: signals.map(({ kind, seq }) => ({ kind, seq })),
        estimate,
      },
    });
    return segment;
  }

  private onStatus(event: RunStatusEvent): void {
    if (event.outcome?.source === 'recorded') {
      this.arm(event.runId, 'done');
    }
    if (
      event.stages !== undefined &&
      event.stages !== null &&
      event.stages.stages.length > 0 &&
      event.stages.current === null
    ) {
      this.arm(event.runId, 'done');
    }
    if (
      event.status === null ||
      !isTerminalRunStatus(event.status) ||
      event.hostTurn === true ||
      event.restored === true ||
      event.housekeeping === true
    ) {
      return;
    }
    if (this.doneWaiting.delete(event.runId)) {
      this.arm(event.runId, 'done');
      return;
    }
    if (this.timers.get(event.runId)?.closer !== 'done') {
      this.arm(event.runId, 'idle');
    }
  }

  private async onCardFinished(taskId: string): Promise<void> {
    try {
      const runs = await this.runDao.listOfTask(taskId, this.em.fork());
      for (const run of runs) {
        if (run.archivedAt === null) {
          this.arm(run.id, 'done');
        }
      }
    } catch (err) {
      this.logger.warn(`runs of card ${taskId} not read: ${messageOf(err)}`);
    }
  }

  private arm(runId: string, closer: QuietCloser, delayMs?: number): void {
    this.cancel(runId);
    const wait =
      delayMs ??
      (closer === 'done'
        ? LESSON_DONE_QUIET_MS
        : this.config.config.quietWindowHours * HOUR_MS);
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      void this.fire(runId, closer);
    }, wait);
    timer.unref();
    this.timers.set(runId, { timer, closer });
  }

  private cancel(runId: string): void {
    const waiting = this.timers.get(runId);
    if (waiting !== undefined) {
      clearTimeout(waiting.timer);
      this.timers.delete(runId);
    }
    this.doneWaiting.delete(runId);
  }

  private async fire(runId: string, closer: QuietCloser): Promise<void> {
    try {
      const run = await this.runDao.getById(runId, this.em.fork());
      if (run === null || run.archivedAt !== null) {
        return;
      }
      if (!isTerminalRunStatus(run.status)) {
        if (closer === 'done') {
          this.doneWaiting.add(runId);
        }
        return;
      }
      await this.close(runId, closer);
    } catch (err) {
      this.logger.warn(`lessons close of ${runId} failed: ${messageOf(err)}`);
    }
  }

  private closeQuietly(runId: string, closedBy: LessonSegmentCloser): void {
    void this.close(runId, closedBy).catch((err: unknown) => {
      this.logger.warn(`lessons close of ${runId} failed: ${messageOf(err)}`);
    });
  }

  /** Re-arms the quiet closes the last launch took with it, and closes the ones already due. */
  private async sweep(): Promise<void> {
    if (this.config.config.mode === 'off') {
      return;
    }
    const now = Date.now();
    const windowMs = this.config.config.quietWindowHours * HOUR_MS;
    const runs = await this.runDao.listLessonCandidates(
      new Date(now - LESSON_BOOT_LOOKBACK_MS),
      this.em.fork(),
    );
    for (const run of runs) {
      if (!isTerminalRunStatus(run.status) || this.timers.has(run.id)) {
        continue;
      }
      const quietFor = now - run.updatedAt.getTime();
      if (quietFor >= windowMs) {
        await this.close(run.id, 'idle').catch((err: unknown) => {
          this.logger.warn(`lessons close of ${run.id} failed: ${messageOf(err)}`);
        });
      } else {
        this.arm(run.id, 'idle', windowMs - quietFor);
      }
    }
  }

  private async reflecting(runId: string, em: EntityManager): Promise<boolean> {
    const reflections = await this.runDao.listLessonReflectionsOf(runId, em);
    return reflections.some((run) => !isTerminalRunStatus(run.status));
  }

  private async teamOverrideOf(run: Run): Promise<'on' | 'off' | null> {
    if (run.teamId === null) {
      return null;
    }
    if (this.teams !== undefined) {
      try {
        return (await this.teams.get(run.teamId)).team.lessons ?? null;
      } catch {
        return teamLessonsOverrideOf(run.teamSnapshot);
      }
    }
    return teamLessonsOverrideOf(run.teamSnapshot);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
