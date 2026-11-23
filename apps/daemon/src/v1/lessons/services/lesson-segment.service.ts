import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import { GoalDao } from '../../agents/dao/goal.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ArchiveLessonsRegistry } from '../../agents/services/archive-lessons.registry';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TeamStoreService } from '../../teams/services/team-store.service';
import {
  LessonSegmentDao,
  RUNNING_SEGMENT_STATUSES,
} from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_ROW_KINDS,
  LESSON_SEGMENT_STATUSES,
  type LessonEstimateQuery,
  type LessonSegmentCloser,
  type LessonSegmentListQuery,
  type LessonSegmentStatus,
  type LessonSegmentWire,
  type LessonSignal,
  type ThreadLessonEstimate,
} from '../lessons.types';
import { offersLessons, teamLessonsOverrideOf } from '../utils/lessons-mode';
import {
  type LessonSignalSources,
  readLessonSignals,
} from '../utils/read-lesson-signals';
import { isReflectable } from '../utils/reflectable';
import { LessonEstimateService } from './lesson-estimate.service';
import { LessonSpendService } from './lesson-spend.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

const DEFAULT_LIST_STATUSES: readonly LessonSegmentStatus[] =
  RUNNING_SEGMENT_STATUSES.concat('queued');

/**
 * Closes the stretch of a thread a reflection reads and queues it for
 * `LessonAutoRunner`. Archiving a thread closes its stretch at once, as the
 * archive dialog chose (`ArchiveLessonsRegistry`), else as the lessons
 * settings say; "Reflect now" starts its own reflection. Only the items past
 * the thread's `reflectedThroughSeq` belong to a stretch, a stretch with no
 * learning signal is never queued, and a thread has at most one stretch
 * queued: a later close extends it.
 */
