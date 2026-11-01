import type { ChatTotalsWire } from '../../agents/chat.types';
import type { TeamChangeLogRecord } from '../../teams/teams.types';
import type {
  HistoryChange,
  HistoryRecommendationStatus,
  HistoryVersionFigures,
  HistoryVersionRef,
  RunOutcomeLedgerRow,
  TeamHistory,
  TeamRecommendationRow,
  TeamVersionsWire,
  ThreadLedgerRow,
} from '../stats.types';

/** A recommendation's `change` as the history quotes it; the chat that filed it holds the rest only while it exists. */
export const HISTORY_CHANGE_CHARS = 600;

/** Everything one team's history is folded from. */
export interface TeamHistoryInput {
  slug: string;
  /** The versions table: each version's dates, number and diff against the one before it. */
  versions: TeamVersionsWire;
  /** Every thread row stamped with the team, a deleted run's included. */
  threads: readonly ThreadLedgerRow[];
  /** Each run's spend from the usage ledger (`totalsByRun`). */
  totals: ReadonlyMap<string, ChatTotalsWire>;
  outcomes: readonly RunOutcomeLedgerRow[];
  /** Oldest first, as written: two changes in one millisecond keep their order. */
  changeLog: readonly TeamChangeLogRecord[];
  /** Oldest card first. */
  recommendations: readonly TeamRecommendationRow[];
  /** The chats among `recommendations` that still exist. */
  liveChats: ReadonlySet<string>;
  /** The runs the reading analysis was started on. */
  analysedRunIds: readonly string[];
  /** The chat reading the history, so its own entries are told apart. */
  readerRunId: string | null;
}

const NO_STATUSES: Record<HistoryRecommendationStatus, number> = {
  applied: 0,
  skipped: 0,
  failed: 0,
  selected: 0,
  open: 0,
  'not-selected': 0,
  unanswered: 0,
};

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function average(total: number | null, count: number): number | null {
  return total === null || count === 0
    ? null
    : Math.round((total / count) * 10_000) / 10_000;
}

function tenths(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : Math.round(
        (values.reduce((total, value) => total + value, 0) / values.length) *
          10,
      ) / 10;
}

function wholeAverage(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : Math.round(
        values.reduce((total, value) => total + value, 0) / values.length,
      );
}

/** Each run's questions to the user: the most any of its outcomes counted, since each counts every card before it. */
function questionsPerRun(
  prs: readonly RunOutcomeLedgerRow[],
): Map<string, number> {
  const perRun = new Map<string, number>();
  for (const pr of prs) {
    perRun.set(
      pr.runId,
      Math.max(perRun.get(pr.runId) ?? 0, pr.questionsAsked),
    );
  }
  return perRun;
}

function figuresOf(
  runIds: readonly string[],
  totals: ReadonlyMap<string, ChatTotalsWire>,
  outcomes: readonly RunOutcomeLedgerRow[],
): HistoryVersionFigures {
  let costUsd: number | null = null;
  let pricedRuns = 0;
  let turns = 0;
  let cliWorkedMs: number | null = null;
  let timedRuns = 0;
  for (const runId of runIds) {
    const run = totals.get(runId);
    if (run === undefined) {
      continue;
    }
    turns += run.turns;
    if (run.costUsd !== null) {
      costUsd = (costUsd ?? 0) + run.costUsd;
      pricedRuns += 1;
    }
    if (run.workedMs !== null) {
      cliWorkedMs = (cliWorkedMs ?? 0) + run.workedMs;
      timedRuns += 1;
    }
  }
  const ids = new Set(runIds);
  const prs = outcomes.filter((outcome) => ids.has(outcome.runId));
  return {
    runs: runIds.length,
    pricedRuns,
    costUsd: costUsd === null ? null : Math.round(costUsd * 10_000) / 10_000,
    avgCostUsd: average(costUsd, pricedRuns),
    turns,
    avgTurns: average(turns, runIds.length),
    cliWorkedMs,
    avgCliWorkedMs:
      cliWorkedMs === null || timedRuns === 0
        ? null
        : Math.round(cliWorkedMs / timedRuns),
    pullRequests: {
      total: prs.length,
      accepted: prs.filter((pr) => pr.acceptance === 'accepted').length,
      changesRequested: prs.filter(
        (pr) => pr.acceptance === 'changes_requested',
      ).length,
      notYet: prs.filter((pr) => pr.acceptance === 'not_yet').length,
      notNeeded: prs.filter((pr) => pr.acceptance === 'not_needed').length,
      avgReviewRounds: tenths(prs.map((pr) => pr.reviewRounds)),
      avgChangesRequestedRounds: tenths(
        prs.flatMap((pr) =>
          pr.changesRequestedRounds === null ? [] : [pr.changesRequestedRounds],
        ),
      ),
      avgMsToAccepted: wholeAverage(
        prs.flatMap((pr) =>
          pr.msToAccepted === null ? [] : [pr.msToAccepted],
        ),
      ),
      avgQuestionsPerRun: tenths([
        ...questionsPerRun(
          prs.filter((pr) => pr.changesRequestedRounds !== null),
        ).values(),
      ]),
    },
  };
}

function statusOf(
  row: TeamRecommendationRow,
  chatStillExists: boolean,
  cardApplied: boolean,
): HistoryRecommendationStatus {
  if (
    row.outcome === 'applied' ||
    row.outcome === 'skipped' ||
    row.outcome === 'failed'
  ) {
    return row.outcome;
  }
  if (row.selectedAt !== null) {
    return 'selected';
  }
  if (cardApplied) {
    return 'not-selected';
  }
  return chatStillExists ? 'open' : 'unanswered';
}

