import { setImmediate as nextTick } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { AnalysedRun } from '../../agents/chat.types';
import { AgentFlagDao } from '../../agents/dao/agent-flag.dao';
import { GoalDao } from '../../agents/dao/goal.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { type DigestRunFacts, RunDao } from '../../agents/dao/run.dao';
import {
  agentFlagRunKindOf,
  agentFlagWire,
} from '../../agents/utils/agent-flags';
import { eventLoopSlicer } from '../../agents/utils/event-loop-slices';
import { failedCallErrors } from '../../agents/utils/failed-call-errors';
import { librarySlugOf } from '../../agents/utils/run-kind';
import { runSnapshotOf } from '../../agents/utils/run-snapshots';
import { GENIRO_MCP_SERVER } from '../../agents/utils/tool-metric';
import { LessonProposalDao } from '../../lessons/dao/lesson-proposal.dao';
import { readLessonSignals } from '../../lessons/utils/read-lesson-signals';
import { MetricLedgerDao } from '../../stats/dao/metric-ledger.dao';
import { ToolUsageService } from '../../stats/services/tool-usage.service';
import {
  SYSTEM_DIGEST_PAYLOAD_CANDIDATES,
  type SystemDigest,
} from '../system-analysis.types';
import {
  type DigestCandidate,
  type DigestFailedCall,
  digestScore,
  digestToolUsage,
  failedToolCallsByKind,
  foldSystemDigest,
} from '../utils/system-digest.fold';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The period of the last `days` days, ending now. */
export function systemPeriodOf(
  days: number,
  now = new Date(),
): { from: Date; to: Date; days: number } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now, days };
}

/**
 * Builds what a system analysis reads: the period's troubled threads, ranked.
 *
 * better-sqlite3 holds the event loop for every statement, so the ledgers —
 * flags, failed tool calls, outcomes, goals, dropped lessons — are read first
 * in a few indexed statements, and only the best candidates' transcripts are
 * read for corrections and refused approvals, one run at a time with a turn of
 * the loop between them.
 */
