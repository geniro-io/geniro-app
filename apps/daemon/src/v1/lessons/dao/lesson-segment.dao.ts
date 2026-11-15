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

  /** A thread's stretch still waiting on the user; a thread has at most one, and a later close extends it. */
  openOf(runId: string, txEm?: EntityManager): Promise<LessonSegment | null> {
    return this.getRepo(txEm).findOne(
      { runId, status: { $in: [...WAITING_SEGMENT_STATUSES] } },
      { orderBy: { closedAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Where the thread's next offer starts: after its last reflection, or after
   * the newest stretch the user dismissed, whichever is later — a dismissed
   * stretch is never offered or priced again.
   */
  async offerCursorOf(
    run: { id: string; reflectedThroughSeq: number | null },
    txEm?: EntityManager,
  ): Promise<number> {
    const dismissed = await this.getRepo(txEm).findOne(
      { runId: run.id, status: 'dismissed' },
      { orderBy: { toSeq: 'desc' }, disableIdentityMap: true },
    );
    return Math.max(run.reflectedThroughSeq ?? -1, dismissed?.toSeq ?? -1);
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