/**
 * One team's history for an analysis: every version with what its runs
 * did and how its graph differs from the version before it, every logged write
 * with who made it and why, and every recommendation filed about it with what
 * became of it — so an analysis can judge its earlier changes by their runs.
 * Newest first throughout.
 */
export function foldTeamHistory(input: TeamHistoryInput): TeamHistory {
  const numbers = new Map<string, number>();
  for (const row of input.versions.versions) {
    if (row.version !== null && row.ordinal !== null) {
      numbers.set(row.version, row.ordinal);
    }
  }
  const ref = (version: string): HistoryVersionRef => ({
    version,
    number: numbers.get(version) ?? null,
    current: version === input.versions.currentVersion,
  });

  const runsByVersion = new Map<string | null, string[]>();
  for (const thread of input.threads) {
    const list = runsByVersion.get(thread.version) ?? [];
    list.push(thread.runId);
    runsByVersion.set(thread.version, list);
  }
  const analysed = new Set(input.analysedRunIds);
  const versionOfRun = new Map(
    input.threads.map((thread) => [thread.runId, thread.version]),
  );

  const changeLog: HistoryChange[] = [...input.changeLog]
    .reverse()
    .map((entry) => ({
      at: entry.changedAt.toISOString(),
      source: entry.source,
      from: entry.fromVersion === null ? null : ref(entry.fromVersion),
      to: ref(entry.toVersion),
      summary: entry.summary,
      reason: entry.reason,
      userNote: entry.userNote,
      recommendationIds: entry.recommendationIds,
      chatRunId: entry.chatRunId,
      byThisChat:
        input.readerRunId !== null && entry.chatRunId === input.readerRunId,
      backup: entry.backup,
    }));

  const rows = [
    ...input.versions.versions,
    ...(input.versions.unversioned === null
      ? []
      : [input.versions.unversioned]),
  ];
  const versions: TeamHistory['versions'] = rows.map((row) => {
    const runIds = runsByVersion.get(row.version) ?? [];
    return {
      version: row.version === null ? null : ref(row.version),
      inferred: row.inferred,
      firstRunAt: row.firstRunAt,
      lastRunAt: row.lastRunAt,
      analysedRunIds: runIds.filter((runId) => analysed.has(runId)),
      figures: figuresOf(runIds, input.totals, input.outcomes),
      madeBy:
        row.version === null
          ? []
          : changeLog
              .filter((change) => change.to.version === row.version)
              .map(({ at, source, summary, recommendationIds }) => ({
                at,
                source,
                summary,
                recommendationIds,
              })),
      changes: row.changes,
    };
  });

  const statuses = { ...NO_STATUSES };
  const cards = new Map<string, TeamHistory['recommendations'][number]>();
  const cardKey = (row: TeamRecommendationRow): string =>
    JSON.stringify([row.chatRunId, row.cardSeq]);
  const appliedCards = new Set(
    input.recommendations.flatMap((row) =>
      row.selectedAt === null ? [] : [cardKey(row)],
    ),
  );
  for (const row of input.recommendations) {
    const key = cardKey(row);
    const chatStillExists = input.liveChats.has(row.chatRunId);
    const card = cards.get(key) ?? {
      chatRunId: row.chatRunId,
      chat: row.chatKind,
      byThisChat:
        input.readerRunId !== null && row.chatRunId === input.readerRunId,
      chatStillExists,
      cardSeq: row.cardSeq,
      filedAt: row.filedAt.toISOString(),
      libraryVersion:
        row.libraryVersion === null ? null : ref(row.libraryVersion),
      items: [],
    };
    const status = statusOf(row, chatStillExists, appliedCards.has(key));
    statuses[status] += 1;
    card.items.push({
      id: row.itemId,
      target: row.target,
      territory: row.territory,
      kind: row.kind,
      location: row.location,
      title: row.title,
      change: clip(row.change, HISTORY_CHANGE_CHARS),
      rootCause: row.rootCause,
      expectedMinutesSavedPerRun: row.minutesSaved,
      expectedCostSavedPerRunUsd: row.costSavedUsd,
      expectedOutcome: row.expectedOutcome,
      confidence: row.confidence,
      risk: row.risk,
      status,
      note: row.outcomeNote,
      selectedAt: row.selectedAt?.toISOString() ?? null,
      decidedAt: row.outcomeAt?.toISOString() ?? null,
      changedIn: changeLog
        .filter(
          (change) =>
            change.chatRunId === row.chatRunId &&
            change.recommendationIds.includes(row.itemId),
        )
        .map((change) => ({ at: change.at, to: change.to })),
    });
    cards.set(key, card);
  }

  const analysedByVersion = new Map<string | null, string[]>();
  for (const runId of input.analysedRunIds) {
    const version = versionOfRun.get(runId) ?? null;
    const list = analysedByVersion.get(version) ?? [];
    list.push(runId);
    analysedByVersion.set(version, list);
  }

  return {
    team: input.slug,
    currentVersion:
      input.versions.currentVersion === null
        ? null
        : ref(input.versions.currentVersion),
    summary: {
      versions: input.versions.versions.length,
      changesLogged: changeLog.length,
      recommendations: statuses,
      analysedRunsByVersion: [...analysedByVersion].map(
        ([version, runIds]) => ({
          version: version === null ? null : ref(version),
          runIds,
        }),
      ),
    },
    versions,
    changeLog,
    recommendations: [...cards.values()].reverse(),
  };
}