@Injectable()
export class SystemDigestService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly goalDao: GoalDao,
    private readonly flagDao: AgentFlagDao,
    private readonly ledger: MetricLedgerDao,
    private readonly lessonProposals: LessonProposalDao,
    private readonly toolUsage: ToolUsageService,
  ) {}

  /** The digest, and the threads it ranks pinned at their snapshots: what a system analysis reads. */
  async build(period: {
    from: Date;
    to: Date;
    days: number;
  }): Promise<{ digest: SystemDigest; runs: AnalysedRun[] }> {
    const em = this.em.fork();
    const window = { since: period.from, until: period.to };
    const [active, flags, failedCalls] = await Promise.all([
      this.runDao.runIdsActiveIn(window, em),
      this.flagDao.inPeriod(period.from, period.to, em),
      this.ledger.failedToolCalls(period.from, period.to, em),
    ]);
    const ids = [
      ...new Set([
        ...active,
        ...flags.map((flag) => flag.runId),
        ...failedCalls.map((call) => call.runId),
      ]),
    ];
    const facts = await this.runDao.digestFactsOf(ids, em);
    const existing = await this.runDao.existingIds(ids, em);
    const goneRunIds = new Set(ids.filter((id) => !existing.has(id)));
    const runIds = facts.map((run) => run.id);
    const [outcomes, goals, dropped] = await Promise.all([
      this.ledger.threadOutcomes({ runIds }, em),
      this.goalDao.statusesOf({ runIds }, em),
      this.lessonProposals.droppedByCheckOf(runIds, em),
    ]);
    const newestOutcome = new Map<string, { seq: number; kind: string }>();
    for (const outcome of outcomes) {
      const held = newestOutcome.get(outcome.runId);
      if (held === undefined || outcome.seq > held.seq) {
        newestOutcome.set(outcome.runId, {
          seq: outcome.seq,
          kind: outcome.kind,
        });
      }
    }
    const unmet = new Map<string, number>();
    for (const goal of goals) {
      if (goal.status === 'not_achieved') {
        unmet.set(goal.runId, (unmet.get(goal.runId) ?? 0) + 1);
      }
    }
    const failedByRun = new Map<string, DigestFailedCall[]>();
    for (const call of failedCalls) {
      const list = failedByRun.get(call.runId) ?? [];
      list.push({
        seq: call.seq,
        tool: call.tool,
        mcpServer: call.mcpServer,
        error: null,
      });
      failedByRun.set(call.runId, list);
    }
    await this.readGeniroErrors(runIds, failedByRun);
    const counted = new Set([...runIds, ...goneRunIds]);
    const wires = flags
      .filter((flag) => counted.has(flag.runId))
      .map(agentFlagWire);
    const candidates = facts.map((run) =>
      this.candidateOf(run, {
        failedTools: failedByRun.get(run.id) ?? [],
        outcome: newestOutcome.get(run.id)?.kind ?? null,
        unmetGoals: unmet.get(run.id) ?? 0,
        analysisRefusals: dropped.get(run.id) ?? 0,
      }),
    );
    await this.readTranscripts(candidates, wires);
    const digest = foldSystemDigest({
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        days: period.days,
      },
      candidates,
      flags: wires,
      goneRunIds,
    });
    const usage = digestToolUsage(
      await this.toolUsage.list(),
      period.to.toISOString(),
    );
    digest.toolUsage = usage;
    digest.totals.toolUsage = {
      subjects: usage.subjects,
      calls: usage.calls,
      neverCalled: usage.neverCalled.length,
    };
    const runs: AnalysedRun[] = [];
    for (const thread of digest.threads) {
      const snapshot = await runSnapshotOf(
        { em: this.em, runDao: this.runDao, itemDao: this.itemDao },
        thread.runId,
      );
      thread.snapshotSeq = snapshot.snapshotSeq;
      runs.push({ runId: thread.runId, ...snapshot });
    }
    return { digest, runs };
  }

  private candidateOf(
    run: DigestRunFacts,
    ledger: Pick<
      DigestCandidate,
      'failedTools' | 'unmetGoals' | 'analysisRefusals'
    > & { outcome: string | null },
  ): DigestCandidate {
    return {
      runId: run.id,
      title: run.title,
      kind: agentFlagRunKindOf(run),
      teamSlug: librarySlugOf(run.teamId),
      projectId: run.projectId,
      archived: run.archivedAt !== null,
      lastActivityAt: run.updatedAt,
      snapshotSeq: -1,
      failedTools: ledger.failedTools,
      outcome:
        ledger.outcome === 'failed' || ledger.outcome === 'partial'
          ? ledger.outcome
          : null,
      unmetGoals: ledger.unmetGoals,
      refusedApprovals: 0,
      corrections: 0,
      analysisRefusals: ledger.analysisRefusals,
    };
  }

  /**
   * The error text of every failed call of geniro's own tools among `runIds`,
   * read off its result row; the other failures are only counted.
   */
  private async readGeniroErrors(
    runIds: readonly string[],
    failedByRun: ReadonlyMap<string, DigestFailedCall[]>,
  ): Promise<void> {
    const yieldTurn = eventLoopSlicer();
    for (const runId of runIds) {
      const geniro = (failedByRun.get(runId) ?? []).filter(
        (call) => call.mcpServer === GENIRO_MCP_SERVER,
      );
      if (geniro.length === 0) {
        continue;
      }
      const errors = await failedCallErrors(
        this.itemDao,
        runId,
        geniro.map((call) => call.seq),
        Number.MAX_SAFE_INTEGER,
        this.em.fork(),
        yieldTurn,
      );
      for (const call of geniro) {
        call.error = errors.get(call.seq) ?? null;
      }
    }
  }

  /**
   * Corrections and refused approvals, read off the transcripts of the
   * candidates the ledgers rank highest — at most
   * {@link SYSTEM_DIGEST_PAYLOAD_CANDIDATES}, one run per turn of the loop.
   */
  private async readTranscripts(
    candidates: DigestCandidate[],
    flags: Parameters<typeof foldSystemDigest>[0]['flags'],
  ): Promise<void> {
    const flagCounts = new Map<
      string,
      { work: number; disagreement: number }
    >();
    for (const flag of flags) {
      const counts = flagCounts.get(flag.runId) ?? { work: 0, disagreement: 0 };
      counts[flag.cost] += 1;
      flagCounts.set(flag.runId, counts);
    }
    const ledgerScore = (candidate: DigestCandidate): number =>
      digestScore({
        workFlags: flagCounts.get(candidate.runId)?.work ?? 0,
        disagreementFlags: flagCounts.get(candidate.runId)?.disagreement ?? 0,
        outcome: candidate.outcome,
        unmetGoals: candidate.unmetGoals,
        refusedApprovals: 0,
        corrections: 0,
        analysisRefusals: candidate.analysisRefusals,
        failedToolCalls: candidate.failedTools.length,
        failedToolCallsByKind: failedToolCallsByKind(candidate.failedTools),
      });
    const ranked = candidates
      .map((candidate) => ({ candidate, score: ledgerScore(candidate) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.candidate.lastActivityAt.getTime() -
            a.candidate.lastActivityAt.getTime() ||
          a.candidate.runId.localeCompare(b.candidate.runId),
      )
      .slice(0, SYSTEM_DIGEST_PAYLOAD_CANDIDATES);
    for (const { candidate } of ranked) {
      await nextTick();
      const em = this.em.fork();
      const maxSeq = await this.itemDao.maxSeq(candidate.runId, em);
      const signals = await readLessonSignals(
        { itemDao: this.itemDao, goalDao: this.goalDao },
        candidate.runId,
        -1,
        maxSeq,
        em,
      );
      candidate.corrections = signals.filter(
        (signal) => signal.kind === 'user_correction',
      ).length;
      candidate.refusedApprovals = signals.filter(
        (signal) => signal.kind === 'approval_refused',
      ).length;
    }
  }
}
