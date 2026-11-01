import { describe, expect, it } from 'vitest';

import {
  RECORDED_NEW_PROPOSAL as LEGACY_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL as LEGACY_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL as LEGACY_REPLACE_TO_AUTO_PROPOSAL,
  STAGES_PROPOSAL as LEGACY_STAGES_PROPOSAL,
} from '../__fixtures__/team-proposals';
import {
  RECORDED_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
  STAGES_PROPOSAL,
} from './__fixtures__/member-team-proposals';
import {
  diffRows,
  previewMarks,
  readProposalOutcome,
  readTeamProposal,
  rosterOf,
  stageMarksOf,
  teamFromLegacyGraph,
} from './team-proposal-payload';

function parsed(input: unknown) {
  const proposal = readTeamProposal(input);
  expect(proposal).not.toBeNull();
  return proposal!;
}

describe('readTeamProposal', () => {
  it('reads a recorded new-team card', () => {
    const proposal = parsed(RECORDED_NEW_PROPOSAL);
    expect(proposal).toMatchObject({
      mode: 'create',
      slug: 'review-pair',
      autoAgents: ['Reviewer (reviewer)'],
      replacesName: null,
      diff: null,
    });
    expect(proposal.team.members.map((member) => member.id)).toEqual([
      'coder',
      'reviewer',
    ]);
    expect(proposal.team.triggers).toEqual([
      { kind: 'first-message', member: 'coder' },
    ]);
  });

  it('reads a recorded replacement with the name it overwrites and its diff', () => {
    const proposal = parsed(RECORDED_REPLACE_PROPOSAL);
    expect(proposal.mode).toBe('replace');
    expect(proposal.replacesName).toBe('Review Pair');
    expect(proposal.diff?.changedMembers).toEqual([
      {
        id: 'reviewer',
        fields: [{ field: 'approval', before: '"auto"', after: '"ask"' }],
      },
    ]);
  });

  it('reads a card raised before the rename, which holds its team under `workflow`', () => {
    const { team, diff, ...rest } = RECORDED_REPLACE_PROPOSAL as {
      team: unknown;
      diff: { teamFields: unknown };
    } & Record<string, unknown>;
    const { teamFields, ...ownDiff } = diff;
    const proposal = parsed({
      ...rest,
      workflow: team,
      diff: { ...ownDiff, workflowFields: teamFields },
    });

    expect(proposal).toEqual(parsed(RECORDED_REPLACE_PROPOSAL));
  });

  it('reads nothing it cannot draw whole, so the card falls back to the permission body', () => {
    const replace = REPLACE_TO_AUTO_PROPOSAL as {
      team: { members: Record<string, unknown>[] };
      diff: unknown;
    };
    const withTeam = (team: Record<string, unknown>) => ({ ...replace, team });
    const unreadable: unknown[] = [
      null,
      'propose',
      { ...replace, team: undefined },
      { ...replace, mode: 'merge' },
      { ...replace, diff: undefined },
      { ...replace, diff: { identical: false } },
      {
        ...replace,
        diff: {
          ...(replace.diff as object),
          changedStages: [{ id: 'build', fields: [{ field: 'next' }] }],
        },
      },
      { ...replace, autoAgents: 'Coder' },
      withTeam({
        ...replace.team,
        members: [{ id: 'x', name: 'X', agent: 'claude', approval: 'yolo' }],
      }),
      withTeam({
        ...replace.team,
        members: [{ id: 'x', agent: 'claude', approval: 'ask' }],
      }),
      withTeam({
        ...replace.team,
        members: [{ id: 'x', name: 'X', agent: 'bard', approval: 'ask' }],
      }),
      withTeam({ ...replace.team, mode: 'swarm' }),
      withTeam({
        ...replace.team,
        triggers: [{ kind: 'manual', member: 'x' }],
      }),
      withTeam({
        ...replace.team,
        instructionBlocks: [
          { id: 'b', title: 'B', text: 't', audience: 'nobody' },
        ],
      }),
      withTeam({ ...replace.team, stages: 'plan' }),
      withTeam({
        ...replace.team,
        stages: [{ id: 'plan', title: 'Plan' }],
      }),
    ];
    for (const input of unreadable) {
      expect(readTeamProposal(input)).toBeNull();
    }
  });

  it('drops a blank summary rather than drawing an empty line', () => {
    expect(
      parsed({ ...(RECORDED_NEW_PROPOSAL as object), summary: '   ' }).summary,
    ).toBeNull();
  });

  it('reads the reason trimmed with its line breaks, and none when blank or absent', () => {
    expect(parsed(REPLACE_TO_AUTO_PROPOSAL).reason).toBe(
      'The user asked for tests before review.\nThe coder waited on every edit, so it now runs unattended.',
    );
    expect(
      parsed({ ...(REPLACE_TO_AUTO_PROPOSAL as object), reason: ' \n ' })
        .reason,
    ).toBeNull();
    expect(parsed(RECORDED_NEW_PROPOSAL).reason).toBeNull();
  });
});

