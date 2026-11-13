import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import { environment } from '../../../environments';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ChatService } from '../../agents/services/chat.service';
import { existingDirectory } from '../../agents/utils/resolve-directory';
import { runSnapshotOf } from '../../agents/utils/run-snapshots';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao, OPEN_SEGMENT_STATUSES } from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_REJECTED_BRIEF_MAX,
  LESSON_ROW_KINDS,
  LESSONS_REFLECTION_APPROVAL,
  type LessonSegmentCloser,
  type ReflectLessons,
  type ThreadLessonsState,
} from '../lessons.types';
import {
  lessonsReflectionBrief,
  lessonsReflectionGuide,
} from '../utils/lessons-reflection-guide';
import { readLessonSignals } from '../utils/read-lesson-signals';
import { isReflectable } from '../utils/reflectable';
import { reflectionChoiceOf } from '../utils/reflection-choice';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

export interface LessonsReflectStarted {
  reflectionRunId: string;
  segmentId: string;
  fromSeq: number;
  toSeq: number;
}

/**
 * Starts a lessons reflection: a hidden chat on the thread-analysis machinery
 * (`Run.analysisPurpose = 'lessons'`) that reads the items of a thread past
 * its `reflectedThroughSeq` and files lessons with `propose_lessons`. Never
 * touches the thread's own "Analyze thread" analysis.
 *
 * A reflection takes the thread's waiting stretch when it has one, so an
 * offer pressed, "Reflect now" and "Extract" in "Not reflected yet" all end
 * the same offer. A reflection that ends without filing leaves its stretch
 * `failed`, back in "Not reflected yet".
 */
