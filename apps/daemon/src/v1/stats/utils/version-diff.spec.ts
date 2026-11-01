import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { Team } from '../../teams/teams.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  canonicalGraphYaml,
} from '../../teams/utils/team-version';
import { versionDiff } from './version-diff';

const base: Team = teamOf([member('dev')], { name: 'Dev Team' });

function yamlOf(team: Team): string {
  return canonicalGraphYaml(canonicalGraphJson(canonicalGraphOf(team)))!;
}

describe('versionDiff', () => {
  it('prints a unified diff with file headers and counts the lines it adds and removes', () => {
    const next: Team = {
      ...base,
      members: base.members.map((m) =>
        m.id === 'dev' ? { ...m, approval: 'ask' as const } : m,
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
