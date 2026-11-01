import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { LegacyTeamGraph, Team } from '../teams.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  canonicalGraphYaml,
  isLegacyCanonical,
  legacyCanonicalJson,
  legacyGraphVersionOf,
  teamOfCanonical,
  teamVersionOf,
} from './team-version';

const base: Team = teamOf(
  [
    member('lead', { name: 'Lead', instructions: 'Plan the work' }),
    member('dev', { agent: 'codex', role: 'Writes the code' }),
  ],
  {
    name: 'Dev Team',
    description: 'Builds things',
    maxActiveTurns: 3,
    instructionBlocks: [
      { id: 'style', title: 'Style', text: 'Be brief', audience: 'everyone' },
      { id: 'review', title: 'Review', text: 'Check diffs', audience: ['dev'] },
    ],
  },
);

const stages: NonNullable<Team['stages']> = [
  { id: 'build', title: 'Build', goal: 'It compiles', next: ['ship'] },
  { id: 'ship', title: 'Ship', goal: 'It is released' },
];

function edit(change: (team: Team) => Team): string {
  return teamVersionOf(change(structuredClone(base)));
}

describe('teamVersionOf', () => {
  it('is 16 hex characters', () => {
    expect(teamVersionOf(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes a stage-less team as the canonical JSON without a stages key', () => {
    const json = canonicalGraphJson(canonicalGraphOf(base));

    expect(json).not.toContain('stages');
    expect(JSON.parse(json)).toEqual({
      maxActiveTurns: 3,
      mode: 'lead',
      members: base.members,
      triggers: base.triggers,
      instructionBlocks: base.instructionBlocks,
    });
    expect(teamVersionOf({ ...base, stages: undefined })).toBe(
      teamVersionOf(base),
    );
  });

  it('writes keys sorted at every depth', () => {
    const json = canonicalGraphJson(canonicalGraphOf(base));

    expect(
      json.startsWith('{"instructionBlocks":[{"audience":"everyone"'),
    ).toBe(true);
    expect(json).toContain(
      '{"agent":"claude","approval":"auto","id":"lead","instructions":"Plan the work","name":"Lead"}',
    );
  });

  it.each<[string, (team: Team) => Team]>([
    ['the team name', (t) => ({ ...t, name: 'Renamed' })],
    ['the team description', (t) => ({ ...t, description: undefined })],
    ['an empty stage list', (t) => ({ ...t, stages: [] })],
    [
      'the key order inside a member',
      (t) => ({
        ...t,
        members: t.members.map(
          (m) =>
            Object.fromEntries(
              Object.entries(m).reverse(),
            ) as Team['members'][number],
        ),
      }),
    ],
  ])('keeps the id across an edit to %s', (_what, change) => {
    expect(edit(change)).toBe(teamVersionOf(base));
  });

  it.each<[string, (team: Team) => Team]>([
    ['an added stage', (t) => ({ ...t, stages })],
    [
      'a stage field',
      (t) => ({
        ...t,
        stages: stages.map((s) =>
          s.id === 'ship' ? { ...s, goal: 'It is live' } : s,
        ),
      }),
    ],
    ['the stage order', (t) => ({ ...t, stages: [...stages].reverse() })],
    [
      'a member field',
      (t) => ({
        ...t,
        members: t.members.map((m) =>
          m.id === 'lead' ? { ...m, instructions: 'Review the work' } : m,
        ),
      }),
    ],
    [
      'a member name',
      (t) => ({
        ...t,
        members: t.members.map((m) =>
          m.id === 'lead' ? { ...m, name: 'Tech lead' } : m,
        ),
      }),
    ],
    ['the member order', (t) => ({ ...t, members: [...t.members].reverse() })],
    [
      'an added member',
      (t) => ({ ...t, members: [...t.members, member('qa')] }),
    ],
    [
      'a removed member',
      (t) => ({ ...t, members: t.members.filter((m) => m.id !== 'dev') }),
    ],
    [
      'the trigger member',
      (t) => ({
        ...t,
        triggers: [{ kind: 'first-message', member: 'dev' }],
      }),
    ],
    ['the mode', (t) => ({ ...t, mode: 'relay' })],
    [
      'a block text',
      (t) => ({
        ...t,
        instructionBlocks: t.instructionBlocks.map((b) =>
          b.id === 'style' ? { ...b, text: 'Be verbose' } : b,
        ),
      }),
    ],
    [
      'a block audience',
      (t) => ({
        ...t,
        instructionBlocks: t.instructionBlocks.map((b) =>
          b.id === 'review' ? { ...b, audience: ['lead'] } : b,
        ),
      }),
    ],
    [
      'the block order',
      (t) => ({ ...t, instructionBlocks: [...t.instructionBlocks].reverse() }),
    ],
    ['maxActiveTurns', (t) => ({ ...t, maxActiveTurns: 4 })],
    ['maxActiveTurns removed', (t) => ({ ...t, maxActiveTurns: undefined })],
  ])('changes the id on %s', (_what, change) => {
    expect(edit(change)).not.toBe(teamVersionOf(base));
  });
});

describe('canonicalGraphOf', () => {
  it('drops the team name and description', () => {
    const json = canonicalGraphJson(canonicalGraphOf(base));
    expect(json).not.toContain('Dev Team');
    expect(json).not.toContain('Builds things');
    expect(json).toContain('Plan the work');
  });

  it('records an omitted cap as null', () => {
    expect(
      canonicalGraphOf({ ...base, maxActiveTurns: undefined }).maxActiveTurns,
    ).toBeNull();
  });
});

const legacyGraph: LegacyTeamGraph = {
  name: 'Old team',
  description: 'Was a graph',
  maxActiveTurns: 2,
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    {
      id: 'lead',
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
      name: 'Lead',
      description: 'Plans the work',
      role: 'Plan carefully',
    },
    { id: 'dev', kind: 'agent', agent: 'codex', approval: 'ask' },
  ],
  edges: [
    { from: 'start', to: 'lead', kind: 'data', label: 'brief' },
    { from: 'lead', to: 'dev', kind: 'call' },
  ],
  layout: { start: { x: 0, y: 0 } },
  stages: [{ id: 'build', title: 'Build', doneWhen: 'It compiles' }],
};

const LEGACY_CANONICAL_JSON =
  '{"edges":[{"from":"lead","kind":"call","to":"dev"},{"from":"start","kind":"data","to":"lead"}],"maxActiveTurns":2,"nodes":[{"agent":"codex","approval":"ask","id":"dev","kind":"agent"},{"agent":"claude","approval":"auto","description":"Plans the work","id":"lead","kind":"agent","name":"Lead","role":"Plan carefully"},{"id":"start","kind":"trigger","trigger":"manual"}],"stages":[{"doneWhen":"It compiles","id":"build","title":"Build"}]}';

// sha256 of LEGACY_CANONICAL_JSON, first 16 hex.
const LEGACY_VERSION = 'b58a7796d59903ff';

describe('legacyGraphVersionOf', () => {
  it('canonicalises nodes by id, edges without labels by [from,to,kind], keys sorted', () => {
    expect(legacyCanonicalJson(legacyGraph)).toBe(LEGACY_CANONICAL_JSON);
  });

  it('is the hash a graph was recorded under while teams were graphs', () => {
    expect(legacyGraphVersionOf(legacyGraph)).toBe(LEGACY_VERSION);
  });

  it('does not move with the layout, an edge label or the node and edge order', () => {
    const shuffled: LegacyTeamGraph = {
      ...legacyGraph,
      layout: undefined,
      nodes: [...legacyGraph.nodes].reverse(),
      edges: [...legacyGraph.edges]
        .reverse()
        .map((edge) => ({ ...edge, label: 'x' })),
    };

    expect(legacyGraphVersionOf(shuffled)).toBe(LEGACY_VERSION);
  });

  it('differs from the version of the team the graph converts to', () => {
    const converted = teamOfCanonical(LEGACY_CANONICAL_JSON)!;

    expect(teamVersionOf(converted)).not.toBe(LEGACY_VERSION);
  });
});

describe('isLegacyCanonical', () => {
  it('is true for a node-graph row and false for a team row or junk', () => {
    expect(isLegacyCanonical(LEGACY_CANONICAL_JSON)).toBe(true);
    expect(isLegacyCanonical(canonicalGraphJson(canonicalGraphOf(base)))).toBe(
      false,
    );
    expect(isLegacyCanonical('not json')).toBe(false);
  });
});

describe('teamOfCanonical', () => {
  it('reads a stored team back with the same version', () => {
    const back = teamOfCanonical(canonicalGraphJson(canonicalGraphOf(base)));
    expect(back).not.toBeNull();
    expect(teamVersionOf(back!)).toBe(teamVersionOf(base));
  });

  it('round-trips the stages in their authored order', () => {
    const staged = { ...base, stages: [...stages].reverse() };
    const back = teamOfCanonical(canonicalGraphJson(canonicalGraphOf(staged)));

    expect(back!.stages).toEqual(staged.stages);
    expect(teamVersionOf(back!)).toBe(teamVersionOf(staged));
  });

  it('keeps the cap, and omits it when the row recorded none', () => {
    const capped = teamOfCanonical(canonicalGraphJson(canonicalGraphOf(base)));
    const uncapped = teamOfCanonical(
      canonicalGraphJson(
        canonicalGraphOf({ ...base, maxActiveTurns: undefined }),
      ),
    );

    expect(capped!.maxActiveTurns).toBe(3);
    expect(uncapped!.maxActiveTurns).toBeUndefined();
  });

  it('reads a row recorded while teams were node graphs as a converted team', () => {
    const team = teamOfCanonical(LEGACY_CANONICAL_JSON)!;

    expect(team.mode).toBe('lead');
    expect(team.maxActiveTurns).toBe(2);
    expect(team.members).toEqual([
      member('dev', { agent: 'codex', approval: 'ask' }),
      member('lead', {
        name: 'Lead',
        role: 'Plans the work',
        instructions: 'Plan carefully',
      }),
    ]);
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'lead' }]);
    expect(team.stages).toEqual([
      { id: 'build', title: 'Build', goal: 'It compiles' },
    ]);
  });

  it('answers null for a row the schema no longer reads', () => {
    expect(teamOfCanonical('not json')).toBeNull();
    expect(teamOfCanonical('42')).toBeNull();
    expect(teamOfCanonical('{"nodes":[{"id":"x"}],"edges":[]}')).toBeNull();
    expect(teamOfCanonical('{"members":"no"}')).toBeNull();
  });
});

