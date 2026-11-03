import type { ChatTotalsWire } from '../../agents/chat.types';
import type {
  Team,
  TeamChangeLogRecord,
  TeamMember,
} from '../../teams/teams.types';
import { instructionBlocksByMember } from '../../teams/utils/member-instructions';
import type {
  MemberChangeEffect,
  MemberChangeKind,
  MemberChangeUnit,
  MemberChangeWire,
  ThreadLedgerRow,
} from '../stats.types';
import { isCleanRun, type MemberRunCells } from './member-work-fold';

/** A figure must move by this share of where it stood (a share: by this much) to count. */
const MOVE_THRESHOLD = 0.1;

/** Fewer runs than this on either side of a change tell nothing about it. */
const MIN_RUNS_PER_SIDE = 2;

export interface MemberChangeInput {
  /** Every thread row of the team, with the version it ran and when. */
  threads: readonly Pick<ThreadLedgerRow, 'runId' | 'version' | 'occurredAt'>[];
  cells: MemberRunCells;
  /** Each run's whole spend (`totalsByRun`). */
  teamSpend: ReadonlyMap<string, ChatTotalsWire>;
  /** Each recorded version's team. */
  teams: ReadonlyMap<string, Team>;
  versionRef: (version: string) => { number: number | null; current: boolean };
  /** Oldest first. */
  changeLog: readonly TeamChangeLogRecord[];
}

type Figures = NonNullable<MemberChangeWire['before']>;

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

const MEMBER_FIELDS: readonly [MemberChangeKind, (keyof TeamMember)[]][] = [
  ['role', ['role']],
  ['instructions', ['instructions']],
  ['character', ['character']],
  ['agent', ['agent', 'configDir']],
  ['model', ['model', 'contextWindow', 'modelParameters']],
  ['effort', ['effort']],
  ['approval', ['approval']],
  ['pool', ['pool']],
  ['tools', ['mcpDisabled']],
];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function ownedStages(team: Team, memberId: string): string[] {
  return (team.stages ?? [])
    .filter((stage) => stage.responsible?.includes(memberId))
    .map((stage) => stage.id)
    .sort();
}

/** What changed for each member between two versions of the team. */
export function memberDiff(
  before: Team,
  after: Team,
): Map<string, MemberChangeKind[]> {
  const was = new Map(before.members.map((member) => [member.id, member]));
  const is = new Map(after.members.map((member) => [member.id, member]));
  const blocksBefore = instructionBlocksByMember(before);
  const blocksAfter = instructionBlocksByMember(after);
  const kinds = new Map<string, MemberChangeKind[]>();
  for (const id of new Set([...was.keys(), ...is.keys()])) {
    const old = was.get(id);
    const now = is.get(id);
    if (old === undefined) {
      kinds.set(id, ['added']);
      continue;
    }
    if (now === undefined) {
      kinds.set(id, ['removed']);
      continue;
    }
    const changed: MemberChangeKind[] = MEMBER_FIELDS.filter(([, fields]) =>
      fields.some((field) => !same(old[field], now[field])),
    ).map(([kind]) => kind);
    if (!same(ownedStages(before, id), ownedStages(after, id))) {
      changed.push('stages');
    }
    if (
      !same(
        (blocksBefore.get(id) ?? []).map((block) => block.text),
        (blocksAfter.get(id) ?? []).map((block) => block.text),
      )
    ) {
      changed.push('blocks');
    }
    if (changed.length > 0) {
      kinds.set(id, changed);
    }
  }
  return kinds;
}

function memberFigures(
  cells: MemberRunCells,
  memberId: string,
  runIds: readonly string[],
): Figures {
  const runs = cells.get(memberId);
  const taken = runIds.flatMap((runId) => {
    const cell = runs?.get(runId);
    return cell === undefined ? [] : [cell];
  });
  const measured = taken.filter((cell) => cell.measured);
  const sum = (pick: (cell: (typeof measured)[number]) => number): number =>
    measured.reduce((total, cell) => total + pick(cell), 0);
  return {
    runs: taken.length,
    costPerRunUsd: average(
      taken.flatMap((cell) =>
        cell.spend.costUsd === null ? [] : [cell.spend.costUsd],
      ),
    ),
    workedPerRunMs: average(
      taken.flatMap((cell) =>
        cell.spend.workedMs === null ? [] : [cell.spend.workedMs],
      ),
    ),
    callFailureShare: share(
      sum((cell) => cell.callsFailed),
      sum((cell) => cell.callsAnswered),
    ),
    reworkShare: share(
      sum((cell) => cell.completionsReopened),
      sum((cell) => cell.stagesCompleted),
    ),
    cleanShare: share(measured.filter(isCleanRun).length, measured.length),
  };
}

function teamFigures(
  teamSpend: ReadonlyMap<string, ChatTotalsWire>,
  runIds: readonly string[],
): MemberChangeWire['team']['before'] {
  const spends = runIds.flatMap((runId) => {
    const spend = teamSpend.get(runId);
    return spend === undefined ? [] : [spend];
  });
  return {
    runs: runIds.length,
    costPerRunUsd: average(
      spends.flatMap((spend) =>
        spend.costUsd === null ? [] : [spend.costUsd],
      ),
    ),
    workedPerRunMs: average(
      spends.flatMap((spend) =>
        spend.workedMs === null ? [] : [spend.workedMs],
      ),
    ),
  };
}

interface Movable {
  figure: string;
  unit: MemberChangeUnit;
  from: number | null;
  to: number | null;
  better: 'lower' | 'higher';
}

