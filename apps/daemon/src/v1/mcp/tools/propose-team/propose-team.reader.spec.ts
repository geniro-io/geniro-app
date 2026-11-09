import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../../../teams/__tests__/team-builders';
import {
  proposalTargetOf,
  proposeTeamResultText,
  readProposeTeamArgs,
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

  it('reads an overlay of a named project, with what it changes and why required', () => {
    const overlay = { members: { lead: { settings: { effort: 'max' } } } };
    const whole = {
      overlay,
      overlayProjectId: 'p1',
      summary: 'Lead thinks harder here',
      reason: 'asked',
    };

    expect(readProposeTeamArgs(whole)).toEqual({
      ok: true,
      query: { ...whole, edits: [] },
    });
    expect(readProposeTeamArgs({ ...whole, team: null }).ok).toBe(true);
    const { reason: _reason, ...noReason } = whole;
    expect(readProposeTeamArgs(noReason).ok).toBe(false);
  });

  it('reads an overlay beside edits, and refuses one beside a whole team', () => {
    const overlay = {
      overlay: {},
      overlayProjectId: 'p1',
      summary: 's',
      reason: 'r',
    };
    const edits = [{ path: 'name', value: 'x' }];

    expect(
      readProposeTeamArgs({ ...overlay, edits, replaces: 'team' }),
    ).toEqual({
      ok: true,
      query: { ...overlay, edits, replaces: 'team' },
    });
    expect(readProposeTeamArgs({ ...overlay, team: TEAM })).toEqual({
      ok: false,
      error:
        'send `team` for a new team, or `edits`, `overlay` or `project` for a change — never both',
    });
  });

  it('refuses a project named with no overlay, and a target with nothing to change', () => {
    const account = { summary: 's', reason: 'r' };

    expect(
      readProposeTeamArgs({
        ...account,
        overlayProjectId: 'p1',
        edits: [{ path: 'name', value: 'x' }],
      }),
    ).toEqual({
      ok: false,
      error: '`overlayProjectId` names whose `overlay` it is — send both',
    });
    expect(readProposeTeamArgs({ ...account, replaces: 'team' }).ok).toBe(
      false,
    );
  });

  it('refuses a misspelt target rather than proposing a second team', () => {
    expect(readProposeTeamArgs({ team: TEAM, replace: 'team' }).ok).toBe(false);
    expect(readProposeTeamArgs({ team: 'name: Team' }).ok).toBe(false);
    expect(readProposeTeamArgs({}).ok).toBe(false);
  });

  const EDITS = [{ find: 'old text', replace: 'new text' }];

  it('reads a change to a library team as edits, with the slug, summary and reason the card shows', () => {
    expect(
      readProposeTeamArgs({
        replaces: 'dev-team',
        edits: EDITS,
        summary: 'Clean up after every run',
        reason: 'The stand logs filled the disk.',
      }),
    ).toEqual({
      ok: true,
      query: {
        replaces: 'dev-team',
        edits: EDITS,
        summary: 'Clean up after every run',
        reason: 'The stand logs filled the disk.',
      },
    });
  });

  it('reads recommendation_ids through as recommendationIds, and refuses them beside a whole team', () => {
    const edits = [{ path: 'name', value: 'x' }];

    expect(
      readProposeTeamArgs({
        replaces: 'dev-team',
        edits,
        summary: 'Clean up after every run',
        reason: 'The stand logs filled the disk.',
        recommendation_ids: ['W-2', 'P-1'],
      }),
    ).toEqual({
      ok: true,
      query: {
        replaces: 'dev-team',
        edits,
        summary: 'Clean up after every run',
        reason: 'The stand logs filled the disk.',
        recommendationIds: ['W-2', 'P-1'],
      },
    });
    expect(
      readProposeTeamArgs({
        team: TEAM,
        summary: 's',
        reason: 'r',
        recommendation_ids: ['W-2'],
      }),
    ).toEqual({
      ok: false,
      error:
        'send `team` for a new team, or `edits`, `overlay` or `project` for a change — never both',
    });
  });

  it('refuses edits without the card’s account, empty, or beside a whole team', () => {
    const base = {
      replaces: 'dev-team',
      edits: EDITS,
      summary: 's',
      reason: 'r',
    };
    expect(readProposeTeamArgs({ ...base, summary: undefined }).ok).toBe(false);
    expect(readProposeTeamArgs({ ...base, reason: undefined }).ok).toBe(false);
    expect(readProposeTeamArgs({ ...base, edits: [] }).ok).toBe(false);
    expect(readProposeTeamArgs({ ...base, team: TEAM })).toEqual({
      ok: false,
      error:
        'send `team` for a new team, or `edits`, `overlay` or `project` for a change — never both',
    });
  });
});

