import { describe, expect, it } from 'vitest';

import { configDirToken } from '../../../graphs/utils/config-dir-redaction';
import {
  readReadWorkflowsArgs,
  WORKFLOW_RESULT_PREFACE,
  workflowListText,
  workflowText,
} from './read-workflows.reader';

/** The JSON under the preface every answer leads with. */
function bodyOf(text: string): unknown {
  expect(text.startsWith(`${WORKFLOW_RESULT_PREFACE}\n`)).toBe(true);
  return JSON.parse(text.slice(WORKFLOW_RESULT_PREFACE.length + 1));
}

describe('readReadWorkflowsArgs', () => {
  it('reads no argument as a listing and a slug as one workflow', () => {
    expect(readReadWorkflowsArgs({})).toEqual({ ok: true, query: {} });
    expect(readReadWorkflowsArgs({ slug: null })).toEqual({
      ok: true,
      query: {},
    });
    expect(readReadWorkflowsArgs({ slug: 'team' })).toEqual({
      ok: true,
      query: { slug: 'team' },
    });
  });

  it('refuses a misspelt argument rather than listing everything', () => {
    expect(readReadWorkflowsArgs({ slg: 'team' }).ok).toBe(false);
    expect(readReadWorkflowsArgs({ slug: '' }).ok).toBe(false);
  });
});

describe('read_workflows result text', () => {
  it('lists summaries only, never a definition', () => {
    const text = workflowListText([
      {
        slug: 'team',
        name: 'Team',
        description: null,
        nodeCount: 3,
        edgeCount: 2,
        agentCounts: [{ kind: 'claude', count: 2 }],
        updatedAt: '2026-10-20T10:00:00.000Z',
      },
    ]);

    expect(bodyOf(text)).toEqual([
      {
        slug: 'team',
        name: 'Team',
        description: null,
        nodes: 3,
        edges: 2,
        agents: [{ kind: 'claude', count: 2 }],
      },
    ]);
    expect(workflowListText([])).toBe('The workflow library is empty.');
  });

  it("never shows an agent's profile path", () => {
    const workflow = {
      name: 'Team',
      nodes: [
        {
          id: 'a',
          kind: 'agent' as const,
          agent: 'claude' as const,
          approval: 'ask' as const,
          configDir: '/Users/me/.claude-work',
        },
      ],
      edges: [],
    };

    const text = workflowText({ slug: 'team', hash: 'h1', workflow });
    expect(text).not.toContain('/Users/me');
    expect(text).toContain(
      `"configDir": "${configDirToken('/Users/me/.claude-work')}"`,
    );
  });

  it('answers one workflow with the hash it was read at', () => {
    const workflow = { name: 'Team', nodes: [], edges: [] };
    expect(
      bodyOf(workflowText({ slug: 'team', hash: 'h1', workflow })),
    ).toEqual({ slug: 'team', hash: 'h1', workflow });
  });
});
