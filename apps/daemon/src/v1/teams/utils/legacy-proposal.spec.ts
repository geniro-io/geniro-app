import { describe, expect, it } from 'vitest';

import { fromLegacyProposal } from './legacy-proposal';

describe('fromLegacyProposal', () => {
  it('moves a proposal raised before the rename onto today’s keys', () => {
    expect(
      fromLegacyProposal({
        mode: 'replace',
        workflow: { name: 'Dev Team' },
        diff: { workflowFields: ['name'], addedNodes: [] },
      }),
    ).toEqual({
      mode: 'replace',
      team: { name: 'Dev Team' },
      diff: { teamFields: ['name'], addedNodes: [] },
    });
  });

  it('leaves a proposal raised today as it is', () => {
    const proposal = {
      mode: 'replace',
      team: { name: 'Dev Team' },
      diff: { teamFields: ['name'] },
    };

    expect(fromLegacyProposal(proposal)).toEqual(proposal);
  });
});
