import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../../../teams/__tests__/team-builders';
import {
  proposeTeamResultText,
  readProposeTeamArgs,
  readProposeTeamChangeArgs,
} from './propose-team.reader';

const TEAM = teamOf([member('lead')], { name: 'Team' });

describe('readProposeTeamArgs', () => {
  it('reads a team with an optional target, summary and reason', () => {
    expect(
      readProposeTeamArgs({
        team: TEAM,
        replaces: 'team',
        summary: 'adds a reviewer',
        reason: 'nothing checks the coder',
      }),
    ).toEqual({
      ok: true,
      query: {
        team: TEAM,
        replaces: 'team',
        summary: 'adds a reviewer',
        reason: 'nothing checks the coder',
      },
    });
    // A model's null for an unset optional reads as absent.
    expect(readProposeTeamArgs({ team: TEAM, replaces: null })).toEqual({
      ok: true,
      query: { team: TEAM },
    });
  });

  it('refuses a summary of more than one capped line', () => {
    for (const broken of ['one\ntwo', 'one\u2028two', 'one\u202Etwo']) {
      expect(readProposeTeamArgs({ team: TEAM, summary: broken }).ok).toBe(
        false,
      );
    }
    expect(
      readProposeTeamArgs({ team: TEAM, summary: 'x'.repeat(201) }).ok,
    ).toBe(false);
    expect(
      readProposeTeamArgs({ team: TEAM, summary: 'x'.repeat(200) }).ok,
    ).toBe(true);
    // Emoji are visible text, joined sequences included.
    expect(
      readProposeTeamArgs({
        team: TEAM,
        summary: 'a reviewer ❤️ 👨‍💻',
      }).ok,
    ).toBe(true);
  });

  it('refuses a misspelt target rather than proposing a second team', () => {
    expect(readProposeTeamArgs({ team: TEAM, replace: 'team' }).ok).toBe(false);
    expect(readProposeTeamArgs({ team: 'name: Team' }).ok).toBe(false);
    expect(readProposeTeamArgs({}).ok).toBe(false);
  });
});

describe('readProposeTeamChangeArgs', () => {
  const EDITS = [{ path: 'members/reviewer/model', value: 'sonnet' }];

  it("reads a builder chat's edits with what they change and why", () => {
    expect(
      readProposeTeamChangeArgs({
        edits: EDITS,
        summary: 'Reviewer on sonnet',
        reason:
          'The user asked for a cheaper reviewer.\nIt reviews small diffs.',
      }),
    ).toEqual({
      ok: true,
      query: {
        edits: EDITS,
        summary: 'Reviewer on sonnet',
        reason:
          'The user asked for a cheaper reviewer.\nIt reviews small diffs.',
      },
    });
  });

  it('requires both the summary and the reason the card shows', () => {
    expect(readProposeTeamChangeArgs({ edits: EDITS, summary: 'x' }).ok).toBe(
      false,
    );
    expect(readProposeTeamChangeArgs({ edits: EDITS, reason: 'x' }).ok).toBe(
      false,
    );
  });

  it("refuses a whole team or a target: the slug is the chat's", () => {
    const base = { edits: EDITS, summary: 's', reason: 'r' };
    expect(readProposeTeamChangeArgs({ ...base, team: TEAM }).ok).toBe(false);
    expect(readProposeTeamChangeArgs({ ...base, replaces: 'other' }).ok).toBe(
      false,
    );
    expect(readProposeTeamChangeArgs({ ...base, edits: [] }).ok).toBe(false);
  });

  it('refuses a reason past its cap or carrying hidden text', () => {
    const base = { edits: EDITS, summary: 's' };
    expect(
      readProposeTeamChangeArgs({ ...base, reason: 'x'.repeat(1001) }).ok,
    ).toBe(false);
    expect(
      readProposeTeamChangeArgs({ ...base, reason: 'x'.repeat(1000) }).ok,
    ).toBe(true);
    expect(
      readProposeTeamChangeArgs({ ...base, reason: 'one\u202Etwo' }).ok,
    ).toBe(false);
  });
});

describe('proposeTeamResultText', () => {
  it('tells the agent the card is up and to end its turn', () => {
    expect(
      proposeTeamResultText({
        status: 'shown',
        proposal: {
          mode: 'create',
          slug: 'team',
          team: TEAM,
          autoAgents: [],
        },
      }),
    ).toBe(
      "Shown to the user on a card: a new team, to be saved as 'team'. Nothing is saved until they approve. End your turn now — their verdict arrives as your next message.",
    );
  });

  it('names the check that refused a proposal, and that no card was shown', () => {
    expect(
      proposeTeamResultText({
        status: 'refused',
        code: 'TEAM_TRIGGER_COUNT',
        message: 'add a trigger',
      }),
    ).toBe(
      'Not proposed — TEAM_TRIGGER_COUNT: add a trigger. No card was shown.',
    );
  });
});
