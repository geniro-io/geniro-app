import type { MemberTurnReading } from '../../agents/chat.types';

/** How many of a member's newest fresh starts its base is the median of. */
export const FRESH_STARTS_PER_MEMBER = 10;

/** How many of a team's newest runs the fresh-session base reads. */
export const FRESH_SESSION_RUNS_READ = 30;

/** Where a run's starts are grouped: its project, else its folder's last segment. */
export interface FreshSessionGroup {
  projectId: string | null;
  name: string;
}

export interface FreshSessionRun {
  id: string;
  cwd: string | null;
  group: FreshSessionGroup;
}

/** One member's fresh starts in one group, folded. */
export interface FreshStartFold {
  memberId: string;
  poolMember: number | null;
  agent: string | null;
  model: string | null;
  group: FreshSessionGroup;
  starts: number;
  baseTokens: number;
  baseSource: 'firstRequest' | 'lastRequest';
  minTokens: number;
  maxTokens: number;
  medianRequests: number | null;
  firstStartAt: Date;
  lastStartAt: Date;
  newestRunId: string;
  newestCwd: string | null;
}

interface FreshStart {
  reading: MemberTurnReading;
  contextTokens: number;
  usedFirstRequest: boolean;
  run: FreshSessionRun;
}

/**
 * Each member's fresh-session base per group: the median context of the newest
 * {@link FRESH_STARTS_PER_MEMBER} turns that opened a CLI session. A session is
 * opened by its first turn in a run, however that turn ended; a completed one's
 * figure is its first request's context, else its last request's. A session whose first turn did not complete, or reported no context,
 * is left out whole, since its later turns carry the conversation on top of
 * the base.
 */
export function foldFreshStarts(
  runs: readonly FreshSessionRun[],
  readings: readonly MemberTurnReading[],
  perMember: number = FRESH_STARTS_PER_MEMBER,
): FreshStartFold[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const opened = new Set<string>();
  const groups = new Map<string, FreshStart[]>();
  const ordered = [...readings].sort((a, b) =>
    a.runId === b.runId ? a.seq - b.seq : a.runId < b.runId ? -1 : 1,
  );
  for (const reading of ordered) {
    if (reading.sessionId === null) {
      continue;
    }
    const session = `${reading.runId}\u0000${reading.sessionId}`;
    if (opened.has(session)) {
      continue;
    }
    opened.add(session);
    const run = runById.get(reading.runId);
    const contextTokens = reading.contextTokens;
    if (
      reading.kind !== 'turn_complete' ||
      run === undefined ||
      contextTokens === null ||
      !Number.isFinite(contextTokens) ||
      contextTokens <= 0
    ) {
      continue;
    }
    const first = reading.firstRequestContextTokens;
    const usedFirstRequest =
      first !== null && Number.isFinite(first) && first > 0;
    const key = [
      run.group.projectId ?? `folder:${run.group.name}`,
      reading.memberId,
      reading.poolMember ?? 1,
    ].join('\u0000');
    groups.set(key, [
      ...(groups.get(key) ?? []),
      {
        reading,
        contextTokens: usedFirstRequest ? first : contextTokens,
        usedFirstRequest,
        run,
      },
    ]);
  }
  return [...groups.values()]
    .map((starts) => foldGroup(starts, perMember))
    .sort(
      (a, b) =>
        a.group.name.localeCompare(b.group.name) ||
        a.memberId.localeCompare(b.memberId) ||
        (a.poolMember ?? 1) - (b.poolMember ?? 1),
    );
}

function foldGroup(starts: FreshStart[], perMember: number): FreshStartFold {
  const newest = [...starts]
    .sort(
      (a, b) =>
        b.reading.createdAt.getTime() - a.reading.createdAt.getTime() ||
        b.reading.seq - a.reading.seq,
    )
    .slice(0, perMember);
  const head = newest[0]!;
  const tokens = newest.map((start) => start.contextTokens);
  const requests = newest
    .map((start) => start.reading.numTurns)
    .filter(
      (count): count is number => count !== null && Number.isFinite(count),
    );
  const times = newest.map((start) => start.reading.createdAt.getTime());
  return {
    memberId: head.reading.memberId,
    poolMember: head.reading.poolMember,
    agent: head.reading.agent,
    model: head.reading.model,
    group: head.run.group,
    starts: newest.length,
    baseTokens: median(tokens)!,
    baseSource: newest.every((start) => start.usedFirstRequest)
      ? 'firstRequest'
      : 'lastRequest',
    minTokens: Math.min(...tokens),
    maxTokens: Math.max(...tokens),
    medianRequests: median(requests),
    firstStartAt: new Date(Math.min(...times)),
    lastStartAt: new Date(Math.max(...times)),
    newestRunId: head.run.id,
    newestCwd: head.run.cwd,
  };
}

/** The middle value, the two middle ones averaged and rounded; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
