import type { AgentFlagRunKind, AgentFlagWire } from '../../agents/chat.types';
import {
  type FailedCall,
  groupFailures,
} from '../../agents/utils/failure-groups';
import { GENIRO_MCP_SERVER } from '../../agents/utils/tool-metric';
import {
  type DigestSignals,
  type DigestThread,
  type DigestToolError,
  type FailedToolCallsByKind,
  type PeriodToolError,
  SYSTEM_ANALYSIS_MAX_THREADS,
  SYSTEM_DIGEST_GONE_FLAGS,
  SYSTEM_DIGEST_TOOL_ERROR_CHARS,
  SYSTEM_DIGEST_TOOL_ERRORS,
  SYSTEM_DIGEST_TOOL_ERRORS_PER_THREAD,
  SYSTEM_DIGEST_TOOLS_PER_THREAD,
  SYSTEM_DIGEST_WEIGHTS,
  type SystemDigest,
  type SystemPeriod,
} from '../system-analysis.types';

/** One failed call as the digest counts it. */
export interface DigestFailedCall {
  /** Its result row. */
  seq: number;
  tool: string;
  mcpServer: string | null;
  /** What it answered; read only for geniro's own tools. */
  error: string | null;
}

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
  failedTools: readonly DigestFailedCall[];
  outcome: 'failed' | 'partial' | null;
  unmetGoals: number;
  refusedApprovals: number;
  corrections: number;
  analysisRefusals: number;
}

/** A score's signals, with the failed tool calls split by where the tool came from. */
export type DigestScoreSignals = DigestSignals & {
  failedToolCallsByKind: FailedToolCallsByKind;
};

/** geniro's own threads: what a system analysis reads that no other analysis can. */
const SYSTEM_KINDS: ReadonlySet<AgentFlagRunKind> = new Set([
  'thread_analysis',
  'team_analysis',
  'lessons',
  'lessons_check',
]);

/** What a failed geniro call is signed by when its error text could not be read. */
const NO_ERROR_TEXT = '(no error text)';

/** Shell and file tool failures are mostly ordinary command exits, so only MCP failures are weighed. */
export function digestScore(signals: DigestScoreSignals): number {
  const w = SYSTEM_DIGEST_WEIGHTS;
  const byKind = signals.failedToolCallsByKind;
  return (
    w.workFlag * signals.workFlags +
    w.disagreementFlag * signals.disagreementFlags +
    w.failedOutcome * (signals.outcome === null ? 0 : 1) +
    w.unmetGoal * signals.unmetGoals +
    w.refusal *
      (signals.refusedApprovals +
        signals.corrections +
        signals.analysisRefusals) +
    Math.min(byKind.geniro + byKind.otherMcp, w.failedToolCallsCap)
  );
}

export function failedToolCallsByKind(
  calls: readonly Pick<DigestFailedCall, 'mcpServer'>[],
): FailedToolCallsByKind {
  const byKind = { geniro: 0, otherMcp: 0, shell: 0 };
  for (const call of calls) {
    if (call.mcpServer === null) {
      byKind.shell += 1;
    } else if (call.mcpServer === GENIRO_MCP_SERVER) {
      byKind.geniro += 1;
    } else {
      byKind.otherMcp += 1;
    }
  }
  return byKind;
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
    const entry = counts.get(key) ?? {
      tool: call.tool,
      mcpServer: call.mcpServer,
      failures: 0,
    };
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

function geniroCallsOf(candidate: DigestCandidate): FailedCall[] {
  return candidate.failedTools
    .filter((call) => call.mcpServer === GENIRO_MCP_SERVER)
    .map((call) => ({
      runId: candidate.runId,
      seq: call.seq,
      resultSeq: call.seq,
      at: candidate.lastActivityAt.toISOString(),
      tool: call.tool,
      error:
        call.error === null || call.error.trim().length === 0
          ? NO_ERROR_TEXT
          : call.error,
    }));
}

function toolErrorOf(
  group: ReturnType<typeof groupFailures>[number],
): DigestToolError {
  return {
    tool: group.tool,
    signature: group.signature,
    count: group.count,
    example: group.examples[0]!,
  };
}

/**
 * The period's troubled threads, ranked: what a system analysis reads. Pure —
 * the service gathers the rows. A thread with no signal is left out; ties go
 * to the newest activity, then the run id, so the same rows always rank the
 * same way. Failed calls are counted over every candidate, ranked or not.
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
  const ranked = input.candidates
    .map((candidate) => {
      const flags = flagsByRun.get(candidate.runId) ?? [];
      const signals: DigestScoreSignals = {
        workFlags: flags.filter((flag) => flag.cost === 'work').length,
        disagreementFlags: flags.filter((flag) => flag.cost === 'disagreement')
          .length,
        outcome: candidate.outcome,
        unmetGoals: candidate.unmetGoals,
        refusedApprovals: candidate.refusedApprovals,
        corrections: candidate.corrections,
        analysisRefusals: candidate.analysisRefusals,
        failedToolCalls: candidate.failedTools.length,
        failedToolCallsByKind: failedToolCallsByKind(candidate.failedTools),
      };
      const geniroErrors = groupFailures(geniroCallsOf(candidate), 0);
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
        geniroToolErrors: geniroErrors
          .slice(0, SYSTEM_DIGEST_TOOL_ERRORS_PER_THREAD)
          .map(toolErrorOf),
        snapshotSeq: candidate.snapshotSeq,
      };
      return { candidate, thread };
    })
    .sort(
      (a, b) =>
        b.thread.score - a.thread.score ||
        Date.parse(b.thread.lastActivityAt) -
          Date.parse(a.thread.lastActivityAt) ||
        a.thread.runId.localeCompare(b.thread.runId),
    );
  const scored = ranked.filter(({ thread }) => thread.score > 0);
  const threads = scored
    .slice(0, SYSTEM_ANALYSIS_MAX_THREADS)
    .map(({ thread }) => thread);
  const read = new Set(threads.map((thread) => thread.runId));
  const allCalls = input.candidates.flatMap(
    (candidate) => candidate.failedTools,
  );
  const periodGroups = groupFailures(
    [
      ...ranked.filter(({ candidate }) => read.has(candidate.runId)),
      ...ranked.filter(({ candidate }) => !read.has(candidate.runId)),
    ].flatMap(({ candidate }) => geniroCallsOf(candidate)),
    SYSTEM_DIGEST_TOOL_ERROR_CHARS,
  );
  const geniroToolErrors: PeriodToolError[] = periodGroups
    .slice(0, SYSTEM_DIGEST_TOOL_ERRORS)
    .map((group) => {
      const error = toolErrorOf(group);
      return {
        ...error,
        threads: group.threads,
        readable: read.has(error.example.runId),
        error: group.error,
      };
    });
  return {
    period: input.period,
    totals: {
      threadsWithSignals: scored.length,
      flags: input.flags.length,
      failedToolCalls: allCalls.length,
      failedToolCallsByKind: failedToolCallsByKind(allCalls),
      geniroToolErrorGroups: periodGroups.length,
      systemThreads: scored.filter(({ thread }) =>
        SYSTEM_KINDS.has(thread.kind),
      ).length,
    },
    flags: input.flags.filter((flag) => read.has(flag.runId)),
    goneFlags: input.flags
      .filter((flag) => input.goneRunIds.has(flag.runId))
      .slice(-SYSTEM_DIGEST_GONE_FLAGS),
    geniroToolErrors,
    threads,
  };
}
