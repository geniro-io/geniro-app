import { describe, expect, it } from 'vitest';

import { filedRecommendationsOf } from './recommendation-ledger';

const projectItem = {
  id: 'P-1',
  target: 'project',
  territory: 'domain',
  kind: 'update',
  location: 'p-billing',
  title: 'Name the test command',
  change: 'Run `pnpm test:unit` before finishing.',
  evidence: [{ seq: 4, quote: 'which test command?' }],
  rootCause: 'the project never says how to test',
  impact: {
    minutesSaved: 3,
    costSavedUsd: null,
    basis: 'two runs asked',
    confidence: 3,
    outcome: 'questions 2 → 0',
  },
  risk: { level: 'low', note: 'none' },
};

describe('filedRecommendationsOf', () => {
  it('files a project-instructions item from a team analysis card', () => {
    const filed = filedRecommendationsOf(
      { chatRunId: 'analysis', slug: 'dev-team', chatKind: 'analysis' },
      {
        seq: 12,
        createdAt: new Date(0),
        payload: {
          sourceRunId: 'r1',
          sourceKind: 'team',
          timing: null,
          items: [projectItem],
        },
      },
      null,
    );

    expect(filed).toEqual([
      expect.objectContaining({
        itemId: 'P-1',
        target: 'project',
        location: 'p-billing',
        cardSeq: 12,
      }),
    ]);
  });
});