@Injectable()
export class LessonSegmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LessonSegmentService.name);
  private readonly queues = new Map<string, Promise<unknown>>();
  private subscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly goalDao: GoalDao,
    private readonly bus: AgentEventBus,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly estimates: LessonEstimateService,
    private readonly config: LessonsConfigService,
    private readonly events: LessonsEventBus,
    private readonly spending: LessonSpendService,
    @Optional() private readonly teams?: TeamStoreService,
    @Optional() private readonly archiveChoices?: ArchiveLessonsRegistry,
  ) {}

  onModuleInit(): void {
    this.subscription = this.bus.allChanged().subscribe((runs) => {
      for (const run of runs) {
        if (run.archivedAt !== null) {
          void this.close(run.id, 'archive').catch((err: unknown) => {
            this.logger.warn(
              `lessons close of ${run.id} failed: ${messageOf(err)}`,
            );
          });
        }
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * Queue the thread's stretch past its last reflection when it holds a
   * learning signal. Null when nothing was queued: nothing new, no signal,
   * Lessons off for this thread, or a reflection already on it.
   */
  close(
    runId: string,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonSegment | null> {
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

  /** Whether reflections run on this thread, by the app's, its project's and its team's settings. */
  async lessonsOnFor(run: Run): Promise<boolean> {
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

  async list(query: LessonSegmentListQuery): Promise<LessonSegmentWire[]> {
    const em = this.em.fork();
    const statuses =
      query.status === undefined
        ? DEFAULT_LIST_STATUSES
        : query.status
            .split(',')
            .map((part) => part.trim())
            .filter((part): part is LessonSegmentStatus =>
              (LESSON_SEGMENT_STATUSES as readonly string[]).includes(part),
            );
    const segments = await this.segments.listByStatus(
      statuses,
      query.runId ?? null,
      em,
    );
    const wires: LessonSegmentWire[] = [];
    for (const segment of segments) {
      wires.push(
        await this.wireOf(
          segment,
          await this.runDao.getById(segment.runId, em),
          em,
        ),
      );
    }
    return wires;
  }

  /** What reflecting on the thread's stretch past its last reflection would cost, and whether an archive would by itself, for the archive dialog. */
  async threadEstimate(
    query: LessonEstimateQuery,
  ): Promise<ThreadLessonEstimate> {
    const em = this.em.fork();
    const run = await this.runDao.getById(query.runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${query.runId}`);
    }
    const fromSeq = run.reflectedThroughSeq ?? -1;
    const toSeq = await this.itemDao.maxSeqExcept(run.id, LESSON_ROW_KINDS, em);
    const reflectable =
      toSeq > fromSeq &&
      isReflectable(run) &&
      !(await this.reflecting(run.id, em));
    const signals = reflectable
      ? await readLessonSignals(
          this.signalSources(),
          run.id,
          fromSeq,
          toSeq,
          em,
        )
      : [];
    const range = { fromSeq, toSeq: Math.max(fromSeq, toSeq) };
    const checker = this.config.checkChoice();
    const estimate = await this.estimates.estimate(
      run,
      range,
      this.config.reflectionChoice(run),
      em,
    );
    return {
      estimate,
      typical: await this.spending.typical(estimate.model, em),
      check:
        checker === null
          ? null
          : await this.estimates.estimate(run, range, checker, em),
      signals: signals.length,
      lessonsOn: await this.lessonsOnFor(run),
      fromSeq,
      toSeq,
    };
  }

  private signalSources(): LessonSignalSources {
    return { itemDao: this.itemDao, goalDao: this.goalDao };
  }

  private async closeNow(
    runId: string,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonSegment | null> {
    const choice =
      closedBy === 'archive' ? this.archiveChoices?.take(runId) : undefined;
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null || !isReflectable(run)) {
      return null;
    }
    const fromSeq = run.reflectedThroughSeq ?? -1;
    const toSeq = await this.itemDao.maxSeqExcept(run.id, LESSON_ROW_KINDS, em);
    if (toSeq <= fromSeq) {
      return null;
    }
    const queued = await this.segments.queuedOf(run.id, em);
    if (
      choice !== 'skip' &&
      queued !== null &&
      queued.fromSeq === fromSeq &&
      queued.toSeq >= toSeq
    ) {
      return null;
    }
    if (
      (choice === undefined && !(await this.lessonsOnFor(run))) ||
      (await this.reflecting(run.id, em))
    ) {
      return null;
    }
    const signals = await readLessonSignals(
      this.signalSources(),
      run.id,
      fromSeq,
      toSeq,
      em,
    );
    if (signals.length === 0) {
      return null;
    }
    const estimate = await this.estimates.estimate(
      run,
      { fromSeq, toSeq },
      this.config.reflectionChoice(run),
      em,
    );
    const skipped = choice === 'skip';
    const fields = {
      fromSeq,
      toSeq,
      closedBy,
      closedAt: new Date(),
      signals: JSON.stringify(signals),
      status: skipped ? ('skipped' as const) : ('queued' as const),
      skipReason: skipped ? ('user_skipped' as const) : null,
      reflectionRunId: null,
      checkRunId: null,
      failReason: null,
      estimateTokens: estimate.tokens,
      estimateUsd: estimate.usd,
    };
    const segment = await em.transactional(async (tx) => {
      if (skipped) {
        await this.runDao.updateById(
          run.id,
          { reflectedThroughSeq: toSeq },
          tx,
        );
      }
      if (queued === null) {
        return this.segments.create(
          { runId: run.id, attempts: 0, ...fields },
          tx,
        );
      }
      await this.segments.updateById(queued.id, fields, tx);
      return Object.assign(queued, fields);
    });
    this.events.publishChanged(run.id);
    return segment;
  }

  private async wireOf(
    segment: LessonSegment,
    run: Run | null,
    em: EntityManager,
  ): Promise<LessonSegmentWire> {
    const source = run ?? {
      id: segment.runId,
      agentKind: null,
      configDir: null,
      model: null,
      effort: null,
      contextWindow: null,
      modelParameters: null,
    };
    const range = { fromSeq: segment.fromSeq, toSeq: segment.toSeq };
    const checker = this.config.checkChoice();
    return {
      id: segment.id,
      runId: segment.runId,
      sourceTitle: run?.title ?? null,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      closedBy: segment.closedBy,
      closedAt: segment.closedAt.toISOString(),
      signals: (JSON.parse(segment.signals) as LessonSignal[]).map(
        ({ kind, seq }) => ({ kind, seq }),
      ),
      status: segment.status,
      reflectionRunId: segment.reflectionRunId,
      checkRunId: segment.checkRunId,
      failReason: segment.failReason,
      estimate: await this.estimates.estimate(
        source,
        range,
        this.config.reflectionChoice(source),
        em,
      ),
      checkEstimate:
        checker === null
          ? null
          : await this.estimates.estimate(source, range, checker, em),
    };
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
