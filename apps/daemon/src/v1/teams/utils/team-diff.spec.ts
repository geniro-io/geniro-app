import { describe, expect, it } from 'vitest';

import type { Team, TeamStage } from '../teams.types';
import { diffTeams } from './team-diff';

function stage(id: string, extra: Partial<TeamStage> = {}): TeamStage {
  return { id, title: id, doneWhen: `${id} is done`, ...extra };
}

function team(stages?: TeamStage[]): Team {
  return {
    name: 'Team',
    nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
    edges: [],
    ...(stages === undefined ? {} : { stages }),
  } as Team;
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
      stage('build', { doneWhen: 'tests pass', next: ['review'] }),
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
            field: 'doneWhen',
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

describe('diffTeams — long text', () => {
  const withRole = (role: string): Team =>
    ({
      name: 'Team',
      nodes: [{ id: 'coder', kind: 'agent', agent: 'claude', role }],
      edges: [],
    }) as unknown as Team;

  it('quotes a long role from where the two versions differ, not their shared opening', () => {
    const opening = 'You lead a small team. '.repeat(40);
    const ending = ' Report the result.'.repeat(40);
    const diff = diffTeams(
      withRole(`${opening}Never push to main.${ending}`),
      withRole(`${opening}Always open a draft PR first.${ending}`),
    );

    const [field] = diff.changedNodes[0]!.fields;
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

    const [field] = diff.changedNodes[0]!.fields;
    expect(JSON.parse(field!.after)).toBe(`${'b'.repeat(400)}…`);
  });

  it('quotes a short change whole', () => {
    const diff = diffTeams(withRole('Write tests.'), withRole('Ship it.'));

    expect(diff.changedNodes[0]!.fields[0]).toEqual({
      field: 'role',
      before: '"Write tests."',
      after: '"Ship it."',
    });
  });
});