@Injectable()
export class LessonReflectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LessonReflectionService.name);
  private subscriptions: Subscription[] = [];
  /** Sources between a start's checks and its chat, so a second press cannot start a twin. */
  private readonly starting = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly bus: AgentEventBus,
    private readonly memory: MemoryService,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly proposals: LessonProposalDao,
    private readonly config: LessonsConfigService,
    private readonly events: LessonsEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions = [
      this.bus.allDeleted().subscribe((runId) => {
        this.segments
          .deleteOfRuns([runId], this.em.fork())
          .catch((err: unknown) => {
            this.logger.warn(
              `lesson segments of deleted ${runId} not dropped: ${messageOf(err)}`,
            );
          });
      }),
      this.bus.allStatuses().subscribe((event) => {
        if (event.status !== null && isTerminalRunStatus(event.status)) {
          void this.settled(event.runId).catch((err: unknown) => {
            this.logger.warn(
              `lessons reflection ${event.runId} not settled: ${messageOf(err)}`,
            );
          });
        }
      }),
    ];
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  /** The reflection still working on this thread, if any — a delete waits for it rather than starting a second. */
  async runningReflectionId(sourceRunId: string): Promise<string | null> {
    return (
      (await this.runningReflectionOf(sourceRunId, this.em.fork()))?.id ?? null
    );
  }

  /** Whether "Reflect now" has anything to do on this thread now. */
  async state(sourceRunId: string): Promise<ThreadLessonsState> {
    const em = this.em.fork();
    const source = await this.sourceOf(sourceRunId, em);
    const running = await this.runningReflectionOf(source.id, em);
    const newest = await this.itemDao.maxSeqExcept(
      source.id,
      LESSON_ROW_KINDS,
      em,
    );
    return {
      reflectable:
        isReflectable(source) &&
        source.pendingDeleteAt === null &&
        running === null &&
        !this.starting.has(source.id) &&
        newest > (source.reflectedThroughSeq ?? -1),
      reflectionRunId: running?.id ?? null,
      reflectedThroughSeq: source.reflectedThroughSeq,
    };
  }

  async start(
    sourceRunId: string,
    input: ReflectLessons,
    closedBy: LessonSegmentCloser = 'manual',
  ): Promise<LessonsReflectStarted> {
    if (this.starting.has(sourceRunId)) {
      throw new ConflictException(
        'LESSONS_REFLECTING',
        'a reflection on this thread is already starting',
      );
    }
    this.starting.add(sourceRunId);
    try {
      return await this.startNow(sourceRunId, input, closedBy);
    } finally {
      this.starting.delete(sourceRunId);
    }
  }

  private async startNow(
    sourceRunId: string,
    input: ReflectLessons,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonsReflectStarted> {
    const em = this.em.fork();
    const source = await this.sourceOf(sourceRunId, em);
    if (!isReflectable(source)) {
      throw new ConflictException(
        'LESSONS_NOT_REFLECTABLE',
        'an analysis, team builder or project chat is never reflected on — reflect on the thread it works on instead',
      );
    }
    if (source.pendingDeleteAt !== null && closedBy !== 'delete') {
      throw new ConflictException(
        'LESSONS_NOT_REFLECTABLE',
        'this thread is being deleted',
      );
    }
    if ((await this.runningReflectionOf(source.id, em)) !== null) {
      throw new ConflictException(
        'LESSONS_REFLECTING',
        'a reflection on this thread is still working',
      );
    }
    const waiting = await this.waitingSegmentOf(source.id, input.segmentId, em);
    const fromSeq = source.reflectedThroughSeq ?? -1;
    const newest = await this.itemDao.maxSeqExcept(
      source.id,
      LESSON_ROW_KINDS,
      em,
    );
    if (newest <= fromSeq) {
      throw new ConflictException(
        'LESSONS_NOTHING_NEW',
        'nothing has happened in this thread since its last reflection',
      );
    }
    const { snapshotSeq, working } = await runSnapshotOf(
      { em: this.em, runDao: this.runDao, itemDao: this.itemDao },
      source.id,
    );
    if (snapshotSeq <= fromSeq) {
      throw new ConflictException(
        'LESSONS_NOTHING_NEW',
        'nothing has happened in this thread since its last reflection',
      );
    }
    const signals = await readLessonSignals(
      this.itemDao,
      source.id,
      fromSeq,
      snapshotSeq,
      em,
    );
    const project = await this.projectScope.projectOfRun(source);
    const place = {
      projectId: project?.id ?? null,
      teamSlug: source.teamId,
    };
    const rejected = await this.proposals.rejectedIn(
      place,
      LESSON_REJECTED_BRIEF_MAX,
      em,
    );
    const stretch = {
      fromSeq,
      toSeq: snapshotSeq,
      signals: JSON.stringify(signals),
      status: 'reflecting' as const,
    };
    let segment: LessonSegment;
    if (waiting === null) {
      segment = await this.segments.create(
        {
          runId: source.id,
          closedBy,
          closedAt: new Date(),
          attempts: 1,
          ...stretch,
        },
        em,
      );
    } else {
      const attempts = waiting.attempts + 1;
      await this.segments.updateById(
        waiting.id,
        { ...stretch, attempts, reflectionRunId: null },
        em,
      );
      segment = Object.assign(waiting, stretch, { attempts });
    }
    const choice = reflectionChoiceOf(this.config.config, source, input);
    let runId: string;
    try {
      const run = await this.chats.createChat({
        agentKind: choice.agentKind,
        cwd: this.folderFor(source, project?.folder ?? null),
        projectId: place.projectId,
        approval: LESSONS_REFLECTION_APPROVAL,
        model: choice.model ?? undefined,
        effort: choice.effort ?? undefined,
        configDir: choice.configDir ?? undefined,
        title: `Lessons: ${source.title ?? 'untitled thread'}`,
        taskInstructions: lessonsReflectionGuide(this.memory.enabled),
        analysisSource: {
          runId: source.id,
          seq: snapshotSeq,
          working,
          purpose: 'lessons',
        },
      });
      runId = run.id;
    } catch (error) {
      await this.markFailed(segment.id, source.id, em);
      throw error;
    }
    await this.segments.updateById(segment.id, { reflectionRunId: runId }, em);
    try {
      await this.chats.sendMessage(
        runId,
        lessonsReflectionBrief({
          title: source.title,
          fromSeq,
          toSeq: snapshotSeq,
          signals,
          rejected: rejected.map((proposal) => ({
            title: proposal.title,
            reason: proposal.rejectReason,
          })),
        }),
      );
    } catch (error) {
      await this.chats.delete(runId).catch(() => undefined);
      await this.markFailed(segment.id, source.id, em);
      throw error;
    }
    this.events.publishChanged(source.id);
    return {
      reflectionRunId: runId,
      segmentId: segment.id,
      fromSeq,
      toSeq: snapshotSeq,
    };
  }

  /** A reflection ended: a stretch it never filed lessons for goes back to waiting, as failed. */
  private async settled(runId: string): Promise<void> {
    const em = this.em.fork();
    const segment = await this.segments.ofReflection(runId, em);
    if (segment === null || segment.status !== 'reflecting') {
      return;
    }
    await this.markFailed(segment.id, segment.runId, em);
  }

  private async markFailed(
    segmentId: string,
    sourceRunId: string,
    em: EntityManager,
  ): Promise<void> {
    await this.segments
      .updateById(segmentId, { status: 'failed' }, em)
      .catch(() => undefined);
    this.events.publishChanged(sourceRunId);
  }

  /** The thread's stretch waiting on the user, the one a press named, or null to start a new one. */
  private async waitingSegmentOf(
    sourceRunId: string,
    segmentId: string | undefined,
    em: EntityManager,
  ): Promise<LessonSegment | null> {
    if (segmentId === undefined) {
      return this.segments.openOf(sourceRunId, em);
    }
    const segment = await this.segments.getById(segmentId, em);
    if (segment === null || segment.runId !== sourceRunId) {
      throw new NotFoundException(
        'LESSON_SEGMENT_NOT_FOUND',
        `no stretch ${segmentId} on this thread`,
      );
    }
    if (!OPEN_SEGMENT_STATUSES.includes(segment.status)) {
      throw new ConflictException(
        'LESSON_SEGMENT_DECIDED',
        `this stretch is already ${segment.status}`,
      );
    }
    return segment;
  }

  private async sourceOf(runId: string, em: EntityManager): Promise<Run> {
    const source = await this.runDao.getById(runId, em);
    if (source === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    return source;
  }

  private async runningReflectionOf(
    sourceRunId: string,
    em: EntityManager,
  ): Promise<Run | null> {
    const reflections = await this.runDao.listLessonReflectionsOf(
      sourceRunId,
      em,
    );
    return reflections.find((run) => !isTerminalRunStatus(run.status)) ?? null;
  }

  private folderFor(source: Run, projectFolder: string | null): string {
    return (
      (source.cwd === null ? null : existingDirectory(source.cwd)) ??
      (projectFolder === null ? null : existingDirectory(projectFolder)) ??
      environment.userDataDir
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
