import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { type AgentKind } from '../../runs/runs.types';
import { UsageEventDao } from '../../stats/dao/usage-event.dao';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import type { LessonsSpend, LessonTypicalSpend } from '../lessons.types';
import { runSampleOf } from '../utils/run-sample';
import { type LessonRunSample, typicalSpendOf } from '../utils/typical-spend';

/** How many failed stretches the readout names. */
export const LESSON_FAILED_LISTED_MAX = 5;
/** How many of the newest finished runs are read to find the typical figures, same-model ones among them. */
export const LESSON_TYPICAL_SCAN = 100;

/**
 * What lessons cost, from the usage ledger's `purpose` rows over every row of
 * the period (`lessons` is the reflection, `lessons_check` the check), and
 * what they did today — for Settings → Memory → Lessons. A run whose CLI
 * reported no cost is counted as unpriced, never as $0.
 */
@Injectable()
export class LessonSpendService {
  constructor(
    private readonly em: EntityManager,
    private readonly usage: UsageEventDao,
    private readonly segments: LessonSegmentDao,
    private readonly proposals: LessonProposalDao,
    private readonly runDao: RunDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  async spend(now = new Date()): Promise<LessonsSpend> {
    const em = this.em.fork();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    const rows = await this.usage.ofPurposesSince(
      ['lessons', 'lessons_check'],
      month,
      em,
    );
    const todayByStep = { reflect: 0, check: 0 };
    const monthByStep = { reflect: 0, check: 0 };
    const priced = new Map<string, boolean>();
    for (const row of rows) {
      const step = row.purpose === 'lessons_check' ? 'check' : 'reflect';
      const cost = row.costUsd ?? 0;
      monthByStep[step] += cost;
      if (row.occurredAt >= today) {
        todayByStep[step] += cost;
      }
      priced.set(
        row.runId,
        (priced.get(row.runId) ?? false) || row.costUsd !== null,
      );
    }
    const ended = await this.segments.listChangedSince(
      ['reflected', 'empty'],
      today,
      em,
    );
    const failed = (
      await this.segments.listByStatus(['failed'], null, em)
    ).slice(0, LESSON_FAILED_LISTED_MAX);
    return {
      todayUsd: todayByStep.reflect + todayByStep.check,
      monthUsd: monthByStep.reflect + monthByStep.check,
      todayByStep,
      monthByStep,
      reflectedToday: new Set(ended.map((segment) => segment.runId)).size,
      savedToday: await this.proposals.savedSince(today, em),
      unpricedRuns: [...priced.values()].filter((value) => !value).length,
      failed: await Promise.all(
        failed.map(async (segment) => ({
          segmentId: segment.id,
          runId: segment.runId,
          sourceTitle:
            (await this.runDao.getById(segment.runId, em))?.title ?? null,
          reason: segment.failReason,
          ...(await this.failureCauseOf(segment, em)),
        })),
      ),
    };
  }

  private async failureCauseOf(
    segment: LessonSegment,
    em: EntityManager,
  ): Promise<Pick<LessonsSpend['failed'][number], 'cause' | 'resetsAt'>> {
    const reason = segment.failReason;
    if (reason === null) {
      return { cause: 'other', resetsAt: null };
    }
    const reflection =
      segment.reflectionRunId === null
        ? null
        : await this.runDao.getById(segment.reflectionRunId, em);
    const agentKind: AgentKind | null = reflection?.agentKind ?? null;
    const own =
      agentKind === null ? undefined : this.adapters.all().get(agentKind);
    const failures = (
      own === undefined ? [...this.adapters.all().values()] : [own]
    ).map((adapter) => adapter.failureFrom(reason));
    const limit = failures.find((failure) => failure.class === 'rate_limited');
    if (limit !== undefined) {
      return { cause: 'limit', resetsAt: limit.resetsAt };
    }
    return failures.some((failure) => failure.class === 'auth_expired')
      ? { cause: 'signed_out', resetsAt: null }
      : { cause: 'other', resetsAt: null };
  }

  /** What a lessons run typically costs and takes, from finished runs, those on `model` when there are enough. */
  async typical(
    model: string | null,
    em: EntityManager = this.em.fork(),
  ): Promise<LessonTypicalSpend | null> {
    const finished = await this.segments.listFinished(LESSON_TYPICAL_SCAN, em);
    const samples = await this.samplesOf(finished, em);
    return typicalSpendOf(
      finished.flatMap((segment) => samples.get(segment.id) ?? []),
      model,
    );
  }

  /** Each segment's run figures — its reflection and check together — read in one ledger pass. */
  async samplesOf(
    segments: readonly LessonSegment[],
    em: EntityManager,
  ): Promise<Map<string, LessonRunSample>> {
    const runIds = segments.flatMap((segment) =>
      [segment.reflectionRunId, segment.checkRunId].filter(
        (id): id is string => id !== null,
      ),
    );
    const rows = await this.usage.rowsByRuns(runIds, em);
    const byRun = new Map<string, typeof rows>();
    for (const row of rows) {
      byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
    }
    const out = new Map<string, LessonRunSample>();
    for (const segment of segments) {
      if (segment.reflectionRunId === null) {
        continue;
      }
      out.set(
        segment.id,
        runSampleOf([
          ...(byRun.get(segment.reflectionRunId) ?? []),
          ...(segment.checkRunId === null
            ? []
            : (byRun.get(segment.checkRunId) ?? [])),
        ]),
      );
    }
    return out;
  }
}
