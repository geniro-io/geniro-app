import { describe, expect, it } from 'vitest';

import { emptyTotals } from '../../agents/utils/usage-figures';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { Team, TeamChangeLogRecord } from '../../teams/teams.types';
import { foldMemberChanges, memberDiff } from './member-change-fold';
import type { MemberRunCell } from './member-work-fold';

function cell(over: Partial<MemberRunCell> = {}): MemberRunCell {
  return {
    measured: true,
    spend: { ...emptyTotals(), costUsd: 1, workedMs: 60_000 },
    callsAnswered: 0,
    callsFailed: 0,
    timedAnswers: 0,
    answerMs: 0,
    callsMade: 0,
    toolCalls: 0,
    toolErrors: 0,
    goals: { recorded: 0, achieved: 0, notAchieved: 0, open: 0, dropped: 0 },
    stagesCompleted: 0,
    completionsReopened: 0,
    ...over,
  };
}

function spent(costUsd: number | null, workedMs: number | null) {
  return { ...emptyTotals(), costUsd, workedMs };
}

const stage = (id: string, responsible: string[]) => ({
  id,
  title: id,
  goal: `${id} done`,
  responsible,
});

const V1: Team = teamOf(
  [member('lead'), { ...member('reviewer'), model: 'opus' }, member('echo')],
  { stages: [stage('review', ['reviewer'])] },
);
const V2: Team = {
  ...V1,
  members: [
    V1.members[0]!,
    { ...V1.members[1]!, model: 'sonnet', instructions: 'Review once.' },
  ],
  stages: [stage('review', ['lead'])],
};

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));

describe('memberDiff', () => {
  it('names what changed for each member, a member added or removed, and leaves the rest out', () => {
    const v3: Team = {
      ...V2,
      members: [...V2.members, { ...member('qa'), role: 'Runs the tests' }],
      instructionBlocks: [
        {
          id: 'block-1',
          title: 'Style',
          text: 'Be brief.',
          audience: ['lead'],
        },
      ],
    };

    expect(Object.fromEntries(memberDiff(V1, V2))).toEqual({
      reviewer: ['instructions', 'model', 'stages'],
      lead: ['stages'],
      echo: ['removed'],
    });
    expect(Object.fromEntries(memberDiff(V2, v3))).toEqual({
      qa: ['added'],
      lead: ['blocks'],
    });
  });
});

describe('foldMemberChanges', () => {
  const threads = [
    { runId: 'a1', version: 'v1', occurredAt: at(1) },
    { runId: 'a2', version: 'v1', occurredAt: at(2) },
    { runId: 'b1', version: 'v2', occurredAt: at(3) },
    { runId: 'b2', version: 'v2', occurredAt: at(4) },
    { runId: 'c1', version: 'v1', occurredAt: at(5) },
    { runId: 'b3', version: 'v2', occurredAt: at(6) },
  ];
  const changeLog: TeamChangeLogRecord[] = [
    {
      slug: 'dev-team',
      projectId: null,
      changedAt: at(2),
      source: 'analysis',
      fromVersion: 'v1',
      toVersion: 'v2',
      summary: 'Review once, on sonnet',
      reason: null,
      userNote: null,
      recommendationIds: ['W-1'],
      chatRunId: 'analysis-1',
      cardSeq: 5,
      backup: null,
    },
  ];
  const versionRef = (version: string) => ({
    number: version === 'v1' ? 1 : 2,
    current: version === 'v2',
  });

  function fold(reviewerCells: Record<string, MemberRunCell>) {
    return foldMemberChanges({
      threads,
      cells: new Map([
        ['reviewer', new Map(Object.entries(reviewerCells))],
        [
          'echo',
          new Map([
            ['a1', cell()],
            ['a2', cell()],
            ['c1', cell()],
          ]),
        ],
      ]),
      teamSpend: new Map([
        ['a1', spent(6, 600_000)],
        ['a2', spent(6, 600_000)],
        ['c1', spent(6, 600_000)],
        ['b1', spent(4, 300_000)],
        ['b2', spent(4, 300_000)],
        ['b3', spent(4, 300_000)],
      ]),
      teams: new Map([
        ['v1', V1],
        ['v2', V2],
      ]),
      versionRef,
      changeLog,
    });
  }

  it("measures a member's change by its own runs on either side, names who made it, and counts a restore once as its own change", () => {
    const changes = fold({
      a1: cell({
        spend: spent(4, 60_000),
        stagesCompleted: 2,
        completionsReopened: 1,
      }),
      a2: cell({
        spend: spent(4, 60_000),
        stagesCompleted: 2,
        completionsReopened: 1,
      }),
      c1: cell({
        spend: spent(4, 60_000),
        stagesCompleted: 2,
        completionsReopened: 1,
      }),
      b1: cell({ spend: spent(2, 60_000), stagesCompleted: 2 }),
      b2: cell({ spend: spent(2, 60_000), stagesCompleted: 2 }),
      b3: cell({ spend: spent(2, 60_000), stagesCompleted: 2 }),
    }).get('reviewer');

    expect(
      changes?.map((change) => [change.from.number, change.to.number]),
    ).toEqual([
      [2, 1],
      [1, 2],
    ]);
    const [restore, tuned] = changes!;
    expect(tuned).toMatchObject({
      at: at(3).toISOString(),
      source: 'analysis',
      summary: 'Review once, on sonnet',
      recommendationIds: ['W-1'],
      before: { runs: 3, costPerRunUsd: 4, reworkShare: 0.5, cleanShare: 0 },
      after: { runs: 3, costPerRunUsd: 2, reworkShare: 0, cleanShare: 1 },
      effect: 'better',
    });
    expect(
      tuned!.moved.map((moved) => [moved.figure, moved.unit, moved.direction]),
    ).toEqual([
      ['cost per run', 'usd', 'better'],
      ['rework', 'share', 'better'],
      ['clean runs', 'share', 'better'],
    ]);
    expect(restore).toMatchObject({
      at: at(5).toISOString(),
      source: null,
      effect: 'worse',
    });
  });

  it('calls a change mixed when its figures disagree, and leaves one with under two runs a side unjudged', () => {
    const mixed = fold({
      a1: cell({ spend: spent(4, 60_000) }),
      a2: cell({ spend: spent(4, 60_000) }),
      b1: cell({ spend: spent(2, 60_000), callsAnswered: 2, callsFailed: 1 }),
      b2: cell({ spend: spent(2, 60_000), callsAnswered: 2 }),
    }).get('reviewer')!;
    const thin = fold({
      a1: cell(),
      b1: cell(),
      b2: cell(),
    }).get('reviewer')!;

    expect(mixed.at(-1)).toMatchObject({ effect: 'mixed' });
    expect(thin.at(-1)).toMatchObject({
      effect: 'too-few-runs',
      before: { runs: 1 },
    });
  });

  it('judges a member removed by the team’s own figures', () => {
    const echo = fold({}).get('echo');

    expect(
      echo?.at(-1)?.moved.map((moved) => [moved.figure, moved.unit]),
    ).toEqual([
      ['team cost per run', 'usd'],
      ['team working time per run', 'ms'],
    ]);
    expect(echo?.at(-1)).toMatchObject({
      kinds: ['removed'],
      before: { runs: 3 },
      after: null,
      team: {
        before: { runs: 3, costPerRunUsd: 6, workedPerRunMs: 600_000 },
        after: { runs: 3, costPerRunUsd: 4, workedPerRunMs: 300_000 },
      },
      effect: 'better',
    });
  });
});
