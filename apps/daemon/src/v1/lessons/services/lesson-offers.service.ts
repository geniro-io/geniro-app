import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { parseJsonColumn } from '../../agents/utils/json-util';
import type { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import {
  LessonSegmentDao,
  OPEN_SEGMENT_STATUSES,
} from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_ROW_KINDS,
  LESSON_SEGMENT_STATUSES,
  type LessonEstimateQuery,
  type LessonSegmentListQuery,
  type LessonSegmentStatus,
  type LessonSegmentWire,
  LessonSignalKindSchema,
  type LessonsReflectAll,
  type ThreadLessonEstimate,
} from '../lessons.types';
import { readLessonSignals } from '../utils/read-lesson-signals';
import { isReflectable } from '../utils/reflectable';
import { LessonEstimateService } from './lesson-estimate.service';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsEventBus } from './lessons-events.bus';

/**
 * The offers the user acts on: "Not reflected yet" (every stretch waiting,
 * priced now for the model that would run), "Not now", "Extract all", and the
 * price of a thread's unreflected part for the delete dialog and "Change
 * model…". Every price is computed when asked, so a change in the lessons
 * settings shows at once.
 */
@Injectable()
export class LessonOffersService {
  private readonly logger = new Logger(LessonOffersService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly segments: LessonSegmentDao,
    private readonly estimates: LessonEstimateService,
    private readonly reflections: LessonReflectionService,
    private readonly events: LessonsEventBus,
  ) {}

  async list(query: LessonSegmentListQuery): Promise<LessonSegmentWire[]> {
    const em = this.em.fork();
    const rows = await this.segments.listByStatus(
      statusesOf(query.status),
      query.runId ?? null,
      em,
    );
    const wires: LessonSegmentWire[] = [];
    for (const segment of rows) {
      const run = await this.runDao.getById(segment.runId, em);
      if (
        run === null ||
        (run.pendingDeleteAt !== null && query.runId === undefined)
      ) {
        continue;
      }
      wires.push(await this.wireOf(segment, run, em));
    }
    return wires;
  }

  async dismiss(segmentId: string): Promise<LessonSegmentWire> {
    const em = this.em.fork();
    const segment = await this.segments.getById(segmentId, em);
    if (segment === null) {
      throw new NotFoundException(
        'LESSON_SEGMENT_NOT_FOUND',
        `no stretch ${segmentId}`,
      );
    }
    if (segment.status !== 'offered') {
      throw new ConflictException(
        'LESSON_SEGMENT_DECIDED',
        `this stretch is ${segment.status}, not offered`,
      );
    }
    await this.segments.updateById(segment.id, { status: 'dismissed' }, em);
    segment.status = 'dismissed';
    this.events.publishChanged(segment.runId);
    const run = await this.runDao.getById(segment.runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${segment.runId}`);
    }
    return this.wireOf(segment, run, em);
  }

  /** A reflection on every waiting stretch, one per thread, each with the settings' model. */
  async reflectAll(): Promise<LessonsReflectAll> {
    const waiting = await this.list({});
    let started = 0;
    let refused = 0;
    for (const segment of waiting) {
      try {
        await this.reflections.start(segment.runId, { segmentId: segment.id });
        started += 1;
      } catch (err) {
        refused += 1;
        this.logger.warn(
          `reflection on ${segment.runId} not started: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { started, refused };
  }

  /** The price of reflecting on a thread's unreflected part now, and how many signals it holds. */
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
    const offerable =
      toSeq > fromSeq &&
      isReflectable(run) &&
      run.pendingDeleteAt === null &&
      !(await this.reflecting(run.id, em));
    const signals = offerable
      ? await readLessonSignals(this.itemDao, run.id, fromSeq, toSeq, em)
      : [];
    return {
      estimate: await this.estimates.estimate(
        run,
        { fromSeq, toSeq: Math.max(fromSeq, toSeq) },
        query,
        em,
      ),
      signals: signals.length,
      fromSeq,
      toSeq,
    };
  }

  private async reflecting(runId: string, em: EntityManager): Promise<boolean> {
    const reflections = await this.runDao.listLessonReflectionsOf(runId, em);
    return reflections.some((run) => !isTerminalRunStatus(run.status));
  }

  private async wireOf(
    segment: LessonSegment,
    run: Run,
    em: EntityManager,
  ): Promise<LessonSegmentWire> {
    return {
      id: segment.id,
      runId: segment.runId,
      sourceTitle: run.title,
      archived: run.archivedAt !== null,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      closedBy: segment.closedBy,
      closedAt: segment.closedAt.toISOString(),
      signals: signalRefsOf(segment.signals),
      status: segment.status,
      reflectionRunId: segment.reflectionRunId,
      estimate: await this.estimates.estimate(
        run,
        { fromSeq: segment.fromSeq, toSeq: segment.toSeq },
        {},
        em,
      ),
    };
  }
}

function statusesOf(text: string | undefined): readonly LessonSegmentStatus[] {
  if (text === undefined || text.trim() === '') {
    return OPEN_SEGMENT_STATUSES;
  }
  const statuses = text.split(',').map((part) => part.trim());
  const unknown = statuses.filter(
    (status) =>
      !(LESSON_SEGMENT_STATUSES as readonly string[]).includes(status),
  );
  if (unknown.length > 0) {
    throw new BadRequestException(
      'INVALID_SEGMENT_STATUS',
      `unknown status: ${unknown.join(', ')}`,
    );
  }
  return statuses as LessonSegmentStatus[];
}

function signalRefsOf(json: string): LessonSegmentWire['signals'] {
  const parsed = parseJsonColumn(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const kind = LessonSignalKindSchema.safeParse(record.kind);
    return kind.success && typeof record.seq === 'number'
      ? [{ kind: kind.data, seq: record.seq }]
      : [];
  });
}