function movedOf(figures: readonly Movable[]): MemberChangeWire['moved'] {
  return figures.flatMap(({ figure, unit, from, to, better }) => {
    if (from === null || to === null || from === to) {
      return [];
    }
    const delta = to - from;
    const moved =
      unit === 'share'
        ? Math.abs(delta) >= MOVE_THRESHOLD
        : from !== 0 && Math.abs(delta) / Math.abs(from) >= MOVE_THRESHOLD;
    if (!moved) {
      return [];
    }
    const down = delta < 0;
    return [
      {
        figure,
        unit,
        from,
        to,
        direction: (better === 'lower') === down ? 'better' : 'worse',
      },
    ];
  });
}

function effectOf(
  moved: MemberChangeWire['moved'],
  runsBefore: number,
  runsAfter: number,
): MemberChangeEffect {
  if (runsBefore < MIN_RUNS_PER_SIDE || runsAfter < MIN_RUNS_PER_SIDE) {
    return 'too-few-runs';
  }
  const better = moved.some((entry) => entry.direction === 'better');
  const worse = moved.some((entry) => entry.direction === 'worse');
  return better && worse
    ? 'mixed'
    : better
      ? 'better'
      : worse
        ? 'worse'
        : 'no-change';
}

/**
 * Every change between consecutive team versions that touched a member, as
 * its runs measured it on either side — newest first, per member. A change is
 * a move between the versions two runs in a row ran (a restore included), and
 * is counted once whichever way it recurs. A member's own figures compare its
 * runs of each version; a member added or removed is judged by the team's.
 */
export function foldMemberChanges(
  input: MemberChangeInput,
): Map<string, MemberChangeWire[]> {
  const ordered = [...input.threads].sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.runId.localeCompare(b.runId),
  );
  const runsOf = new Map<string, string[]>();
  for (const thread of ordered) {
    if (thread.version === null) {
      continue;
    }
    const list = runsOf.get(thread.version) ?? [];
    list.push(thread.runId);
    runsOf.set(thread.version, list);
  }
  const transitions: { from: string; to: string; at: Date }[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const thread of ordered) {
    if (thread.version === null) {
      continue;
    }
    if (previous !== null && thread.version !== previous) {
      const key = JSON.stringify([previous, thread.version]);
      if (!seen.has(key)) {
        seen.add(key);
        transitions.push({
          from: previous,
          to: thread.version,
          at: thread.occurredAt,
        });
      }
    }
    previous = thread.version;
  }

  const byMember = new Map<string, MemberChangeWire[]>();
  for (const { from, to, at } of transitions) {
    const before = input.teams.get(from);
    const after = input.teams.get(to);
    if (before === undefined || after === undefined) {
      continue;
    }
    const runsBefore = runsOf.get(from) ?? [];
    const runsAfter = runsOf.get(to) ?? [];
    const team = {
      before: teamFigures(input.teamSpend, runsBefore),
      after: teamFigures(input.teamSpend, runsAfter),
    };
    const logged = [...input.changeLog]
      .reverse()
      .find(
        (entry) =>
          entry.toVersion === to &&
          (entry.fromVersion === null || entry.fromVersion === from),
      );
    for (const [memberId, kinds] of memberDiff(before, after)) {
      const own = {
        before: kinds.includes('added')
          ? null
          : memberFigures(input.cells, memberId, runsBefore),
        after: kinds.includes('removed')
          ? null
          : memberFigures(input.cells, memberId, runsAfter),
      };
      const moved =
        own.before !== null && own.after !== null
          ? movedOf([
              {
                figure: 'cost per run',
                unit: 'usd',
                from: own.before.costPerRunUsd,
                to: own.after.costPerRunUsd,
                better: 'lower',
              },
              {
                figure: 'working time per run',
                unit: 'ms',
                from: own.before.workedPerRunMs,
                to: own.after.workedPerRunMs,
                better: 'lower',
              },
              {
                figure: 'failed calls',
                unit: 'share',
                from: own.before.callFailureShare,
                to: own.after.callFailureShare,
                better: 'lower',
              },
              {
                figure: 'rework',
                unit: 'share',
                from: own.before.reworkShare,
                to: own.after.reworkShare,
                better: 'lower',
              },
              {
                figure: 'clean runs',
                unit: 'share',
                from: own.before.cleanShare,
                to: own.after.cleanShare,
                better: 'higher',
              },
            ])
          : movedOf([
              {
                figure: 'team cost per run',
                unit: 'usd',
                from: team.before.costPerRunUsd,
                to: team.after.costPerRunUsd,
                better: 'lower',
              },
              {
                figure: 'team working time per run',
                unit: 'ms',
                from: team.before.workedPerRunMs,
                to: team.after.workedPerRunMs,
                better: 'lower',
              },
            ]);
      const list = byMember.get(memberId) ?? [];
      list.push({
        from: input.versionRef(from),
        to: input.versionRef(to),
        at: at.toISOString(),
        kinds,
        source: logged?.source ?? null,
        summary: logged?.summary ?? null,
        recommendationIds: logged?.recommendationIds ?? [],
        before: own.before,
        after: own.after,
        team,
        effect:
          own.before !== null && own.after !== null
            ? effectOf(moved, own.before.runs, own.after.runs)
            : effectOf(moved, team.before.runs, team.after.runs),
        moved,
      });
      byMember.set(memberId, list);
    }
  }
  for (const list of byMember.values()) {
    list.reverse();
  }
  return byMember;
}
