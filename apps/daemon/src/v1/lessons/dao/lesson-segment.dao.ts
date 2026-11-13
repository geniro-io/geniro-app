import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { LessonSegment } from '../entity/lesson-segment.entity';
import type { LessonSegmentStatus } from '../lessons.types';

/** A stretch waiting on the user in "Not reflected yet": offered (a "Not now" leaves it so), or a reflection that failed. */
export const WAITING_SEGMENT_STATUSES: readonly LessonSegmentStatus[] = [
  'offered',
  'failed',
];

/** A stretch no reflection has read yet — waiting, or dismissed from "Not reflected yet"; a later close extends it. */
export const OPEN_SEGMENT_STATUSES: readonly LessonSegmentStatus[] = [
  ...WAITING_SEGMENT_STATUSES,
  'dismissed',
];

@Injectable()
export class LessonSegmentDao extends BaseDao<LessonSegment> {
  constructor(em: EntityManager) {
    super(em, LessonSegment);
  }

  /** The segment a reflection was started on. */
  ofReflection(
    reflectionRunId: string,
    txEm?: EntityManager,
  ): Promise<LessonSegment | null> {
    return this.getRepo(txEm).findOne(
      { reflectionRunId },
      { disableIdentityMap: true },
    );
  }

  /** A thread's stretch still waiting on the user; a thread has at most one. */
  openOf(runId: string, txEm?: EntityManager): Promise<LessonSegment | null> {
    return this.getRepo(txEm).findOne(
      { runId, status: { $in: [...OPEN_SEGMENT_STATUSES] } },
      { orderBy: { closedAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** Segments by status, newest closed first; every run's, or one run's. */
  listByStatus(
    statuses: readonly LessonSegmentStatus[],
    runId: string | null,
    txEm?: EntityManager,
  ): Promise<LessonSegment[]> {
    return this.getRepo(txEm).find(
      {
        status: { $in: [...statuses] },
        ...(runId === null ? {} : { runId }),
      },
      { orderBy: { closedAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** Drop every segment of the runs a teardown deletes. */
  async deleteOfRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<void> {
    if (runIds.length === 0) {
      return;
    }
    await this.getRepo(txEm).nativeDelete({ runId: { $in: [...runIds] } });
  }
}
