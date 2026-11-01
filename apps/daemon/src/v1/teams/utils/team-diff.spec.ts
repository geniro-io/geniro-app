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
  it('names each added, removed and changed stage by id instead of the whole field', () => {
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
    expect(diff.removedStages).toEqual(['old']);
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

  it('reports a reorder of kept stages as the stages field, since no stage changed', () => {
    const diff = diffTeams(
      team([stage('a'), stage('b')]),
      team([stage('b'), stage('a')]),
    );

    expect(diff.teamFields).toEqual(['stages']);
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

  it('names each added, removed and changed member by id', () => {
    const before = teamOf([
      member('lead'),
      member('dev', { model: 'a' }),
      member('old'),
    ]);
    const after = teamOf([
      member('lead'),
      member('dev', { model: 'b', effort: 'high' }),
      member('qa'),
    ]);

    const diff = diffTeams(before, after);

    expect(diff.addedMembers).toEqual(['qa']);
    expect(diff.removedMembers).toEqual(['old']);
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

  it('names each added, removed and changed instruction block by id', () => {
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
    expect(diff.removedBlocks).toEqual(['gone']);
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

    expect(diff.teamFields).toEqual(['members', 'instructionBlocks']);
    expect(diff.changedMembers).toEqual([]);
    expect(diff.changedBlocks).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('names a changed scalar team field', () => {
    const members = [member('lead')];
    const diff = diffTeams(
      teamOf(members, { maxActiveTurns: 2 }),
      teamOf(members, { maxActiveTurns: 3, mode: 'relay' }),
    );

    expect(diff.teamFields.sort()).toEqual(['maxActiveTurns', 'mode']);
  });

  it('names a moved trigger as the triggers field', () => {
    const members = [member('lead'), member('dev')];
    const diff = diffTeams(
      teamOf(members),
      teamOf(members, {
        triggers: [{ kind: 'first-message', member: 'dev' }],
      }),
    );

    expect(diff.teamFields).toEqual(['triggers']);
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
