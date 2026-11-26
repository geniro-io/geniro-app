import type { AgentFlagRunKind, AgentFlagWire } from '../../agents/chat.types';
import {
  type DigestSignals,
  type DigestThread,
  SYSTEM_ANALYSIS_MAX_THREADS,
  SYSTEM_DIGEST_GONE_FLAGS,
  SYSTEM_DIGEST_SYSTEM_THREADS,
  SYSTEM_DIGEST_TOOLS_PER_THREAD,
  SYSTEM_DIGEST_WEIGHTS,
  type SystemDigest,
  type SystemPeriod,
} from '../system-analysis.types';

/** One thread active in the period, with everything the score reads. */
export interface DigestCandidate {
  runId: string;
  title: string | null;
  kind: AgentFlagRunKind;
  teamSlug: string | null;
  projectId: string | null;
  archived: boolean;
  lastActivityAt: Date;
  snapshotSeq: number;
  /** One entry per failed call in the period. */
  failedTools: readonly { tool: string; mcpServer: string | null }[];
  outcome: 'failed' | 'partial' | null;
  unmetGoals: number;
  refusedApprovals: number;
  corrections: number;
  analysisRefusals: number;
}

/** geniro's own threads: what a system analysis reads that no other analysis can. */
const SYSTEM_KINDS: ReadonlySet<AgentFlagRunKind> = new Set([
  'thread_analysis',
  'team_analysis',
  'lessons',
  'lessons_check',
  'system_analysis',
]);

export function digestScore(signals: DigestSignals): number {
  const w = SYSTEM_DIGEST_WEIGHTS;
  return (
    w.workFlag * signals.workFlags +
    w.disagreementFlag * signals.disagreementFlags +
    w.failedOutcome * (signals.outcome === null ? 0 : 1) +
    w.unmetGoal * signals.unmetGoals +
    w.refusal *
      (signals.refusedApprovals +
        signals.corrections +
        signals.analysisRefusals) +
    Math.min(signals.failedToolCalls, w.failedToolCallsCap)
  );
}

/**
 * Keeps the items of a ranked list in order, each group only while it holds
 * fewer than its cap: geniro's own threads and the user's are capped apart, so
 * a full group never takes the other's place.
 */
export function withSystemSlots<T>(
  ranked: readonly T[],
  kindOf: (item: T) => AgentFlagRunKind,
  caps: { user: number; system: number },
): T[] {
  const taken = { user: 0, system: 0 };
  return ranked.filter((item) => {
    const group = SYSTEM_KINDS.has(kindOf(item)) ? 'system' : 'user';
    if (taken[group] >= caps[group]) {
      return false;
    }
    taken[group] += 1;
    return true;
  });
}

function failedToolsOf(
  calls: DigestCandidate['failedTools'],
): DigestThread['failedTools'] {
  const counts = new Map<
    string,
    { tool: string; mcpServer: string | null; failures: number }
  >();
  for (const call of calls) {
    const key = `${call.mcpServer ?? ''}\u0000${call.tool}`;
    const entry = counts.get(key) ?? { ...call, failures: 0 };
    entry.failures += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort(
      (a, b) =>
        b.failures - a.failures ||
        a.tool.localeCompare(b.tool) ||
        (a.mcpServer ?? '').localeCompare(b.mcpServer ?? ''),
    )
    .slice(0, SYSTEM_DIGEST_TOOLS_PER_THREAD);
}

/**
 * The period's troubled threads, ranked: what a system analysis reads. Pure —
 * the service gathers the rows. A thread with no signal is left out; ties go
 * to the newest activity, then the run id, so the same rows always rank the
 * same way. Up to SYSTEM_ANALYSIS_MAX_THREADS of the user's threads are pinned
 * and up to SYSTEM_DIGEST_SYSTEM_THREADS of geniro's own, each group in that
 * order.
 */
export function foldSystemDigest(input: {
  period: SystemPeriod;
  candidates: readonly DigestCandidate[];
  /** Every flag raised in the period, deleted threads' included. */
  flags: readonly AgentFlagWire[];
  /** Runs that no longer exist. */
  goneRunIds: ReadonlySet<string>;
}): SystemDigest {
  const flagsByRun = new Map<string, AgentFlagWire[]>();
  for (const flag of input.flags) {
    const list = flagsByRun.get(flag.runId) ?? [];
    list.push(flag);
    flagsByRun.set(flag.runId, list);
  }
  const scored = input.candidates
    .map((candidate) => {
      const flags = flagsByRun.get(candidate.runId) ?? [];
      const signals: DigestSignals = {
        workFlags: flags.filter((flag) => flag.cost === 'work').length,
        disagreementFlags: flags.filter((flag) => flag.cost === 'disagreement')
          .length,
        outcome: candidate.outcome,
        unmetGoals: candidate.unmetGoals,
        refusedApprovals: candidate.refusedApprovals,
        corrections: candidate.corrections,
        analysisRefusals: candidate.analysisRefusals,
        failedToolCalls: candidate.failedTools.length,
      };
      const thread: DigestThread = {
        runId: candidate.runId,
        title: candidate.title,
        kind: candidate.kind,
        teamSlug: candidate.teamSlug,
        projectId: candidate.projectId,
        archived: candidate.archived,
        lastActivityAt: candidate.lastActivityAt.toISOString(),
        score: digestScore(signals),
        signals,
        failedTools: failedToolsOf(candidate.failedTools),
        snapshotSeq: candidate.snapshotSeq,
      };
      return thread;
    })
    .filter((thread) => thread.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
        a.runId.localeCompare(b.runId),
    );
  const threads = withSystemSlots(scored, (thread) => thread.kind, {
    user: SYSTEM_ANALYSIS_MAX_THREADS,
    system: SYSTEM_DIGEST_SYSTEM_THREADS,
  });
  const read = new Set(threads.map((thread) => thread.runId));
  return {
    period: input.period,
    totals: {
      threadsWithSignals: scored.length,
      flags: input.flags.length,
      failedToolCalls: scored.reduce(
        (sum, thread) => sum + thread.signals.failedToolCalls,
        0,
      ),
      systemThreads: scored.filter((thread) => SYSTEM_KINDS.has(thread.kind))
        .length,
    },
    flags: input.flags.filter((flag) => read.has(flag.runId)),
    goneFlags: input.flags
      .filter((flag) => input.goneRunIds.has(flag.runId))
      .slice(-SYSTEM_DIGEST_GONE_FLAGS),
    threads,
  };
}
