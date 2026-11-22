import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { filter, merge, mergeMap, type Observable } from 'rxjs';

import { RunDao } from '../../agents/dao/run.dao';
import type {
  BackgroundJob,
  BackgroundJobLessons,
  BackgroundJobSource,
  BackgroundJobStatus,
} from '../../background-jobs/background-jobs.types';
import { BackgroundJobsRegistry } from '../../background-jobs/services/background-jobs.registry';
import { MemoryService } from '../../memory/services/memory.service';
import { UsageEventBus } from '../../stats/services/usage-events.bus';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import {
  LessonSegmentDao,
  RUNNING_SEGMENT_STATUSES,
} from '../dao/lesson-segment.dao';
import type { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import type { LessonSegmentStatus } from '../lessons.types';
import { LessonSpendService } from './lesson-spend.service';
import { LessonsEventBus } from './lessons-events.bus';

const ACTIVE_STATUSES: readonly LessonSegmentStatus[] = [
  'queued',
  ...RUNNING_SEGMENT_STATUSES,
];
const FINISHED_STATUSES: readonly LessonSegmentStatus[] = [
  'reflected',
  'empty',
  'failed',
];

/**
 * Lessons runs as background jobs: every closed stretch but a skipped one,
 * which never ran. A job is the stretch — its reflection and check together —
 * read in one batch per page: titles, ledger rows and the proposals filed.
 */
@Injectable()
export class LessonBackgroundJobSource
  implements BackgroundJobSource, OnModuleInit
{
  readonly kind = 'lessons' as const;

  constructor(
    private readonly em: EntityManager,
    private readonly registry: BackgroundJobsRegistry,
    private readonly segments: LessonSegmentDao,
    private readonly proposals: LessonProposalDao,
    private readonly runDao: RunDao,
    private readonly spending: LessonSpendService,
    private readonly memory: MemoryService,
    private readonly events: LessonsEventBus,
    private readonly usage: UsageEventBus,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  changes(): Observable<unknown> {
    return merge(
      this.events.allChanges(),
      this.usage.all().pipe(
        mergeMap((event) => this.isLessonsRun(event.runId)),
        filter(Boolean),
      ),
    );
  }

  async active(): Promise<BackgroundJob[]> {
    const em = this.em.fork();
    return this.jobsOf(
      await this.segments.listByStatus(ACTIVE_STATUSES, null, em),
      em,
    );
  }

  async finished(page: {
    notAfter: Date | null;
    limit: number;
  }): Promise<BackgroundJob[]> {
    const em = this.em.fork();
    return this.jobsOf(
      await this.segments.page(
        FINISHED_STATUSES,
        page.notAfter,
        page.limit,
        em,
      ),
      em,
    );
  }

  private async isLessonsRun(runId: string): Promise<boolean> {
    const run = await this.runDao
      .getById(runId, this.em.fork())
      .catch(() => null);
    return (
      run?.analysisPurpose === 'lessons' ||
      run?.analysisPurpose === 'lessons_check'
    );
  }

  private async jobsOf(
    segments: readonly LessonSegment[],
    em: EntityManager,
  ): Promise<BackgroundJob[]> {
    if (segments.length === 0) {
      return [];
    }
    const titles = await this.runDao.titlesOf(
      segments.map((segment) => segment.runId),
      em,
    );
    const samples = await this.spending.samplesOf(segments, em);
    const filed = await this.proposals.ofSegments(
      segments.map((segment) => segment.id),
      em,
    );
    const pending = await this.memory.pendingLessonProposals(
      filed.filter((row) => row.status === 'saved').map((row) => row.id),
    );
    const bySegment = new Map<string, LessonProposal[]>();
    for (const row of filed) {
      bySegment.set(row.segmentId, [
        ...(bySegment.get(row.segmentId) ?? []),
        row,
      ]);
    }
    return segments.map((segment) => {
      const sample = samples.get(segment.id);
      const status = jobStatusOf(segment.status);
      return {
        id: `lessons:${segment.id}`,
        kind: 'lessons',
        status,
        phase: status === 'running' ? segment.status : null,
        runId: segment.runId,
        title: titles.get(segment.runId) ?? null,
        startedAt: segment.closedAt.toISOString(),
        endedAt:
          status === 'done' || status === 'failed'
            ? segment.updatedAt.toISOString()
            : null,
        model: sample?.model ?? null,
        costUsd: sample?.usd ?? null,
        durationMs: sample?.durationMs ?? null,
        error: status === 'failed' ? segment.failReason : null,
        lessons:
          status === 'done'
            ? lessonsOf(bySegment.get(segment.id) ?? [], pending)
            : null,
      };
    });
  }
}

function jobStatusOf(status: LessonSegmentStatus): BackgroundJobStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'reflecting':
    case 'checking':
      return 'running';
    case 'failed':
      return 'failed';
    default:
      return 'done';
  }
}

function lessonsOf(
  rows: readonly LessonProposal[],
  pending: ReadonlySet<string>,
): BackgroundJobLessons {
  const counts = { saved: 0, waiting: 0, dropped: 0 };
  for (const row of rows) {
    if (row.status === 'saved') {
      counts[pending.has(row.id) ? 'waiting' : 'saved'] += 1;
    } else if (
      row.status === 'proposed' ||
      row.status === 'checking' ||
      row.status === 'check_failed'
    ) {
      counts.waiting += 1;
    } else if (
      row.status === 'dropped_by_check' ||
      row.status === 'skipped_duplicate'
    ) {
      counts.dropped += 1;
    }
  }
  return counts;
}