describe('readProposeTeamArgs on a change', () => {
  const EDITS = [{ path: 'members/reviewer/model', value: 'sonnet' }];

  it('reads edits with what they change and why, a named team left to the tool', () => {
    expect(
      readProposeTeamArgs({
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
    expect(readProposeTeamArgs({ edits: EDITS, summary: 'x' }).ok).toBe(false);
    expect(readProposeTeamArgs({ edits: EDITS, reason: 'x' }).ok).toBe(false);
  });

  it('refuses a reason past its cap or carrying hidden text', () => {
    const base = { edits: EDITS, summary: 's' };
    expect(readProposeTeamArgs({ ...base, reason: 'x'.repeat(1001) }).ok).toBe(
      false,
    );
    expect(readProposeTeamArgs({ ...base, reason: 'x'.repeat(1000) }).ok).toBe(
      true,
    );
    expect(readProposeTeamArgs({ ...base, reason: 'one\u202Etwo' }).ok).toBe(
      false,
    );
  });
});

describe('proposalTargetOf', () => {
  const account = { summary: 's', reason: 'r' };
  const edits = [{ path: 'name', value: 'x' }];
  const overlay = { members: {} };
  const anywhere = { team: null, project: null };
  const builder = { team: 'own', project: null };
  const projectChat = { team: null, project: 'p-own' };

  it('takes the chat’s own team for edits naming none, and refuses them where it has none', () => {
    expect(proposalTargetOf({ ...account, edits }, builder)).toEqual({
      kind: 'team',
      slug: 'own',
      projectId: null,
    });
    for (const own of [anywhere, projectChat]) {
      expect(proposalTargetOf({ ...account, edits }, own)).toBe(
        'name the team this changes in `replaces` — read_teams lists them',
      );
    }
  });

  it('takes the team a change names, whichever chat it is', () => {
    for (const own of [anywhere, builder, projectChat]) {
      expect(
        proposalTargetOf({ ...account, edits, replaces: 'other' }, own),
      ).toEqual({ kind: 'team', slug: 'other', projectId: null });
    }
  });

  it('leaves an overlay naming its project to that project’s default team, whichever team the chat edits', () => {
    for (const own of [anywhere, builder, projectChat]) {
      expect(
        proposalTargetOf(
          { ...account, edits: [], overlay, overlayProjectId: 'p2' },
          own,
        ),
      ).toEqual({ kind: 'overlay', projectId: 'p2', overlay });
    }
  });

  it('takes the chat’s own project for an overlay naming none, and refuses it where it has none', () => {
    expect(
      proposalTargetOf({ ...account, edits: [], overlay }, projectChat),
    ).toEqual({ kind: 'overlay', projectId: 'p-own', overlay });
    expect(
      proposalTargetOf(
        { ...account, edits: [], overlay },
        { team: 'own', project: 'p-bound' },
      ),
    ).toEqual({ kind: 'team', slug: 'own', projectId: 'p-bound' });
    expect(proposalTargetOf({ ...account, edits: [], overlay }, builder)).toBe(
      'name the project this overlay belongs to in `overlayProjectId` — list_projects names them',
    );
  });

  it('keeps edits and an overlay beside them on the one team, for the one card', () => {
    expect(
      proposalTargetOf(
        { ...account, edits, overlay, overlayProjectId: 'p2' },
        builder,
      ),
    ).toEqual({ kind: 'team', slug: 'own', projectId: 'p2' });
    expect(
      proposalTargetOf(
        { ...account, edits, overlay, replaces: 'other' },
        projectChat,
      ),
    ).toEqual({ kind: 'team', slug: 'other', projectId: 'p-own' });
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

  it('names what the card writes when the team itself stays as it is', () => {
    const replace = {
      mode: 'replace' as const,
      slug: 'team',
      replacesName: 'Team',
      baseHash: 'h1',
      autoAgents: [],
      team: TEAM,
    };
    const overlay = {
      projectId: 'p1',
      projectName: 'Billing',
      overlay: {},
      baseHash: null,
      diffText: 'x',
    };

    expect(
      proposeTeamResultText({
        status: 'shown',
        proposal: {
          ...replace,
          diff: { identical: true } as never,
          overlay,
        },
      }),
    ).toContain('on a card: the overlay of Billing. Nothing is saved');
    expect(
      proposeTeamResultText({
        status: 'shown',
        proposal: {
          ...replace,
          diff: { identical: false } as never,
          overlay,
        },
      }),
    ).toContain(
      "on a card: a replacement of 'team' (Team) and the overlay of Billing. Nothing",
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
