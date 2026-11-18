import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { RunDao } from '../../agents/dao/run.dao';
import { isTerminalRunStatus } from '../../runs/runs.types';
import {
  LessonSegmentDao,
  RUNNING_SEGMENT_STATUSES,
} from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import { LESSON_SEGMENT_MAX_ATTEMPTS } from '../lessons.types';
import { LessonCheckService } from './lesson-check.service';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsEventBus } from './lessons-events.bus';

/** How often the runner looks for a lease that ran out with nothing else waking it. */
export const LESSON_RUNNER_TICK_MS = 60_000;

/**
 * Runs the queued stretches, one reflection (or check) at a time, oldest
 * first. Whether a stretch runs was decided when it was queued, so the
 * settings are not read again here. A stretch holds a 30-minute lease while
 * it runs; a lease that runs out is taken back as a failed attempt. At start
 * it takes back what the last launch left running. No spend limit: what each
 * run cost is shown, not capped. "Reflect now" starts its own reflection at
 * once, outside this queue.
 */
@Injectable()
export class LessonAutoRunner
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LessonAutoRunner.name);
  private subscription: Subscription | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private again = false;
  private busy = false;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly segments: LessonSegmentDao,
    private readonly reflections: LessonReflectionService,
    private readonly checks: LessonCheckService,
    private readonly events: LessonsEventBus,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.allChanges().subscribe(() => this.kick());
  }

  onApplicationBootstrap(): void {
    this.ticker = setInterval(() => this.kick(), LESSON_RUNNER_TICK_MS);
    this.ticker.unref();
    void this.recover()
      .catch((err: unknown) => {
        this.logger.warn(`lesson runs not taken back: ${messageOf(err)}`);
      })
      .finally(() => this.kick());
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.ticker !== null) {
      clearInterval(this.ticker);
    }
  }

  /** Look at the queue now; a look already under way looks again when it ends. */
  kick(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.running = this.step()
      .catch((err: unknown) => {
        this.logger.warn(`lesson runner step failed: ${messageOf(err)}`);
      })
      .finally(() => {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Settles once the current look has ended; for specs. */
  idle(): Promise<void> {
    return this.running;
  }

  private async step(): Promise<void> {
    const em = this.em.fork();
    const running = await this.segments.listByStatus(
      RUNNING_SEGMENT_STATUSES,
      null,
      em,
    );
    const now = Date.now();
    for (const segment of running) {
      if (segment.leaseUntil !== null && segment.leaseUntil.getTime() < now) {
        await this.takeBack(segment);
      }
    }
    if (running.some((segment) => !leaseExpired(segment, now))) {
      return;
    }
    for (const segment of await this.segments.listQueued(em)) {
      if ((await this.runDao.getById(segment.runId, em)) === null) {
        continue;
      }
      try {
        await this.reflections.start(segment.runId, {}, segment.closedBy);
      } catch (err) {
        this.logger.warn(
          `lessons reflection on ${segment.runId} not started: ${messageOf(err)}`,
        );
        await this.markUnstartable(segment, messageOf(err));
        continue;
      }
      return;
    }
  }

  /** What the last launch left running cannot finish: each is taken back now. */
  private async recover(): Promise<void> {
    const em = this.em.fork();
    for (const segment of await this.segments.listByStatus(
      RUNNING_SEGMENT_STATUSES,
      null,
      em,
    )) {
      const runId =
        segment.status === 'checking'
          ? segment.checkRunId
          : segment.reflectionRunId;
      const run = runId === null ? null : await this.runDao.getById(runId, em);
      if (run === null || isTerminalRunStatus(run.status)) {
        await this.takeBack(segment);
      }
    }
  }

  private async takeBack(segment: LessonSegment): Promise<void> {
    if (segment.status === 'checking') {
      await this.checks.abandon(segment);
    } else {
      await this.reflections.abandon(segment);
    }
  }

  /** A stretch the reflection refused to start: nothing new is left `empty`, anything else waits for another try. */
  private async markUnstartable(
    segment: LessonSegment,
    reason: string,
  ): Promise<void> {
    const em = this.em.fork();
    const current = await this.segments.getById(segment.id, em);
    if (
      current === null ||
      current.status !== 'queued' ||
      current.attempts !== segment.attempts
    ) {
      return;
    }
    const nothingNew = reason.includes('since its last reflection');
    const attempts = current.attempts + 1;
    await this.segments.updateById(
      segment.id,
      nothingNew
        ? { status: 'empty' }
        : {
            attempts,
            failReason: reason,
            ...(attempts >= LESSON_SEGMENT_MAX_ATTEMPTS
              ? { status: 'failed' as const }
              : {}),
          },
      em,
    );
    this.events.publishChanged(segment.runId);
  }
}

function leaseExpired(segment: LessonSegment, now: number): boolean {
  return segment.leaseUntil !== null && segment.leaseUntil.getTime() < now;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