describe('readProposalOutcome', () => {
  it('reads a saved slug and a known reason for nothing written', () => {
    expect(readProposalOutcome({ kind: 'saved', slug: 'team' })).toEqual({
      kind: 'saved',
      slug: 'team',
    });
    expect(
      readProposalOutcome({ kind: 'not-saved', cause: 'changed' }),
    ).toEqual({ kind: 'not-saved', cause: 'changed' });
  });

  it('keeps a not-saved reading whose cause this build does not know', () => {
    expect(
      readProposalOutcome({ kind: 'not-saved', cause: 'disk-full' }),
    ).toEqual({ kind: 'not-saved', cause: null });
  });

  it('reads no outcome from a row that carries none', () => {
    expect(readProposalOutcome(null)).toBeNull();
    expect(readProposalOutcome({ kind: 'saved' })).toBeNull();
    expect(readProposalOutcome('saved')).toBeNull();
  });
});

describe('rosterOf', () => {
  it('lists the members in team order with the titles of the blocks addressed to each', () => {
    const roster = rosterOf(parsed(REPLACE_TO_AUTO_PROPOSAL).team);
    expect(roster.map((row) => [row.member.id, row.instructions])).toEqual([
      ['coder', ['Style']],
      ['tester', []],
      ['reviewer', []],
    ]);
  });

  it('lists a block for everyone on every member, and a named-audience block on those named only', () => {
    const { team } = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const roster = rosterOf({
      ...team,
      instructionBlocks: [
        { id: 'style', title: 'Style', text: 'x', audience: ['coder'] },
        {
          id: 'safety',
          title: 'Safety',
          text: 'x',
          audience: ['tester', 'reviewer'],
        },
        { id: 'tone', title: 'Tone', text: 'x', audience: 'everyone' },
        { id: 'ghost', title: 'Ghost', text: 'x', audience: ['gone'] },
      ] as typeof team.instructionBlocks,
    });
    expect(roster.map((row) => [row.member.id, row.instructions])).toEqual([
      ['coder', ['Style', 'Tone']],
      ['tester', ['Safety', 'Tone']],
      ['reviewer', ['Safety', 'Tone']],
    ]);
  });

  it('names an untitled block by its id', () => {
    const { team } = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const roster = rosterOf({
      ...team,
      instructionBlocks: team.instructionBlocks.map((block) => ({
        ...block,
        title: '  ',
      })),
    });
    expect(roster[0]!.instructions).toEqual(['style']);
  });
});

describe('stageMarksOf', () => {
  it('marks the stages a replacement adds and changes, and nothing on a new team', () => {
    expect([...stageMarksOf(parsed(STAGES_PROPOSAL).diff)]).toEqual([
      ['build', 'changed'],
      ['review', 'added'],
    ]);
    expect(stageMarksOf(parsed(RECORDED_NEW_PROPOSAL).diff).size).toBe(0);
  });
});

