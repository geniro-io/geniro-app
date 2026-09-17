import { describe, expect, it } from 'vitest';

import type { Workflow } from '../graphs.types';
import { nodesThatAsk } from './unattended';

const workflow = (nodes: Workflow['nodes']): Workflow => ({
  name: 'Team',
  nodes,
  edges: [],
});

describe('nodesThatAsk', () => {
  it('is empty when every agent node runs on auto — the workflow can run unattended', () => {
    expect(
      nodesThatAsk(
        workflow([
          { id: 'trigger-1', kind: 'trigger', trigger: 'manual' },
          { id: 'manager', kind: 'agent', agent: 'claude', approval: 'auto' },
          {
            id: 'engineer',
            kind: 'agent',
            agent: 'cursor-agent',
            approval: 'auto',
          },
        ] as Workflow['nodes']),
      ),
    ).toEqual([]);
  });

  it('names every agent node that can stop on an approval, by its display name', () => {
    expect(
      nodesThatAsk(
        workflow([
          {
            id: 'manager',
            name: 'Manager',
            kind: 'agent',
            agent: 'claude',
            approval: 'ask',
          },
          { id: 'qa', kind: 'agent', agent: 'claude', approval: 'acceptEdits' },
          { id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' },
        ] as Workflow['nodes']),
      ),
    ).toEqual(['Manager', 'qa']);
  });
});
