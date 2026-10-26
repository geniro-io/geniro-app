import { describe, expect, it } from 'vitest';

import type { Workflow, WorkflowAgentNode } from '../graphs.types';
import { ANSWERING_WITH_CALLS_OUT } from './callee-text';
import {
  calleesByNode,
  callSurfaceText,
  instructionBlocksByNode,
  joinInstructionBlocks,
} from './node-instructions';

const agent = (id: string, extra: Partial<WorkflowAgentNode> = {}) =>
  ({
    id,
    kind: 'agent',
    agent: 'claude',
    approval: 'auto',
    ...extra,
  }) as WorkflowAgentNode;

const WORKFLOW: Pick<Workflow, 'nodes' | 'edges'> = {
  nodes: [
    { id: 'standard', kind: 'instruction', instructions: '  STANDARD\n' },
    agent('manager'),
    { id: 'blank', kind: 'instruction', instructions: '   ' },
    { id: 'team', kind: 'instruction', instructions: 'TEAM' },
    agent('dev', { name: 'Developer', description: 'Writes the code.' }),
  ],
  edges: [
    // Wired team-first, yet the blocks keep their NODE-LIST order.
    { from: 'team', to: 'manager', kind: 'instruction' },
    { from: 'standard', to: 'manager', kind: 'instruction' },
    { from: 'blank', to: 'manager', kind: 'instruction' },
    { from: 'team', to: 'dev', kind: 'instruction' },
    { from: 'manager', to: 'dev', kind: 'call' },
    { from: 'manager', to: 'standard', kind: 'call' },
  ],
};

describe('instructionBlocksByNode', () => {
  it('lists each wired block in node-list order, trimmed, blank ones dropped', () => {
    const blocks = instructionBlocksByNode(WORKFLOW);

    expect(blocks.get('manager')).toEqual([
      { nodeId: 'standard', text: 'STANDARD' },
      { nodeId: 'team', text: 'TEAM' },
    ]);
    expect(blocks.get('dev')).toEqual([{ nodeId: 'team', text: 'TEAM' }]);
  });

  it('joins a node’s blocks as paragraphs, and to null when it has none', () => {
    const blocks = instructionBlocksByNode(WORKFLOW);

    expect(joinInstructionBlocks(blocks.get('manager'))).toBe(
      'STANDARD\n\nTEAM',
    );
    expect(joinInstructionBlocks(blocks.get('nobody'))).toBeNull();
  });
});

describe('calleesByNode', () => {
  it('maps a caller to the AGENT nodes its call edges reach', () => {
    const callees = calleesByNode(WORKFLOW);

    expect(callees.get('manager')?.map((node) => node.id)).toEqual(['dev']);
    expect(callees.has('dev')).toBe(false);
  });
});

describe('callSurfaceText', () => {
  const dev = agent('dev', {
    name: 'Developer',
    description: 'Writes the code.',
  });

  it('names each callee by its description and the caller’s own question tool', () => {
    const text = callSurfaceText([dev], 'AskUserQuestion', false);

    expect(text).toContain('- Developer (agent id: dev) — Writes the code.');
    expect(text).toContain('ask the user with your AskUserQuestion tool');
    expect(text).not.toContain(ANSWERING_WITH_CALLS_OUT);
  });

  it('says the caller cannot escalate when its CLI has no question tool', () => {
    expect(callSurfaceText([dev], null, false)).toContain(
      'you cannot escalate to the user',
    );
  });

  it('adds the calls-out rule only on a turn that answers a call', () => {
    expect(
      callSurfaceText([dev], null, true).endsWith(
        `\n${ANSWERING_WITH_CALLS_OUT}`,
      ),
    ).toBe(true);
  });
});