describe('previewMarks', () => {
  it('marks the members a replacement adds and changes, and nothing on a new team', () => {
    expect([...previewMarks(parsed(REPLACE_TO_AUTO_PROPOSAL).diff)]).toEqual([
      ['coder', 'changed'],
      ['reviewer', 'changed'],
      ['tester', 'added'],
    ]);
    expect(previewMarks(parsed(RECORDED_NEW_PROPOSAL).diff).size).toBe(0);
  });
});

describe('diffRows', () => {
  it('puts every change that makes an agent run unasked first', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const rows = diffRows(proposal.diff!, proposal.team);
    expect(rows.filter((row) => row.toAuto).map((row) => row.key)).toEqual([
      'added-member:tester',
      'changed-member:coder:approval',
    ]);
    expect(rows.slice(0, 2).every((row) => row.toAuto)).toBe(true);
    expect(
      rows.find((row) => row.key === 'changed-member:reviewer:approval'),
    ).toMatchObject({
      toAuto: false,
      detail: { before: 'auto', after: 'ask' },
    });
  });

  it('flags a pool change on a member left running unasked, however long its quoted value', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const cut = `[{"agent":"codex","model":"${'m'.repeat(390)}… [+80 chars]`;
    const rows = diffRows(
      {
        ...proposal.diff!,
        changedMembers: [
          // The tester's second member runs unasked; its quote is cut off
          // before the approval ever appears.
          {
            id: 'tester',
            fields: [{ field: 'pool', before: '(unset)', after: cut }],
          },
          // The reviewer asks, members and all.
          {
            id: 'reviewer',
            fields: [
              {
                field: 'pool',
                before: '(unset)',
                after: '[{"agent":"codex"}]',
              },
            ],
          },
        ],
      },
      proposal.team,
    );
    expect(
      rows.find((row) => row.key === 'changed-member:tester:pool')?.toAuto,
    ).toBe(true);
    expect(
      rows.find((row) => row.key === 'changed-member:reviewer:pool')?.toAuto,
    ).toBe(false);
  });

  it('flags a pool change only when it leaves the member running unasked where it did not before', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const poolRow = (id: string, before: string) =>
      diffRows(
        {
          ...proposal.diff!,
          changedMembers: [
            {
              id,
              fields: [{ field: 'pool', before, after: '[{"agent":"codex"}]' }],
            },
          ],
        },
        proposal.team,
      ).find((row) => row.key === `changed-member:${id}:pool`)?.toAuto;

    // The coder already ran unasked (`approval: auto`, unchanged here): a
    // member's model changing makes nothing newly unasked.
    expect(poolRow('coder', '[{"agent":"codex","model":"a"}]')).toBe(false);
    // The tester's old pool already had its unasked member.
    expect(
      poolRow('tester', '[{"agent":"cursor-agent","approval":"auto"}]'),
    ).toBe(false);
    // Its old pool was asking — the switch is real.
    expect(poolRow('tester', '[{"agent":"cursor-agent"}]')).toBe(true);
    // An old pool cut short cannot be read, so the switch is assumed.
    expect(
      poolRow('tester', '[{"agent":"cursor-agent","mod… [+90 chars]'),
    ).toBe(true);
  });

  it("judges the pool edit alone when the same change moves the member's own approval", () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const rowsFor = (
      memberChange: Record<string, unknown>,
      fields: { field: string; before: string; after: string }[],
    ) =>
      diffRows(
        { ...proposal.diff!, changedMembers: [{ id: 'reviewer', fields }] },
        {
          ...proposal.team,
          members: proposal.team.members.map((member) =>
            member.id === 'reviewer' ? { ...member, ...memberChange } : member,
          ),
        } as typeof proposal.team,
      );
    const flagged = (rows: ReturnType<typeof diffRows>) =>
      rows
        .filter((row) => row.toAuto && row.subject === 'reviewer')
        .map((row) => row.key);

    // ask → auto, and only a member's model changed: the approval row carries
    // the warning, the pool row does not.
    expect(
      flagged(
        rowsFor({ approval: 'auto', pool: [{ agent: 'codex', model: 'b' }] }, [
          { field: 'approval', before: '"ask"', after: '"auto"' },
          {
            field: 'pool',
            before: '[{"agent":"codex","model":"a"}]',
            after: '[{"agent":"codex","model":"b"}]',
          },
        ]),
      ),
    ).toEqual(['changed-member:reviewer:approval']);
    // ask → auto with a pool added in the same change: the member is already
    // flagged, and the new member only inherits it.
    expect(
      flagged(
        rowsFor({ approval: 'auto', pool: [{ agent: 'codex' }] }, [
          { field: 'approval', before: '"ask"', after: '"auto"' },
          { field: 'pool', before: '(unset)', after: '[{"agent":"codex"}]' },
        ]),
      ),
    ).toEqual(['changed-member:reviewer:approval']);
    // auto → ask, while the pool gains a member that is auto on its own: the
    // pool edit is what keeps the agent running unasked.
    expect(
      flagged(
        rowsFor(
          { approval: 'ask', pool: [{ agent: 'codex', approval: 'auto' }] },
          [
            { field: 'approval', before: '"auto"', after: '"ask"' },
            {
              field: 'pool',
              before: '(unset)',
              after: '[{"agent":"codex","approval":"auto"}]',
            },
          ],
        ),
      ),
    ).toEqual(['changed-member:reviewer:pool']);
  });

  it("unquotes the daemon's values, and reads auto → ask as no switch to auto", () => {
    const proposal = parsed(RECORDED_REPLACE_PROPOSAL);
    expect(diffRows(proposal.diff!, proposal.team)).toEqual([
      {
        key: 'changed-member:reviewer:approval',
        marker: 'changed',
        scope: 'member',
        subject: 'reviewer',
        detail: { field: 'approval', before: 'auto', after: 'ask' },
        toAuto: false,
      },
    ]);
  });

  it('lists each added, changed and removed stage by id', () => {
    const proposal = parsed(STAGES_PROPOSAL);
    expect(diffRows(proposal.diff!, proposal.team)).toEqual([
      {
        key: 'added-stage:review',
        marker: 'added',
        scope: 'stage',
        subject: 'review',
        detail: null,
        toAuto: false,
      },
      {
        key: 'changed-stage:build:next',
        marker: 'changed',
        scope: 'stage',
        subject: 'build',
        detail: { field: 'next', before: '["ship"]', after: '["review"]' },
        toAuto: false,
      },
      {
        key: 'removed-stage:ship',
        marker: 'removed',
        scope: 'stage',
        subject: 'ship',
        detail: null,
        toAuto: false,
      },
    ]);
  });

  it('lists the team fields, then each block added, changed and removed, by id', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const rows = diffRows(
      {
        ...proposal.diff!,
        teamFields: ['description'],
        addedMembers: [],
        changedMembers: [],
        addedBlocks: ['tone'],
        changedBlocks: [
          {
            id: 'style',
            fields: [
              { field: 'audience', before: '["coder"]', after: '"everyone"' },
            ],
          },
        ],
        removedBlocks: ['old'],
      },
      proposal.team,
    );
    expect(
      rows.map(({ key, marker, scope, subject, detail, toAuto }) => ({
        key,
        marker,
        scope,
        subject,
        detail,
        toAuto,
      })),
    ).toEqual([
      {
        key: 'team:description',
        marker: 'changed',
        scope: 'team',
        subject: 'description',
        detail: null,
        toAuto: false,
      },
      {
        key: 'added-block:tone',
        marker: 'added',
        scope: 'block',
        subject: 'tone',
        detail: null,
        toAuto: false,
      },
      {
        key: 'changed-block:style:audience',
        marker: 'changed',
        scope: 'block',
        subject: 'style',
        detail: { field: 'audience', before: '["coder"]', after: 'everyone' },
        toAuto: false,
      },
      {
        key: 'removed-block:old',
        marker: 'removed',
        scope: 'block',
        subject: 'old',
        detail: null,
        toAuto: false,
      },
    ]);
  });

  it('flags a block row as nothing to auto, even when its id is a member that runs unasked', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const rows = diffRows(
      {
        ...proposal.diff!,
        addedMembers: [],
        changedMembers: [],
        addedBlocks: ['coder'],
      },
      proposal.team,
    );
    expect(rows.filter((row) => row.toAuto)).toEqual([]);
  });
});

