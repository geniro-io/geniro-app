import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import { fromLegacyProposal } from './legacy-proposal';

describe('fromLegacyProposal', () => {
  it('moves a proposal raised before the rename onto today’s keys', () => {
    expect(
      fromLegacyProposal({
        mode: 'replace',
        workflow: { name: 'Dev Team' },
        diff: { workflowFields: ['name'], addedMembers: [] },
      }),
    ).toEqual({
      mode: 'replace',
      team: { name: 'Dev Team' },
      diff: {
        teamFields: ['name'],
        addedMembers: [],
        addedBlocks: [],
        removedBlocks: [],
        changedBlocks: [],
      },
    });
  });

  it('leaves a proposal raised today as it is', () => {
    const proposal = {
      mode: 'replace',
      team: teamOf([member('lead')]),
      diff: {
        identical: false,
        teamFields: ['name'],
        addedMembers: [],
        removedMembers: [],
        changedMembers: [],
        addedBlocks: [],
        removedBlocks: [],
        changedBlocks: [],
        addedStages: [],
        removedStages: [],
        changedStages: [],
      },
    };

    expect(fromLegacyProposal(proposal)).toEqual(proposal);
  });

  it('converts a graph-shaped team and moves its diff’s node lists onto member lists', () => {
    const converted = fromLegacyProposal({
      mode: 'replace',
      team: {
        name: 'Dev Team',
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual' },
          {
            id: 'coder',
            kind: 'agent',
            agent: 'claude',
            description: 'writes',
          },
        ],
        edges: [{ id: 'e1', kind: 'data', from: 'start', to: 'coder' }],
      },
      diff: {
        workflowFields: [],
        addedNodes: [{ id: 'coder', kind: 'agent' }],
        removedNodes: [{ id: 'old', kind: 'agent' }],
        changedNodes: [{ id: 'qa' }],
        addedEdges: [{ id: 'e1' }],
        removedEdges: [{ id: 'e0' }],
      },
    }) as { team: unknown; diff: Record<string, unknown> };

    expect(converted.team).toMatchObject({
      name: 'Dev Team',
      mode: 'lead',
      members: [{ id: 'coder', name: 'coder', role: 'writes' }],
      triggers: [{ kind: 'first-message', member: 'coder' }],
    });
    expect(converted.team).not.toHaveProperty('nodes');
    expect(converted.diff).toEqual({
      teamFields: [],
      addedMembers: [{ id: 'coder', kind: 'agent' }],
      removedMembers: [{ id: 'old', kind: 'agent' }],
      changedMembers: [{ id: 'qa' }],
      addedBlocks: [],
      removedBlocks: [],
      changedBlocks: [],
    });
  });
});
