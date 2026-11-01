import { describe, expect, it } from 'vitest';

import type { Team } from '../teams.types';
import { agentsThatRunAuto, nodesThatAsk } from './unattended';

const team = (nodes: Team['nodes']): Team => ({
  name: 'Team',
  nodes,
  edges: [],
});

describe('nodesThatAsk', () => {
  it('is empty when every agent node runs on auto — the team can run unattended', () => {
    expect(
      nodesThatAsk(
        team([
          { id: 'trigger-1', kind: 'trigger', trigger: 'manual' },
          { id: 'manager', kind: 'agent', agent: 'claude', approval: 'auto' },
          {
            id: 'engineer',
            kind: 'agent',
            agent: 'cursor-agent',
            approval: 'auto',
          },
        ] as Team['nodes']),
      ),
    ).toEqual([]);
  });

  it('names every agent node that can stop on an approval, by its display name', () => {
    expect(
      nodesThatAsk(
        team([
          {
            id: 'manager',
            name: 'Manager',
            kind: 'agent',
            agent: 'claude',
            approval: 'ask',
          },
          { id: 'qa', kind: 'agent', agent: 'claude', approval: 'acceptEdits' },
          { id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' },
        ] as Team['nodes']),
      ),
    ).toEqual(['Manager', 'qa']);
  });

  it('names a node on auto whose pool holds a member that asks', () => {
    expect(
      nodesThatAsk(
        team([
          {
            id: 'engineer',
            kind: 'agent',
            agent: 'claude',
            approval: 'auto',
            pool: [{ agent: 'codex' }, { agent: 'codex', approval: 'ask' }],
          },
          {
            id: 'qa',
            kind: 'agent',
            agent: 'claude',
            approval: 'auto',
            pool: [{ agent: 'codex' }],
          },
        ] as Team['nodes']),
      ),
    ).toEqual(['engineer']);
  });
});

describe('agentsThatRunAuto', () => {
  it('names each auto agent by its unique id, and a pool member by its number', () => {
    const team: Team = {
      name: 'team',
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          agent: 'claude',
          approval: 'ask',
          name: 'Reviewer',
          pool: [{ agent: 'codex', approval: 'auto' }, { agent: 'claude' }],
        },
        {
          id: 'b',
          kind: 'agent',
          agent: 'claude',
          approval: 'auto',
          name: 'Reviewer',
        },
        { id: 'c', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [],
    };

    expect(agentsThatRunAuto(team)).toEqual([
      'Reviewer (a) — pool member 2',
      'Reviewer (b)',
      'c',
    ]);
  });
});