/** A team as it was written while teams were node graphs. */
const LEGACY_GRAPH = {
  name: 'Legacy',
  description: 'An old graph.',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    {
      id: 'manager',
      kind: 'agent',
      name: 'Manager',
      agent: 'claude',
      model: 'opus',
      approval: 'ask',
      description: 'Routes the work',
      role: 'Route every request, then report the result.',
    },
    { id: 'eng', kind: 'agent', agent: 'codex', approval: 'acceptEdits' },
    { id: 'qa', kind: 'agent', agent: 'claude' },
    {
      id: 'style',
      kind: 'instruction',
      name: 'Style',
      instructions: 'Follow AGENTS.md.',
    },
    {
      id: 'tone',
      kind: 'instruction',
      name: 'Tone',
      instructions: 'Be brief.',
    },
    { id: 'bare', kind: 'instruction', instructions: 'Unnamed.' },
  ],
  edges: [
    { from: 'start', to: 'eng', kind: 'data' },
    { from: 'eng', to: 'qa', kind: 'data' },
    { from: 'manager', to: 'eng', kind: 'call' },
    { from: 'style', to: 'manager', kind: 'instruction' },
    { from: 'style', to: 'qa', kind: 'instruction' },
    { from: 'tone', to: 'manager', kind: 'instruction' },
    { from: 'tone', to: 'eng', kind: 'instruction' },
    { from: 'tone', to: 'qa', kind: 'instruction' },
  ],
  stages: [
    {
      id: 'plan',
      title: 'Plan',
      instructions: 'Scope it first.',
      doneWhen: 'Scoped.',
      ownerHint: 'manager',
      next: ['ship'],
    },
    { id: 'ship', title: 'Ship', doneWhen: 'Merged.' },
  ],
};