describe('canonicalGraphYaml', () => {
  it('prints the cap, mode, members, triggers and blocks in the file’s field order, without the name or description', () => {
    const yaml = canonicalGraphYaml(
      canonicalGraphJson(canonicalGraphOf(base)),
    )!;

    expect(yaml.startsWith('maxActiveTurns: 3\nmode: lead\nmembers:\n')).toBe(
      true,
    );
    expect(yaml).toContain('  - id: lead\n    name: Lead\n');
    expect(yaml.indexOf('triggers:\n')).toBeGreaterThan(
      yaml.indexOf('members:\n'),
    );
    expect(yaml.indexOf('instructionBlocks:\n')).toBeGreaterThan(
      yaml.indexOf('triggers:\n'),
    );
    expect(yaml).not.toContain('Dev Team');
    expect(yaml).not.toContain('Builds things');
  });

  it('prints the stages after the blocks, and nothing for a stage-less team', () => {
    const yaml = canonicalGraphYaml(
      canonicalGraphJson(canonicalGraphOf({ ...base, stages })),
    )!;

    expect(yaml.indexOf('stages:\n')).toBeGreaterThan(
      yaml.indexOf('instructionBlocks:\n'),
    );
    expect(yaml).toContain('  - id: build\n    title: Build\n');
    expect(
      canonicalGraphYaml(canonicalGraphJson(canonicalGraphOf(base))),
    ).not.toContain('stages');
  });

  it('prints a node-graph row as the team it converts to', () => {
    const yaml = canonicalGraphYaml(LEGACY_CANONICAL_JSON)!;

    expect(yaml).toContain('mode: lead\n');
    expect(yaml).toContain('    instructions: Plan carefully\n');
    expect(yaml).toContain('  - kind: first-message\n    member: lead\n');
    expect(yaml).not.toContain('nodes:');
  });

  it('answers null for a row the schema no longer reads', () => {
    expect(canonicalGraphYaml('{"members":"no"}')).toBeNull();
  });
});
