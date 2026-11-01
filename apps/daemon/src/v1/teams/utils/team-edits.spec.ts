import { describe, expect, it } from 'vitest';

import { applyTeamEdits } from './team-edits';

const WF = {
  name: 'Dev Team',
  settings: { instructions: 'Use worktrees.\nStorage: PRIVATE emulator.' },
  nodes: [
    { id: 'builder', kind: 'agent', agent: 'claude', role: 'Build it.' },
    { id: 'reviewer', kind: 'agent', agent: 'claude', role: 'Review it.' },
  ],
  edges: [{ from: 'builder', to: 'reviewer', kind: 'data' }],
};

function applied(edits: Parameters<typeof applyTeamEdits>[1]) {
  const result = applyTeamEdits(WF, edits, 'view="team"');
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.team as typeof WF & Record<string, unknown>;
}

function refusal(edits: Parameters<typeof applyTeamEdits>[1]): string {
  const result = applyTeamEdits(WF, edits, 'view="team"');
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return result.message;
}

describe('applyTeamEdits', () => {
  it('replaces text found exactly once, inside a multi-line string, and leaves the input alone', () => {
    const out = applied([
      { find: 'Storage: PRIVATE emulator.', replace: 'Storage: shared.' },
    ]);

    expect(out.settings.instructions).toBe('Use worktrees.\nStorage: shared.');
    expect(WF.settings.instructions).toContain('PRIVATE');
  });

  it('takes the replacement literally, `$&` included', () => {
    expect(
      applied([{ find: 'Build it.', replace: 'Pay $& now' }]).nodes[0]!.role,
    ).toBe('Pay $& now');
  });

  it('refuses text that matches nowhere, or in more than one place, naming the places', () => {
    expect(refusal([{ find: 'absent', replace: 'x' }])).toMatch(
      /^edit 1: `find` matches no text/,
    );
    expect(refusal([{ find: ' it.', replace: 'x' }])).toBe(
      'edit 1: `find` matches 2 places (nodes/0/role, nodes/1/role) — include more of the surrounding text so it matches exactly one',
    );
  });

  it('sets a field on a node named by id, and appends to a list with -', () => {
    const out = applied([
      { path: 'nodes/reviewer/model', value: 'sonnet' },
      {
        path: '/edges/-',
        value: { from: 'reviewer', to: 'builder', kind: 'control' },
      },
    ]);

    expect(out.nodes[1]).toMatchObject({ id: 'reviewer', model: 'sonnet' });
    expect(out.edges).toHaveLength(2);
  });

  it('removes a field and a list element', () => {
    const out = applied([
      { path: 'nodes/builder/role', remove: true },
      { path: 'edges/0', remove: true },
    ]);

    expect(out.nodes[0]).not.toHaveProperty('role');
    expect(out.edges).toEqual([]);
  });

  it('applies edits in order, each to the result of the one before', () => {
    const out = applied([
      { find: 'Review it.', replace: 'Review it twice.' },
      { find: 'it twice', replace: 'it three times' },
    ]);

    expect(out.nodes[1]!.role).toBe('Review it three times.');
  });

  it('refuses a path that leads nowhere, a set with no value, and the root, applying nothing', () => {
    expect(refusal([{ path: 'nodes/ghost/model', value: 'x' }])).toBe(
      'edit 1: no element "ghost" at nodes/ghost',
    );
    expect(refusal([{ path: 'nodes/builder/model' }])).toMatch(
      /without `value`/,
    );
    expect(refusal([{ path: '/', value: {} }])).toMatch(/names the whole team/);
    expect(refusal([{ path: 'settings/missing', remove: true }])).toBe(
      'edit 1: nothing at settings/missing to remove',
    );
    expect(
      refusal([
        { path: 'name', value: 'Renamed' },
        { find: 'absent', replace: 'x' },
      ]),
    ).toMatch(/^edit 2:/);
  });

  it('never reaches past the team into what every object inherits', () => {
    for (const path of [
      '__proto__/polluted',
      'constructor/prototype/polluted',
      'nodes/__proto__/polluted',
    ]) {
      expect(refusal([{ path, value: 'yes' }])).toMatch(/^edit 1:/);
    }
    expect(refusal([{ path: '__proto__/toString', remove: true }])).toMatch(
      /^edit 1:/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(typeof Object.prototype.toString).toBe('function');
  });
});