describe('teamFromLegacyGraph', () => {
  const team = teamFromLegacyGraph(LEGACY_GRAPH)!;

  it('makes each agent node a member: description its role, role its instructions, no node kind', () => {
    expect(team.members.map((member) => member.id)).toEqual([
      'manager',
      'eng',
      'qa',
    ]);
    expect(team.members[0]).toEqual({
      id: 'manager',
      name: 'Manager',
      agent: 'claude',
      model: 'opus',
      approval: 'ask',
      role: 'Routes the work',
      instructions: 'Route every request, then report the result.',
    });
  });

  it('names an unnamed node by its id and gives one with no approval the old default, auto', () => {
    expect(team.members[1]).toMatchObject({
      id: 'eng',
      name: 'eng',
      approval: 'acceptEdits',
    });
    expect(team.members[2]).toMatchObject({
      id: 'qa',
      name: 'qa',
      approval: 'auto',
    });
  });

  it('names the member the trigger fed as the one that handles the first message', () => {
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'eng' }]);
    expect(team.mode).toBe('lead');
    expect(team.description).toBe('An old graph.');
  });

  it('falls back to the first agent when no trigger fed one, and to no trigger without agents', () => {
    expect(
      teamFromLegacyGraph({
        ...LEGACY_GRAPH,
        edges: LEGACY_GRAPH.edges.filter((edge) => edge.from !== 'start'),
      })!.triggers,
    ).toEqual([{ kind: 'first-message', member: 'manager' }]);
    expect(
      teamFromLegacyGraph({ name: 'Empty', nodes: [], edges: [] })!.triggers,
    ).toEqual([]);
  });

  it('takes the first trigger in node order, like the daemon, and reads an edge with no kind as data', () => {
    const graph = {
      name: 'Two triggers',
      nodes: [
        { id: 'first', kind: 'trigger' },
        { id: 'second', kind: 'trigger' },
        { id: 'a', kind: 'agent', agent: 'claude' },
        { id: 'b', kind: 'agent', agent: 'claude' },
      ],
      edges: [
        { from: 'second', to: 'a', kind: 'data' },
        { from: 'first', to: 'b' },
      ],
    };

    expect(teamFromLegacyGraph(graph)!.triggers).toEqual([
      { kind: 'first-message', member: 'b' },
    ]);
  });

  it('keeps the active-turn cap', () => {
    expect(
      teamFromLegacyGraph({ ...LEGACY_GRAPH, maxActiveTurns: 3 })!
        .maxActiveTurns,
    ).toBe(3);
  });

  it('ignores a trigger edge that is not a data edge', () => {
    expect(
      teamFromLegacyGraph({
        ...LEGACY_GRAPH,
        edges: [{ from: 'start', to: 'qa', kind: 'call' }],
      })!.triggers,
    ).toEqual([{ kind: 'first-message', member: 'manager' }]);
  });

  it('makes each instruction node a block addressed to the agents its edges reached, everyone when all', () => {
    expect(team.instructionBlocks).toEqual([
      {
        id: 'style',
        title: 'Style',
        text: 'Follow AGENTS.md.',
        audience: ['manager', 'qa'],
      },
      { id: 'tone', title: 'Tone', text: 'Be brief.', audience: 'everyone' },
      { id: 'bare', title: 'bare', text: 'Unnamed.', audience: [] },
    ]);
  });

  it('turns a stage into howToWork, goal and one responsible member', () => {
    expect(team.stages).toEqual([
      {
        id: 'plan',
        title: 'Plan',
        howToWork: 'Scope it first.',
        goal: 'Scoped.',
        responsible: ['manager'],
        next: ['ship'],
      },
      { id: 'ship', title: 'Ship', goal: 'Merged.' },
    ]);
  });

  it('reads nothing from a graph it cannot decode', () => {
    const unreadable: Record<string, unknown>[] = [
      { ...LEGACY_GRAPH, name: undefined },
      { ...LEGACY_GRAPH, nodes: 'many' },
      { ...LEGACY_GRAPH, nodes: [{ kind: 'agent', agent: 'claude' }] },
      { ...LEGACY_GRAPH, edges: [{ from: 'start', kind: 'data' }] },
      {
        ...LEGACY_GRAPH,
        nodes: [{ id: 'x', kind: 'agent', agent: 'bard', approval: 'ask' }],
      },
      {
        ...LEGACY_GRAPH,
        nodes: [{ id: 'x', kind: 'agent', agent: 'claude', approval: 'yolo' }],
      },
      {
        ...LEGACY_GRAPH,
        stages: [{ id: 'plan', title: 'Plan' }],
      },
    ];
    for (const graph of unreadable) {
      expect(teamFromLegacyGraph(graph)).toBeNull();
    }
  });
});

