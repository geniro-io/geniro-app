import { describe, expect, it } from 'vitest';

import type { Workflow } from '../../graphs/graphs.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  canonicalGraphYaml,
} from '../../graphs/utils/workflow-version';
import { versionDiff } from './version-diff';

const base: Workflow = {
  name: 'Dev Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [{ from: 'start', to: 'dev', kind: 'data' }],
};

function yamlOf(workflow: Workflow): string {
  return canonicalGraphYaml(canonicalGraphJson(canonicalGraphOf(workflow)))!;
}

describe('versionDiff', () => {
  it('prints a unified diff with file headers and counts the lines it adds and removes', () => {
    const next: Workflow = {
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
      '--- a/dev-team.geniro.yaml',
      '+++ b/dev-team.geniro.yaml',
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
