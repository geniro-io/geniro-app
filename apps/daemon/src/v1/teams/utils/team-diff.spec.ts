import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { Team, TeamStage } from '../teams.types';
import { diffTeams } from './team-diff';

function stage(id: string, extra: Partial<TeamStage> = {}): TeamStage {
  return { id, title: id, goal: `${id} is done`, ...extra };
}

function team(stages?: TeamStage[]): Team {
  return teamOf([member('lead')], {
    ...(stages === undefined ? {} : { stages }),
  });
}

describe('diffTeams — stages', () => {
  it('names each added and changed stage by id, and quotes what a removed stage held', () => {
    const before = team([
      stage('plan', { next: ['build'] }),
      stage('build'),
      stage('old'),
    ]);
    const after = team([
      stage('plan', { next: ['build'] }),
      stage('build', { goal: 'tests pass', next: ['review'] }),
      stage('review'),
    ]);

    const diff = diffTeams(before, after);

    expect(diff.identical).toBe(false);
    expect(diff.teamFields).toEqual([]);
    expect(diff.addedStages).toEqual(['review']);
    expect(diff.removedStages).toEqual([
      {
        id: 'old',
        fields: [
          { field: 'title', before: '"old"', after: '(unset)' },
          { field: 'goal', before: '"old is done"', after: '(unset)' },
        ],
      },
    ]);
    expect(diff.changedStages).toEqual([
      {
        id: 'build',
        fields: [
          {
            field: 'goal',
            before: '"build is done"',
            after: '"tests pass"',
          },
          { field: 'next', before: '(unset)', after: '["review"]' },
        ],
      },
    ]);
  });

  it('reports a first stage list on a team that had none as added stages', () => {
    const diff = diffTeams(
      team(),
      team([stage('plan', { next: ['build'] }), stage('build')]),
    );

    expect(diff.addedStages).toEqual(['plan', 'build']);
    expect(diff.identical).toBe(false);
  });

  it('reports a reorder of kept stages as the stages field with each side’s order, since no stage changed', () => {
    const diff = diffTeams(
      team([stage('a'), stage('b')]),
      team([stage('b'), stage('a')]),
    );

    expect(diff.teamFields).toEqual([
      { field: 'stages', before: '["a","b"]', after: '["b","a"]' },
    ]);
    expect(diff.changedStages).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('is identical when the stages are the same', () => {
    const stages = [stage('a', { next: ['b'] }), stage('b')];

    expect(diffTeams(team(stages), team([...stages])).identical).toBe(true);
  });
});

describe('diffTeams — members, blocks and team fields', () => {
  const block = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    text: `${id} text`,
    audience: 'everyone' as const,
    ...extra,
  });

  it('names each added and changed member by id, and quotes what a removed member held', () => {
    const before = teamOf([
      member('lead'),
      member('dev', { model: 'a' }),
      member('old', { role: 'Retired reviewer' }),
    ]);
    const after = teamOf([
      member('lead'),
      member('dev', { model: 'b', effort: 'high' }),
      member('qa'),
    ]);

    const diff = diffTeams(before, after);

    expect(diff.addedMembers).toEqual(['qa']);
    expect(diff.removedMembers).toHaveLength(1);
    expect(diff.removedMembers[0]!.id).toBe('old');
    expect(diff.removedMembers[0]!.fields).toContainEqual({
      field: 'role',
      before: '"Retired reviewer"',
      after: '(unset)',
    });
    expect(
      diff.removedMembers[0]!.fields.every(
        ({ field, after: value }) => field !== 'id' && value === '(unset)',
      ),
    ).toBe(true);
    expect(diff.changedMembers).toEqual([
      {
        id: 'dev',
        fields: [
          { field: 'model', before: '"a"', after: '"b"' },
          { field: 'effort', before: '(unset)', after: '"high"' },
        ],
      },
    ]);
    expect(diff.teamFields).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('names each added and changed instruction block by id, and quotes what a removed block said', () => {
    const base = [member('lead'), member('dev')];
    const diff = diffTeams(
      teamOf(base, {
        instructionBlocks: [block('style'), block('gone'), block('scope')],
      }),
      teamOf(base, {
        instructionBlocks: [
          block('style', { audience: ['dev'] }),
          block('scope'),
          block('fresh'),
        ],
      }),
    );

    expect(diff.addedBlocks).toEqual(['fresh']);
    expect(diff.removedBlocks).toEqual([
      {
        id: 'gone',
        fields: [
          { field: 'title', before: '"gone"', after: '(unset)' },
          { field: 'text', before: '"gone text"', after: '(unset)' },
          { field: 'audience', before: '"everyone"', after: '(unset)' },
        ],
      },
    ]);
    expect(diff.changedBlocks).toEqual([
      {
        id: 'style',
        fields: [{ field: 'audience', before: '"everyone"', after: '["dev"]' }],
      },
    ]);
  });

  it('lists a reorder of kept members or blocks in the team fields, not as a change', () => {
    const blocks = [block('a'), block('b')];
    const diff = diffTeams(
      teamOf([member('lead'), member('dev')], { instructionBlocks: blocks }),
      teamOf([member('dev'), member('lead')], {
        triggers: [{ kind: 'first-message', member: 'lead' }],
        instructionBlocks: [...blocks].reverse(),
      }),
    );

    expect(diff.teamFields).toEqual([
      { field: 'members', before: '["lead","dev"]', after: '["dev","lead"]' },
      {
        field: 'instructionBlocks',
        before: '["a","b"]',
        after: '["b","a"]',
      },
    ]);
    expect(diff.changedMembers).toEqual([]);
    expect(diff.changedBlocks).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('quotes a changed scalar team field’s old and new value', () => {
    const members = [member('lead')];
    const diff = diffTeams(
      teamOf(members, { maxActiveTurns: 2 }),
      teamOf(members, { maxActiveTurns: 3, mode: 'relay' }),
    );

    expect(diff.teamFields).toEqual([
      { field: 'mode', before: '"lead"', after: '"relay"' },
      { field: 'maxActiveTurns', before: '2', after: '3' },
    ]);
  });

  it('quotes a team field one side does not set as unset', () => {
    const members = [member('lead')];
    const diff = diffTeams(
      teamOf(members),
      teamOf(members, { description: 'Ships reviewed changes.' }),
    );

    expect(diff.teamFields).toEqual([
      {
        field: 'description',
        before: '(unset)',
        after: '"Ships reviewed changes."',
      },
    ]);
  });

  it('quotes a moved trigger as the triggers field', () => {
    const members = [member('lead'), member('dev')];
    const diff = diffTeams(
      teamOf(members),
      teamOf(members, {
        triggers: [{ kind: 'first-message', member: 'dev' }],
      }),
    );

    expect(diff.teamFields).toEqual([
      {
        field: 'triggers',
        before: '[{"kind":"first-message","member":"lead"}]',
        after: '[{"kind":"first-message","member":"dev"}]',
      },
    ]);
  });

  it('is identical for equal teams', () => {
    expect(
      diffTeams(teamOf([member('lead')]), teamOf([member('lead')])).identical,
    ).toBe(true);
  });
});

describe('diffTeams — long text', () => {
  const withRole = (instructions: string): Team =>
    teamOf([member('coder', { instructions })]);

  it('quotes long instructions from where the two versions differ, not their shared opening', () => {
    const opening = 'You lead a small team. '.repeat(40);
    const ending = ' Report the result.'.repeat(40);
    const diff = diffTeams(
      withRole(`${opening}Never push to main.${ending}`),
      withRole(`${opening}Always open a draft PR first.${ending}`),
    );

    const [field] = diff.changedMembers[0]!.fields;
    const before = JSON.parse(field!.before) as string;
    const after = JSON.parse(field!.after) as string;
    expect(before).toContain('Never push to main.');
    expect(after).toContain('Always open a draft PR first.');
    expect(before.startsWith('…')).toBe(true);
    expect(before.endsWith('…')).toBe(true);
    expect(before.length).toBeLessThan(260);
    expect(after.length).toBeLessThan(260);
  });

  it('cuts a rewritten stretch longer than the quote at its start', () => {
    const diff = diffTeams(
      withRole('a'.repeat(1000)),
      withRole('b'.repeat(1000)),
    );

    const [field] = diff.changedMembers[0]!.fields;
    expect(JSON.parse(field!.after)).toBe(`${'b'.repeat(400)}…`);
  });

  it('quotes a short change whole', () => {
    const diff = diffTeams(withRole('Write tests.'), withRole('Ship it.'));

    expect(diff.changedMembers[0]!.fields[0]).toEqual({
      field: 'instructions',
      before: '"Write tests."',
      after: '"Ship it."',
    });
  });
});