describe('a card raised while teams were node graphs', () => {
  it('reads the recorded new-team card as members with the fed agent as the trigger member', () => {
    const { team } = parsed(LEGACY_NEW_PROPOSAL);
    expect(team.members.map((member) => member.id)).toEqual([
      'coder',
      'reviewer',
    ]);
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'coder' }]);
    expect(team.instructionBlocks).toEqual([]);
  });

  it('reads the diff’s node lists as member lists, drops its edge lists and has no blocks', () => {
    const { diff } = parsed(LEGACY_REPLACE_PROPOSAL);
    expect(diff).toEqual({
      identical: false,
      teamFields: [],
      addedMembers: [],
      removedMembers: [],
      changedMembers: [
        {
          id: 'reviewer',
          fields: [{ field: 'approval', before: '"auto"', after: '"ask"' }],
        },
      ],
      addedBlocks: [],
      removedBlocks: [],
      changedBlocks: [],
      addedStages: [],
      removedStages: [],
      changedStages: [],
    });
  });

  it('reads the added and removed node ids as member ids', () => {
    const { diff } = parsed(LEGACY_REPLACE_TO_AUTO_PROPOSAL);
    expect(diff?.addedMembers).toEqual(['tester', 'style']);
    expect(diff?.changedMembers.map((entry) => entry.id)).toEqual([
      'coder',
      'reviewer',
    ]);
  });

  it('reads the workflow field list of a diff raised before the rename, beside the node lists', () => {
    const { diff: legacyDiff, ...rest } = LEGACY_REPLACE_TO_AUTO_PROPOSAL as {
      diff: { teamFields: unknown };
    } & Record<string, unknown>;
    const { teamFields, ...ownDiff } = legacyDiff;
    expect(
      parsed({ ...rest, diff: { ...ownDiff, workflowFields: teamFields } }).diff
        ?.teamFields,
    ).toEqual(['description']);
  });

  it('rejects a diff whose node list is not a list of ids', () => {
    const legacy = LEGACY_REPLACE_PROPOSAL as { diff: object };
    expect(
      readTeamProposal({
        ...legacy,
        diff: { ...legacy.diff, addedNodes: 'tester' },
      }),
    ).toBeNull();
  });

  it('prefers a member list over a node list when a diff carries both', () => {
    const legacy = LEGACY_REPLACE_PROPOSAL as { diff: object };
    expect(
      parsed({
        ...legacy,
        diff: { ...legacy.diff, addedMembers: ['qa'], addedNodes: ['old'] },
      }).diff?.addedMembers,
    ).toEqual(['qa']);
  });

  it('reads an instruction node as a block addressed to the agents it reached', () => {
    const { team } = parsed(LEGACY_REPLACE_TO_AUTO_PROPOSAL);
    expect(team.instructionBlocks).toEqual([
      {
        id: 'style',
        title: 'Style',
        text: 'Follow the repository conventions in AGENTS.md.',
        audience: ['coder'],
      },
    ]);
    expect(
      rosterOf(team).map((row) => [row.member.id, row.instructions]),
    ).toEqual([
      ['coder', ['Style']],
      ['tester', []],
      ['reviewer', []],
    ]);
  });

  it('reads a stage’s done-when and owner hint as its goal and responsible member', () => {
    const { team } = parsed(LEGACY_STAGES_PROPOSAL);
    expect(team.stages).toEqual([
      {
        id: 'plan',
        title: 'Plan',
        goal: 'The approach is agreed.',
        next: ['build'],
      },
      {
        id: 'build',
        title: 'Build',
        goal: 'The change is implemented with tests.',
        responsible: ['coder'],
        next: ['review'],
      },
      {
        id: 'review',
        title: 'Review',
        goal: 'The reviewer approved the change.',
        responsible: ['reviewer'],
      },
    ]);
  });

  it('reads each recorded graph card to the members, trigger and stages of its member-shaped twin', () => {
    for (const [legacy, current] of [
      [LEGACY_NEW_PROPOSAL, RECORDED_NEW_PROPOSAL],
      [LEGACY_REPLACE_PROPOSAL, RECORDED_REPLACE_PROPOSAL],
      [LEGACY_STAGES_PROPOSAL, STAGES_PROPOSAL],
    ] as const) {
      const was = parsed(legacy);
      const now = parsed(current);
      expect(was.team.members.map((member) => member.id)).toEqual(
        now.team.members.map((member) => member.id),
      );
      expect(was.team.triggers).toEqual(now.team.triggers);
      expect(was.team.stages).toEqual(now.team.stages);
      expect(was.diff?.changedStages).toEqual(now.diff?.changedStages);
    }
  });
});
