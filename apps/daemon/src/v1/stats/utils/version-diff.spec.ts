import { describe, expect, it } from 'vitest';

import type { Team } from '../../teams/teams.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  canonicalGraphYaml,
} from '../../teams/utils/team-version';
import { versionDiff } from './version-diff';

const base: Team = {
  name: 'Dev Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [{ from: 'start', to: 'dev', kind: 'data' }],
};

function yamlOf(team: Team): string {
  return canonicalGraphYaml(canonicalGraphJson(canonicalGraphOf(team)))!;
}

describe('versionDiff', () => {
  it('prints a unified diff with file headers and counts the lines it adds and removes', () => {
    const next: Team = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === 'dev' ? { ...node, approval: 'ask' } : node,
      ),
    };

    const changes = versionDiff('dev-team', yamlOf(base), yamlOf(next));

    expect(changes.added).toBe(1);
    expect(changes.removed).toBe(1);
    const lines = changes.diff.split('\n');
    expect(lines.slice(0, 2)).toEqual([
      '--- a/dev-team.team.yaml',
      '+++ b/dev-team.team.yaml',
    ]);
    expect(lines[2]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(lines).toContain('-    approval: auto');
    expect(lines).toContain('+    approval: ask');
  });

  it('answers an empty diff for two graphs that print alike', () => {
    expect(versionDiff('dev-team', yamlOf(base), yamlOf(base))).toEqual({
      added: 0,
      removed: 0,
      diff: '',
    });
  });
});
