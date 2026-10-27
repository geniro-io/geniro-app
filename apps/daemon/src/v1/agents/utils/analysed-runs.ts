import type { Run } from '../../runs/entity/run.entity';
import type {
  AnalysedRun,
  AnalysisReadScope,
  AnalysisSource,
  AnalysisTurn,
} from '../chat.types';

/** `Run.analysisRuns` as the column stores it. */
export function writeAnalysedRuns(runs: readonly AnalysedRun[]): string {
  return JSON.stringify(
    runs.map(({ runId, snapshotSeq, working }) => ({
      runId,
      snapshotSeq,
      working,
    })),
  );
}

/**
 * `Run.analysisRuns` read back, newest first. An entry that does not read is
 * dropped rather than failing the analysis; an unreadable column reads as no
 * runs.
 */
export function readAnalysedRuns(value: string | null): AnalysedRun[] {
  if (value === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry: unknown): AnalysedRun[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { runId, snapshotSeq, working } = entry as Record<string, unknown>;
    return typeof runId === 'string' &&
      typeof snapshotSeq === 'number' &&
      Number.isInteger(snapshotSeq) &&
      snapshotSeq >= 0
      ? [{ runId, snapshotSeq, working: working === true }]
      : [];
  });
}

/**
 * What an analysis chat's turn reads, or null for a chat that is not an
 * analysis: a thread analysis reads its one source, a workflow analysis the
 * runs it was started on, the newest of them standing for a read that names
 * none.
 */
export function analysisTurnOf(
  analysisRunId: string,
  run: Pick<
    Run,
    | 'analysisSourceRunId'
    | 'analysisSourceSeq'
    | 'analysisSourceWorking'
    | 'analysisWorkflowSlug'
    | 'analysisRuns'
  >,
): AnalysisTurn | null {
  if (run.analysisSourceRunId !== null && run.analysisSourceSeq !== null) {
    return {
      analysisRunId,
      sourceRunId: run.analysisSourceRunId,
      snapshotSeq: run.analysisSourceSeq,
      sourceWorking: run.analysisSourceWorking ?? false,
    };
  }
  if (run.analysisWorkflowSlug === null) {
    return null;
  }
  const runs = readAnalysedRuns(run.analysisRuns);
  const newest = runs[0];
  if (newest === undefined) {
    return null;
  }
  return {
    analysisRunId,
    sourceRunId: newest.runId,
    snapshotSeq: newest.snapshotSeq,
    sourceWorking: newest.working,
    workflow: { slug: run.analysisWorkflowSlug, runs },
  };
}

/**
 * The run a read is about: the one `runId` names among those the analysis
 * reads, or — named none — its source (a workflow analysis's newest run).
 * Never a run outside them: the model names it, and the analysis reads only
 * what it was started on.
 */
export function analysedSourceOf(
  turn: AnalysisReadScope,
  runId: string | undefined,
): AnalysisSource | { error: string; message: string } {
  if (runId === undefined || runId === turn.sourceRunId) {
    return turn;
  }
  const run = turn.workflow?.runs.find((entry) => entry.runId === runId);
  if (run === undefined) {
    return {
      error: 'NOT_ANALYSED',
      message: turn.workflow
        ? `${runId} is not one of the runs this analysis reads — view=runs lists them.`
        : 'This analysis reads one thread: leave runId out.',
    };
  }
  return {
    sourceRunId: run.runId,
    snapshotSeq: run.snapshotSeq,
    sourceWorking: run.working,
  };
}

/**
 * Whether a run is itself an analysis — of a thread, or of a workflow across
 * its runs. Every check of it reads both columns.
 */
export function isAnalysisRun(
  run: Pick<Run, 'analysisSourceRunId' | 'analysisWorkflowSlug'>,
): boolean {
  return run.analysisSourceRunId !== null || run.analysisWorkflowSlug !== null;
}
