import { type Team, TeamSchema } from '../teams.types';

/** The copy of a team a run keeps — see `Run.teamSnapshot`. */
export function teamSnapshotOf(team: Team): string {
  return JSON.stringify(team);
}

/**
 * What a run's snapshot column holds, told apart three ways.
 *
 * `absent` and `unreadable` are different facts and the difference is the
 * point: an EMPTY column is a run made before runs kept a copy, which is frozen
 * from the library on its first read; a column that holds something the
 * current schema cannot read is still the graph that run STARTED with, and
 * replacing it with the library's current copy would silently run a different
 * graph under the old run's name — the defect snapshots exist to prevent.
 * `reason` is the parse's own account, for the error that says so.
 */
export type TeamSnapshotReading =
  | { state: 'absent' }
  | { state: 'readable'; team: Team }
  | { state: 'unreadable'; reason: string };

export function parseTeamSnapshot(raw: string | null): TeamSnapshotReading {
  if (raw === null) {
    return { state: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: 'unreadable',
      reason: `not JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const result = TeamSchema.safeParse(parsed);
  if (!result.success) {
    return {
      state: 'unreadable',
      reason: result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { state: 'readable', team: result.data };
}

/**
 * The team a run's snapshot holds, or null when it holds none that the
 * current schema can read.
 *
 * The LENIENT reading, for a caller that only labels a run (the stats page's
 * team name) and has a fallback either way. Anything that RUNS the graph
 * must use {@link parseTeamSnapshot}, which keeps an unreadable copy apart
 * from a missing one.
 */
export function readTeamSnapshot(raw: string | null): Team | null {
  const reading = parseTeamSnapshot(raw);
  return reading.state === 'readable' ? reading.team : null;
}
