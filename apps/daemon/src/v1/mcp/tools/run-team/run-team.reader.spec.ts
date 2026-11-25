import { describe, expect, it } from 'vitest';

import type { ProposalOutcome, TeamProposal } from '../../../teams/teams.types';
import {
  readRunTeamChangeArgs,
  readRunTeamStartArgs,
  RUN_TEAM_PLAN_LINE_MAX,
  runTeamResultText,
} from './run-team.reader';

const reader = {
  id: 'dev',
  name: 'Dev',
  role: 'Reads the code',
  task: 'Read the diff',
  instructions: 'Be exact',
  agent: 'claude',
};

function startArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    summary: 'Review the open pull requests',
    reason: 'The user asked for a review team',
    plan: ['Read the diffs', 'Write the review'],
    team: { name: 'Reviewers', members: [reader] },
    ...overrides,
  };
}

function members(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, at) => ({
    ...reader,
    id: `m${at}`,
  }));
}

function changeArgs(edits: Record<string, unknown>[]): Record<string, unknown> {
  return {
    summary: 'Add a tester',
    reason: 'The user asked for one more check',
    edits,
  };
}

describe('readRunTeamStartArgs', () => {
  it('accepts a valid start form and reads its members', () => {
    const read = readRunTeamStartArgs(startArgs());

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.query.team.members.map((member) => member.id)).toEqual(['dev']);
    expect(read.query.plan).toEqual(['Read the diffs', 'Write the review']);
  });

  it('refuses more members than a chat team takes', () => {
    expect(
      readRunTeamStartArgs(
        startArgs({ team: { name: 'Big', members: members(13) } }),
      ).ok,
    ).toBe(false);
  });

  it('accepts exactly twelve members', () => {
    expect(
      readRunTeamStartArgs(
        startArgs({ team: { name: 'Big', members: members(12) } }),
      ).ok,
    ).toBe(true);
  });

  it("refuses a member named 'agent', the chat's own id", () => {
    const read = readRunTeamStartArgs(
      startArgs({
        team: { name: 'Team', members: [{ ...reader, id: 'agent' }] },
      }),
    );

    expect(read.ok).toBe(false);
  });

  it('refuses two members sharing one id', () => {
    const read = readRunTeamStartArgs(
      startArgs({
        team: { name: 'Team', members: [reader, { ...reader, name: 'Two' }] },
      }),
    );

    expect(read).toEqual({
      ok: false,
      error: "two agents share the id 'dev'",
    });
  });

  it('refuses a NUL character in a member role', () => {
    const read = readRunTeamStartArgs(
      startArgs({
        team: {
          name: 'Team',
          members: [{ ...reader, role: 'Reads\u0000code' }],
        },
      }),
    );

    expect(read.ok).toBe(false);
  });

  it('refuses a start without a plan', () => {
    const { plan: _plan, ...withoutPlan } = startArgs();

    expect(readRunTeamStartArgs(withoutPlan).ok).toBe(false);
  });

  it('refuses a plan longer than its line limit', () => {
    const plan = Array.from({ length: 13 }, (_, at) => `step ${at + 1}`);

    expect(readRunTeamStartArgs(startArgs({ plan })).ok).toBe(false);
  });

  it('refuses a plan line over its length bound', () => {
    const plan = ['x'.repeat(RUN_TEAM_PLAN_LINE_MAX + 1)];

    expect(readRunTeamStartArgs(startArgs({ plan })).ok).toBe(false);
  });

  it('refuses an argument the schema does not admit', () => {
    expect(readRunTeamStartArgs(startArgs({ bogus: true })).ok).toBe(false);
  });
});

describe('the form a call is read in', () => {
  it('tells a plain chat sending edits that it runs no team yet', () => {
    const read = readRunTeamStartArgs({
      summary: 'Add a tester',
      reason: 'asked',
      edits: [{ op: 'remove', memberId: 'dev' }],
    });

    expect(read).toEqual({
      ok: false,
      error: expect.stringContaining('this chat runs no team yet'),
    });
  });

  it('tells a lead sending the start form that it changes its team with edits', () => {
    const read = readRunTeamChangeArgs(startArgs());

    expect(read).toEqual({
      ok: false,
      error: expect.stringContaining('change it with edits'),
    });
  });
});

describe('readRunTeamChangeArgs', () => {
  it('accepts an add, a remove and an update, each for its own agent', () => {
    const read = readRunTeamChangeArgs(
      changeArgs([
        { op: 'add', member: { ...reader, id: 'qa', name: 'QA' } },
        { op: 'remove', memberId: 'old' },
        { op: 'update', memberId: 'dev', role: 'Reads and tests the code' },
      ]),
    );

    expect(read.ok).toBe(true);
  });

  it('refuses two edits naming one id', () => {
    const read = readRunTeamChangeArgs(
      changeArgs([
        { op: 'update', memberId: 'dev', role: 'a' },
        { op: 'update', memberId: 'dev', task: 'b' },
      ]),
    );

    expect(read).toEqual({
      ok: false,
      error:
        "'dev' is named by two edits — put everything for one agent in one edit",
    });
  });

  it('refuses an add and a remove naming one id', () => {
    const read = readRunTeamChangeArgs(
      changeArgs([
        { op: 'add', member: { ...reader, id: 'dev' } },
        { op: 'remove', memberId: 'dev' },
      ]),
    );

    expect(read.ok).toBe(false);
  });

  it('refuses an unknown key inside an edit', () => {
    expect(
      readRunTeamChangeArgs(
        changeArgs([{ op: 'remove', memberId: 'dev', force: true }]),
      ).ok,
    ).toBe(false);
  });

  it('refuses an unknown key at the top level', () => {
    expect(
      readRunTeamChangeArgs({
        ...changeArgs([{ op: 'remove', memberId: 'dev' }]),
        extra: 1,
      }).ok,
    ).toBe(false);
  });
});

describe('runTeamResultText', () => {
  it('says a refused proposal was not shown, with its code and message', () => {
    const outcome: ProposalOutcome = {
      status: 'refused',
      code: 'TOO_MANY_MEMBERS',
      message: 'a team takes at most 12 agents',
    };

    expect(runTeamResultText(outcome)).toBe(
      'Not proposed — TOO_MANY_MEMBERS: a team takes at most 12 agents. No card was shown.',
    );
  });

  it('describes a shown start with its agent count, singular and plural', () => {
    const shown = (count: number): ProposalOutcome => ({
      status: 'shown',
      proposal: {
        mode: 'run-start',
        members: Array.from({ length: count }, () => ({})),
      } as unknown as TeamProposal,
    });

    expect(runTeamResultText(shown(1))).toBe(
      'Shown to the user on a card: a team of 1 agent led by this chat. Nothing starts until they press Start. End your turn now — their verdict arrives as your next message.',
    );
    expect(runTeamResultText(shown(2))).toContain(
      'a team of 2 agents led by this chat.',
    );
  });

  it('describes a shown change as a change to the running team', () => {
    const outcome: ProposalOutcome = {
      status: 'shown',
      proposal: { mode: 'run-change' } as unknown as TeamProposal,
    };

    expect(runTeamResultText(outcome)).toBe(
      'Shown to the user on a card: a change to the running team. Nothing changes until they press Apply. End your turn now — their verdict arrives as your next message.',
    );
  });
});
